/**
 * dashboard/ws-dispatch.js — hub de dispatch des messages WebSocket entrants
 * (handleMessage), le routeur central "action reçue -> module feature qui la
 * rend".
 *
 * Extrait de dashboard/legacy-core.js (chantier de modularisation, dernier
 * lot). C'est la pièce la plus interconnectée du tableau de bord (elle
 * importe depuis quasiment tous les modules feature) mais la plus mécanique
 * à extraire une fois ceux-ci stabilisés : chaque branche du switch se
 * contente d'appeler une fonction déjà exportée ailleurs. IMPORT CIRCULAIRE
 * assumé et sûr avec state.js (voir son commentaire d'en-tête) : `state`
 * n'est utilisé ici qu'à l'intérieur des branches du switch, jamais évalué
 * au chargement du module.
 */
import { showToast, addActivity, escapeHtmlDashboard } from './utils.js';
import { state } from './state.js';
import {
  displayVerse,
  hideVerseDisplay,
  addTranscript,
  showCandidateVerse,
  clearCandidateNotices,
  formatReferenceLabel,
  updateDashboard,
} from './features/verse-session-display.js';
import { renderMoodPicker, setActiveMoodButton } from './features/mood-theme.js';
import { renderSongLibrary } from './features/song-library.js';
import { renderOfflineBibleStatus } from './features/offline-bible.js';
import {
  renderAiEnricherOutput,
  renderSessionStats,
  renderHighlightsExport,
  updateSermonModeBadge,
  renderSermonQaResult,
  requestAutoTranslation,
  renderPreServiceCheckResult,
  renderAiStats,
  renderClipExportStarted,
  renderClipExportProgress,
  renderClipExportComplete,
} from './features/preservice-ai.js';
import { renderMediaLibrary, renderMediaWall } from './features/media-library.js';
import { renderSceneStudioGallery } from './features/scene-studio.js';
import { renderRundown, applyRundownActiveCue } from './features/rundown.js';
import { renderNetworkStatus } from './features/network-settings.js';
import { renderIpCameras, showCameraPairingQr } from './features/ip-cameras.js';
import { renderBranding } from './features/branding.js';
import { setTranscriptionHealth } from './features/pipeline-health.js';
import {
  renderBibleTopics,
  renderBibleSearchResults,
  renderBibleSearchError,
} from './features/bible-search.js';
import {
  setReadingModeActive,
  setReadingPosition,
  clearReadingPosition,
} from './features/reading-mode.js';
import {
  renderTranslationPicker,
  updateActiveTranslationButton,
  renderSecondaryTranslationOptions,
  updateSecondaryTranslationSelect,
} from './features/translation-picker.js';
import { applyDashboardBranding } from './features/dashboard-branding.js';
import { updateAudioVumeter } from './features/audio-vumeter.js';
import { renderAgentEvent } from './features/agent.js';

export function handleMessage(message) {
  switch (message.action) {
    case 'agentEvent':
      renderAgentEvent(message);
      break;
    // AJOUT (sélecteur de version biblique / identité de marque du tableau
    // de bord) : 'init', le tout premier message envoyé par le serveur à
    // chaque connexion (voir server.js), n'avait jusqu'ici AUCUN case ici —
    // porte pourtant translations, plugins, history, theme, branding,
    // dashboardBranding, defaultMedia... Ce correctif consomme translations
    // ET dashboardBranding (portée volontairement limitée à ce que ces deux
    // lots construisent) ; reconstruire l'état complet du tableau de bord
    // au chargement depuis le reste de ce message reste un chantier
    // séparé, plus large, pas entrepris ici.
    case 'init':
      renderTranslationPicker(message.translations);
      renderSecondaryTranslationOptions(message.translations);
      if (message.secondaryTranslation) {
        updateSecondaryTranslationSelect(
          message.secondaryTranslation.lang,
          message.secondaryTranslation.code
        );
      }
      applyDashboardBranding(message.dashboardBranding);
      break;
    case 'translationChanged':
      updateActiveTranslationButton(message.language, message.code);
      showToast(`Version biblique changée (${message.language}).`, 'success');
      break;
    case 'secondaryTranslationChanged':
      updateSecondaryTranslationSelect(message.lang, message.code);
      break;
    case 'dashboardBrandingUpdate':
      applyDashboardBranding(message.branding);
      break;
    case 'showVerse':
      // AJOUT (Étape 5 — candidateVerse) : un vrai verset arrive — la
      // confirmation attendue est là, on efface tout bandeau candidat
      // (fuzzy + spéculatif) pour ne pas le laisser traîner 8s à côté du
      // verset affiché.
      clearCandidateNotices();
      // AJOUT (frontend — mode lecture "pro") : le serveur diffuse la
      // position courante dans le chapitre à chaque avancement (voir
      // server.js > readingModePosition) — affichée dans la carte mode
      // lecture, sans que le dashboard ait à compter lui-même.
      if (message.readingModePos) setReadingPosition(message.readingModePos);
      displayVerse(message);
      state.totalVerses++;
      updateDashboard();
      addActivity(`Verset affiché : ${message.reference}`, 'success');
      showToast(`Verset : ${message.reference}`, 'success');
      // AJOUT : traduction live automatique si le toggle est activé —
      // chaque nouveau verset déclenche translateText sans action manuelle.
      if (state.autoTranslateEnabled && message.text) {
        requestAutoTranslation(message);
      }
      // Auto-trigger cross-references when a verse is shown
      if (message.reference && state && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            action: 'getCrossReferences',
            reference: message.reference,
            text: message.text || '',
          })
        );
      }
      break;
    case 'hideVerse':
      hideVerseDisplay();
      clearCandidateNotices();
      addActivity('Verset masqué', 'info');
      break;
    case 'transcript':
      addTranscript(message);
      break;
    case 'transcriptRejected':
      // AJOUT (fix — versets affichés sans être prononcés) : jusqu'ici un
      // segment de faible confiance (bruit/écho mal transcrit) était rejeté
      // en silence côté serveur — l'opérateur ne voyait ni le texte
      // halluciné, ni pourquoi rien ne s'affichait. Visible dans le flux
      // d'activité pour comprendre un micro trop bruyant sans deviner.
      // Porté depuis dashboard/legacy-core.js (fusion du 2026-08-10) — voir
      // server.js pour l'émission (action broadcastée quand confidence <
      // seuil configuré, jamais de valeur inventée ici).
      addActivity(
        `Segment ignoré (confiance ${Math.round((message.confidence || 0) * 100)}% < ${Math.round((message.threshold || 0) * 100)}%) : "${message.text.substring(0, 60)}"`,
        'warning'
      );
      break;
    case 'candidateVerse':
      showCandidateVerse(message);
      // CORRECTIF (frontend) : message.reference est un OBJET
      // ({ book, chapter, verseStart }) — l'afficher tel quel dans le flux
      // d'activité produisait "[object Object]".
      addActivity(`Verset candidat : ${formatReferenceLabel(message.reference)}`, 'warning');
      break;
    case 'error':
      addActivity(`Erreur : ${message.error}`, 'error');
      showToast(`Erreur : ${message.error}`, 'error');
      break;
    case 'dedupSuppressed':
      addActivity(`Doublon supprimé : ${message.ref} (${message.reason || 'same-ref'})`, 'info');
      break;
    case 'transcriptionError':
      addActivity(`Transcription indisponible : ${message.error}`, 'error');
      // CORRECTIF (audit — message d'erreur générique inutile) : ce toast
      // affichait toujours "vérifier la connexion internet" quelle que soit
      // la vraie cause (clé API invalide, quota dépassé, clé absente...),
      // alors que le message réel (message.error) était déjà disponible —
      // juste jamais montré ailleurs que dans le flux d'activité, moins
      // visible. Affiche désormais la vraie raison.
      showToast(`Transcription en échec : ${message.error || 'raison inconnue'}`, 'error');
      break;
    case 'audioError':
      addActivity(`Capture audio interrompue : ${message.error}`, 'error');
      showToast(`Micro/audio en échec — vérifier la capture`, 'error');
      break;
    case 'audioSilenceWarning':
      addActivity(message.message, 'warning');
      showToast(`⚠️ ${message.message}`, 'error');
      break;
    // AJOUT (A.1 — gain micro) : diagnostics de niveau audio temps réel
    // pour le vumètre du dashboard.
    case 'audioDiagnostics':
      updateAudioVumeter(message);
      updateListeningBar(message);
      break;
    case 'preServiceCheckResult':
      renderPreServiceCheckResult(message);
      break;
    case 'networkStatus':
      renderNetworkStatus(message);
      break;
    // AJOUT (audit round 6) : réponses des modules ai-enricher.js,
    // jusqu'ici sans destination côté dashboard (les WS envoyaient bien
    // ces actions, mais rien n'écoutait la réponse).
    case 'sermonTheme': {
      updateSermonModeBadge(message);
      // Update themes card in PRÉPARATION
      const themesEl = document.getElementById('themesList');
      if (themesEl && message.theme) {
        themesEl.innerHTML =
          '<div class="stat-row"><span class="stat-label">Thème</span><span class="stat-value">' +
          escapeHtmlDashboard(message.theme) +
          '</span></div>' +
          (message.keywords
            ? '<div class="stat-row"><span class="stat-label">Mots-clés</span><span class="stat-value" style="font-size:0.8rem">' +
              escapeHtmlDashboard(message.keywords.join(', ')) +
              '</span></div>'
            : '');
      }
      if (!message.silent) {
        renderAiEnricherOutput(
          message.theme
            ? `Thème détecté : ${message.theme}${message.keywords ? ' — mots-clés : ' + message.keywords.join(', ') : ''}`
            : 'Aucun thème identifiable pour le moment (transcription encore trop courte).'
        );
      }
      break;
    }
    case 'liveSummary':
      renderLiveSummary(message);
      break;
    case 'aiStats':
      renderAiStats(message);
      break;
    case 'crossReferences':
      renderCrossReferences(message);
      break;
    case 'textTranslated':
      // Le broadcast vers l'overlay (action showTranslation) est fait
      // directement par le serveur quand autoBroadcast est vrai (voir
      // requestAutoTranslation) — ici on ne fait qu'afficher côté dashboard.
      if (!message.autoBroadcast) {
        renderAiEnricherOutput(`Traduction (${message.targetLang}) : ${message.translation}`);
      }
      break;
    case 'sessionStats':
      renderSessionStats(message);
      break;
    case 'highlightsExported':
      renderHighlightsExport(message);
      break;
    case 'clipExportStarted':
      renderClipExportStarted();
      break;
    case 'clipExportProgress':
      renderClipExportProgress(message);
      break;
    case 'clipExportComplete':
      renderClipExportComplete(message);
      break;
    case 'postServiceRecap': {
      state.lastPostServiceRecap = message.recap || null;
      // Show the dedicated recap card
      const recapCard = document.getElementById('postServiceRecapCard');
      const recapContent = document.getElementById('postServiceRecapContent');
      if (recapCard) recapCard.style.display = '';
      if (recapContent && message.recap) {
        const r = message.recap;
        recapContent.innerHTML =
          (r.title ? '<strong>' + escapeHtmlDashboard(r.title) + '</strong><br>' : '') +
          (r.keyPoints && r.keyPoints.length
            ? '<br><strong>Points clés :</strong> ' +
              r.keyPoints.map(escapeHtmlDashboard).join(', ')
            : '') +
          (r.application
            ? '<br><strong>Application :</strong> ' + escapeHtmlDashboard(r.application)
            : '') +
          (r.memoryVerse
            ? '<br><strong>Verset à retenir :</strong> ' + escapeHtmlDashboard(r.memoryVerse)
            : '');
        recapContent.style.color = 'var(--text-main)';
      } else if (recapContent) {
        recapContent.textContent = 'Récap indisponible.';
      }
      // Also keep the old output for compatibility
      renderAiEnricherOutput(
        message.recap
          ? `${message.recap.title || 'Récap du culte'} — Points clés : ${(message.recap.keyPoints || []).join(', ')}. ` +
              `Application : ${message.recap.application || '—'}. Verset à retenir : ${message.recap.memoryVerse || '—'}.`
          : 'Récap indisponible.'
      );
      break;
    }
    // AJOUT (innovation frontend — sélecteur d'ambiances) : le serveur
    // envoyait déjà ces deux réponses (server.js: 'moodsList' sur
    // getMoods, 'themeApplied' sur setMoodTheme) mais aucun cas ne les
    // traitait ici — le générateur de thèmes IA restait invisible et
    // inutilisable depuis le tableau de bord.
    case 'moodsList':
      renderMoodPicker(message.moods || []);
      break;
    case 'themeApplied':
      setActiveMoodButton(message.mood);
      addActivity(`Ambiance changée : ${message.themeName || message.mood}`, 'info');
      showToast(`Ambiance : ${message.themeName || message.mood}`, 'success');
      break;
    // AJOUT (transparence détection IA) : diffusé par server.js juste avant
    // le 'showVerse' correspondant quand c'est le détecteur sémantique
    // (LLM), pas la détection littérale, qui a trouvé la référence. Posé
    // ici, consommé par displayVerse() dans verse-session-display.js (voir
    // son commentaire pour la fenêtre de validité de 5s).
    case 'semanticDetected':
      state.pendingSemanticDetection = { ...message, receivedAt: Date.now() };
      break;
    // AJOUT (recherche de versets par thème) : searchBible/getTopics
    // (bible-semantic-search.js) fonctionnaient déjà côté serveur, sans
    // aucune UI côté tableau de bord — voir bible-search.js pour le
    // rappel important sur ce que "par thème" veut dire ici (pas de
    // recherche IA/sémantique réelle aujourd'hui).
    case 'topicsList':
      renderBibleTopics(message.topics || []);
      break;
    case 'searchResults':
      renderBibleSearchResults(message);
      break;
    case 'searchError':
      renderBibleSearchError(message);
      break;
    // AJOUT (mode lecture — bouton manuel) : bascule l'état actif/inactif
    // de l'UI (boutons Suivant/Précédent) — voir reading-mode.js. Le
    // verset lui-même arrive séparément via 'showVerse' (déjà géré
    // ci-dessus), readingMode.onVerseAdvance() le diffuse côté serveur à
    // chaque avancée.
    case 'readingStarted':
      setReadingModeActive(true);
      showToast('Mode lecture démarré.', 'success');
      break;
    case 'readingStopped':
      setReadingModeActive(false);
      clearReadingPosition();
      showToast('Mode lecture arrêté.', 'info');
      break;
    // AJOUT (fiabilité — synchronisation multi-opérateur) : setHighContrast/
    // setCaptions/setTranslatedCaptions/setTestPattern/setBackgroundPattern
    // (préservice-ai.js/mood-theme.js) diffusaient déjà une confirmation
    // côté serveur (broadcast, donc envoyée à TOUS les tableaux de bord
    // connectés), mais rien ici ne l'écoutait — un opérateur cliquant "sous-
    // titres" n'avait aucune confirmation que ça avait bien pris côté
    // serveur, et un DEUXIÈME tableau de bord ouvert restait à l'ancien
    // état sans jamais l'apprendre. Chaque case resynchronise la case à
    // cocher/le bouton correspondant (pas seulement un toast) pour que ça
    // reste vrai même sur un tableau de bord qui n'a pas cliqué lui-même.
    case 'accessibilityMode': {
      const cb = document.getElementById('highContrastToggle');
      if (cb) cb.checked = !!message.highContrast;
      showToast(
        message.highContrast ? 'Mode grand contraste activé.' : 'Mode grand contraste désactivé.',
        'info'
      );
      break;
    }
    case 'captionsMode': {
      const cb = document.getElementById('captionsToggle');
      if (cb) cb.checked = !!message.captions;
      showToast(message.captions ? 'Sous-titres activés.' : 'Sous-titres désactivés.', 'info');
      break;
    }
    case 'translatedCaptionsMode': {
      const cb = document.getElementById('translatedCaptionsToggle');
      if (cb) cb.checked = !!message.enabled;
      const langSelect = document.getElementById('captionTargetLangSelect');
      if (langSelect && message.targetLang) langSelect.value = message.targetLang;
      showToast(
        message.enabled
          ? `Sous-titres traduits activés (${message.targetLang}).`
          : 'Sous-titres traduits désactivés.',
        'info'
      );
      break;
    }
    case 'testPatternMode': {
      const cb = document.getElementById('testPatternToggle');
      if (cb) cb.checked = !!message.enabled;
      showToast(message.enabled ? 'Motif de test activé.' : 'Motif de test désactivé.', 'info');
      break;
    }
    case 'backgroundPatternMode': {
      const labels = {
        none: 'Aucun motif',
        dots: 'Points',
        grid: 'Grille',
        diagonal: 'Diagonales',
      };
      document.querySelectorAll('#patternPicker .mood-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.id === `pattern-btn-${message.pattern}`);
      });
      showToast(`Motif de fond : ${labels[message.pattern] || message.pattern}`, 'success');
      break;
    }
    // AJOUT (audit — état de repli visible, session parallèle) : émises par
    // transcribeWithRetry() côté serveur (server.js) — un échec de
    // transcription tente désormais un nouvel essai automatique avant
    // d'abandonner. Distinct du case 'transcriptionError' déjà présent
    // ci-dessus (qui gère l'échec final) : ceci couvre les tentatives
    // intermédiaires et l'état "dégradé" persistant.
    case 'transcriptionRetrying':
      setTranscriptionHealth({
        status: 'retrying',
        attempt: message.attempt,
        maxAttempts: message.maxAttempts,
      });
      break;
    case 'pipelineHealth':
      setTranscriptionHealth(message);
      if (message.status === 'ok') {
        addActivity('Transcription rétablie', 'success');
      }
      break;
    // AJOUT (audit — mémoire des cultes, session parallèle) : réponse à
    // getArchiveMatches (voir sermon-archive.js — recherche locale par
    // mots-clés, pas d'IA impliquée ici).
    case 'archiveMatches':
      renderAiEnricherOutput(
        message.results && message.results.length
          ? `Cultes correspondants pour "${message.query}" : ` +
              message.results
                .map((r) => {
                  const date = new Date(r.date).toLocaleDateString('fr-FR', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  });
                  return `${r.theme || 'Sans titre'} (${date})`;
                })
                .join(' · ')
          : `Aucun culte archivé ne correspond à "${message.query}".`
      );
      break;
    // AJOUT (médiathèque — déclenchement vocal de photos/vidéos) : la liste
    // vit côté serveur, diffusée à tous les tableaux de bord ouverts après
    // chaque ajout/suppression pour rester synchronisée entre eux.
    case 'mediaLibraryUpdated':
      renderMediaLibrary(message.items);
      renderMediaWall(message.items);
      break;
    // AJOUT (studio de scènes) : même raisonnement que mediaLibraryUpdated
    // ci-dessus — la liste vit côté serveur, diffusée à tous les tableaux de
    // bord ouverts après chaque ajout/suppression/modification.
    case 'sceneLibraryUpdated':
      renderSceneStudioGallery(message.scenes);
      break;
    // AJOUT (chantier 4.3 — feuille de route/cue-list) : même raisonnement
    // que sceneLibraryUpdated ci-dessus (liste persistée côté serveur,
    // diffusée à tous les tableaux de bord ouverts). rundownActiveCue est
    // distinct : ne transporte QUE le pointeur "repère actif", pas la liste.
    case 'rundownUpdated':
      renderRundown(message);
      break;
    case 'rundownActiveCue':
      applyRundownActiveCue(message);
      break;
    // AJOUT (caméras de téléphone) : même raisonnement que mediaLibraryUpdated
    // ci-dessus — la liste vit côté serveur, diffusée à tous les tableaux de
    // bord ouverts après chaque ajout/suppression.
    case 'ipCamerasUpdated':
      renderIpCameras(message.items);
      break;
    // AJOUT (caméra téléphone par QR code) : réponse ponctuelle à
    // generateCameraPairing() — affiche le QR généré, voir showCameraPairingQr().
    case 'cameraPairingGenerated':
      showCameraPairingQr(message);
      break;
    // AJOUT (habillage caméra) : même raisonnement — diffusé à chaque
    // changement pour rester synchronisé entre plusieurs tableaux de bord.
    case 'brandingUpdate':
      renderBranding(message.branding);
      break;
    case 'showMedia':
      addActivity(
        `Média affiché : ${message.label}` +
          (message.detectedBy === 'voice-cue' ? ' (déclenché à la voix)' : ''),
        'info'
      );
      break;
    case 'hideMedia':
      break;
    // AJOUT (studio de scènes) : même raisonnement que showMedia/hideMedia
    // ci-dessus.
    case 'showScene':
      addActivity(`Scène affichée : ${message.name}`, 'info');
      break;
    case 'hideScene':
      break;
    // AJOUT (bibliothèque de chants) : même raisonnement que mediaLibraryUpdated.
    case 'songLibraryUpdated':
      renderSongLibrary(message.songs);
      break;
    // AJOUT (stage display) : messages opérateur -> écran scène uniquement,
    // rien à faire côté tableau de bord au-delà d'un accusé dans le journal
    // d'activité (le contenu réel s'affiche sur stage-display.html).
    case 'stageMessage':
      addActivity(`Message envoyé à l'écran scène : ${message.text}`, 'info');
      break;
    case 'stageMessageClear':
      break;
    // AJOUT (base biblique hors-ligne) : voir renderOfflineBibleStatus() plus bas.
    case 'offlineBibleStatus':
      renderOfflineBibleStatus(message);
      break;
    // AJOUT (cahier des charges — assistant sermons) : voir renderSermonQaResult().
    case 'sermonQuestionAnswered':
      renderSermonQaResult(message);
      break;
    // AJOUT : le serveur diffusait déjà languageChanged (déclenché par
    // une commande vocale "passe en bilingue", ou par un autre tableau
    // de bord connecté) mais rien n'écoutait ici — les boutons de langue
    // restaient figés sur FR même après un changement effectif.
    case 'languageChanged':
      state.activeLanguage = (message.language || 'fr').toUpperCase();
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lang === message.language);
      });
      updateDashboard();
      if (message.triggeredByVoice) {
        addActivity(`Langue changée par commande vocale : ${state.activeLanguage}`, 'info');
      }
      break;
  }
}

// Listening bar — état audio compact en haut de l'espace Direct
function updateListeningBar(msg) {
  const dot = document.getElementById('listeningDot');
  const status = document.getElementById('listeningStatus');
  const level = document.getElementById('listeningLevel');
  const confidence = document.getElementById('listeningConfidence');
  const lang = document.getElementById('listeningLang');
  if (!dot) return;

  const rms = msg.rmsMean || 0;
  const clipping = msg.clippingRate || 0;
  const pct = Math.min(100, Math.round(rms * 300));

  level.style.width = pct + '%';
  level.style.background =
    clipping > 0.01 ? '#ef4444' : pct > 60 ? '#f59e0b' : pct > 15 ? '#22c55e' : '#6b7280';

  if (clipping > 0.01) {
    dot.style.background = '#ef4444';
    status.textContent = 'Écrêté';
    status.style.color = '#ef4444';
  } else if (pct > 15) {
    dot.style.background = '#22c55e';
    status.textContent = 'Écoute active';
    status.style.color = '#22c55e';
  } else {
    dot.style.background = '#6b7280';
    status.textContent = 'En attente…';
    status.style.color = 'var(--text-dim)';
  }

  if (confidence && msg.confidence != null) {
    confidence.textContent = Math.round(msg.confidence * 100) + '%';
  }
  if (lang && state && state.activeLanguage) {
    lang.textContent = state.activeLanguage;
  }
}

// Cross-references — affichées dans la carte dédiée PRÉPARATION
function renderCrossReferences(msg) {
  const el = document.getElementById('crossRefResults');
  const status = document.getElementById('crossRefStatus');
  if (!el) return;
  if (!msg.results || msg.results.length === 0) {
    el.innerHTML =
      '<div class="stat-row"><span class="stat-label">Aucune référence croisée pour ' +
      escapeHtmlDashboard(msg.reference || '') +
      '</span></div>';
    if (status) {
      status.textContent = '0';
      status.style.display = '';
    }
    return;
  }
  el.innerHTML = msg.results
    .map(
      (r) =>
        '<div class="stat-row"><span class="stat-label">' +
        escapeHtmlDashboard(r.ref || '') +
        '</span>' +
        '<span class="stat-value" style="font-size:0.75rem;color:var(--text-dim)">' +
        escapeHtmlDashboard(r.reason || '') +
        '</span></div>'
    )
    .join('');
  if (status) {
    status.textContent = msg.results.length;
    status.style.display = '';
  }
}

// Live summary — rolling summary dans la carte dédiée PRÉPARATION
function renderLiveSummary(msg) {
  const el = document.getElementById('liveSummaryContent');
  if (!el) return;
  if (msg.summary) {
    el.textContent = msg.summary;
    el.style.color = 'var(--text-main)';
  } else {
    el.textContent = 'Résumé indisponible pour le moment.';
    el.style.color = 'var(--text-dim)';
  }
}

// Exposition globale explicite (module ES, pas de globals implicites).
window.handleMessage = handleMessage;
