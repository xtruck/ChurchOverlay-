/**
 * dashboard/features/verse-session-display.js — affichage verset/transcript
 * en direct + contrôles de session (pause/reprise, urgence, langue,
 * transcript, aperçu overlay). Un seul fichier plutôt que deux :
 * updateMLStats() (côté "affichage verset") appelle updateDashboard()
 * (côté "contrôles session"), et les deux partagent setMetricValue() —
 * séparer aurait juste ajouté un import croisé fragile pour un découpage
 * artificiel, sans bénéfice réel.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { state, ws } from '../state.js';
import {
  realMicCaptureState,
  startRealAudioCapture,
  stopRealAudioCapture,
} from './audio-capture.js';
import { showToast, addActivity, escapeHtmlDashboard } from '../utils.js';
import { setStatusStripItem } from './status-strip.js';
import { addSlideToStudio, updatePgmDisplay, updateStageDisplay, updateAiCrossReferences } from './propresenter-studio.js';

export function displayVerse(message) {
  const refEl = document.getElementById('verseReference');
  const textEl = document.getElementById('verseText');
  const bilingualEl = document.getElementById('verseTextBilingual');
  const heroCard = document.getElementById('verseDisplay');
  if (heroCard) heroCard.classList.add('is-live');
  if (refEl) refEl.textContent = message.reference;
  if (textEl) textEl.textContent = message.text;
  if (bilingualEl) {
    if (message.langMode === 'both' && message.text_en) {
      bilingualEl.textContent = 'EN: ' + message.text_en;
      bilingualEl.style.display = 'block';
    } else {
      bilingualEl.textContent = '';
      bilingualEl.style.display = 'none';
    }
  }
  state.currentVerse = message;

  // Synchronise with ProPresenter Studio layout
  addSlideToStudio({
    reference: message.reference,
    text: message.text,
    confidence: message.confidence,
    langMode: message.langMode,
    provider: message.bibleVersion || 'LSG 1910',
  });

  // Trigger AI Smart Cross-References
  if (message.reference) {
    updateAiCrossReferences(message.reference);
  }


  if (message.confidence && refEl) {
    const confidenceEl = document.createElement('span');
    confidenceEl.className = `status-badge ${message.confidence >= 0.8 ? 'success' : 'warning'}`;
    confidenceEl.textContent = `${Math.round(message.confidence * 100)}% de confiance`;
    confidenceEl.style.marginLeft = '10px';
    refEl.appendChild(confidenceEl);
  }

  // AJOUT (transparence détection IA) : le serveur diffuse déjà
  // 'semanticDetected' juste avant le 'showVerse' correspondant quand
  // c'est le détecteur sémantique (LLM), pas la détection littérale, qui a
  // trouvé la référence (voir ws-dispatch.js > case 'semanticDetected',
  // qui pose state.pendingSemanticDetection) — jusqu'ici cette information
  // n'était visible nulle part côté opérateur. Fenêtre de 5s : un
  // 'semanticDetected' peut être suivi d'un rate-limit ou d'un doublon
  // supprimé côté serveur AVANT le showVerse (voir server.js), auquel cas
  // ce drapeau ne doit PAS s'appliquer au prochain verset, sans rapport —
  // il expire silencieusement plutôt que de mal étiqueter un autre verset.
  const pendingSemantic = state.pendingSemanticDetection;
  state.pendingSemanticDetection = null;
  if (pendingSemantic && refEl && Date.now() - pendingSemantic.receivedAt < 5000) {
    const aiBadge = document.createElement('span');
    aiBadge.className = 'status-badge ai';
    aiBadge.textContent = `🤖 Détection IA (${Math.round(pendingSemantic.confidence * 100)}%)`;
    aiBadge.title = pendingSemantic.reasoning || 'Détecté par le détecteur sémantique (IA)';
    aiBadge.style.marginLeft = '10px';
    refEl.appendChild(aiBadge);
  }
}

export function hideVerseDisplay() {
  const refEl = document.getElementById('verseReference');
  const textEl = document.getElementById('verseText');
  const bilingualEl = document.getElementById('verseTextBilingual');
  const heroCard = document.getElementById('verseDisplay');
  if (heroCard) heroCard.classList.remove('is-live');
  if (refEl) refEl.textContent = 'Aucun verset affiché';
  if (textEl) textEl.textContent = 'Les versets apparaîtront ici une fois détectés';
  if (bilingualEl) {
    bilingualEl.textContent = '';
    bilingualEl.style.display = 'none';
  }
  state.currentVerse = null;
  updatePgmDisplay(null);
  updateStageDisplay(null);
}


export function addTranscript(message) {
  const feed = document.getElementById('transcriptFeed');
  const ppFeed = document.getElementById('ppTeleprompterFeed');
  const text = message.text || '';

  if (ppFeed && text) {
    const time = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour12: false });
    const p = document.createElement('div');
    p.style.marginBottom = '6px';
    
    // 1. Highlight potential Bible citations (Gold Amber tags)
    let highlighted = escapeHtmlDashboard(text).replace(
      /\b(Genèse|Exode|Lévitique|Nombres|Deutéronome|Josué|Juges|Ruth|Samuel|Rois|Chroniques|Esdras|Néhémie|Esther|Job|Psaume[s]?|Proverbe[s]?|Ecclésiaste|Cantique|Ésaïe|Jérémie|Lamentations|Ézéchiel|Daniel|Osée|Joël|Amos|Abdias|Jonas|Michée|Nahum|Habacuc|Sophonie|Aggée|Zacharie|Malachie|Matthieu|Marc|Luc|Jean|Actes|Romains|Corinthiens|Galates|Éphésiens|Philippiens|Colossiens|Thessaloniciens|Timothée|Tite|Philémon|Hébreux|Jacques|Pierre|Jude|Apocalypse)\s+\d+(:\d+)?/gi,
      '<span class="pp-scripture-tag" onclick="if(window.quickLookupVerse) window.quickLookupVerse(\'$&\');">📖 $&</span>'
    );

    // 2. Highlight Divine Names (Blue Cyan)
    highlighted = highlighted.replace(
      /\b(Jésus|Christ|Jésus-Christ|Dieu|Seigneur|Père céleste|Saint-Esprit|Yahvé|Éternel|Messie|Sauveur|Agneau de Dieu)\b/gi,
      '<span class="pp-word-divine">$&</span>'
    );

    // 3. Highlight Grace, Love & Salvation words (Emerald Green)
    highlighted = highlighted.replace(
      /\b(Grâce|Amour|Pardon|Salut|Rédemption|Croix|Sang|Résurrection|Vie éternelle|Réconciliation|Miséricorde)\b/gi,
      '<span class="pp-word-grace">$&</span>'
    );

    // 4. Highlight Faith, Prayer & Praise words (Purple Violet)
    highlighted = highlighted.replace(
      /\b(Foi|Prière|Louange|Adoration|Alléluia|Amen|Gloire|Bénédiction|Sainteté|Miracle|Espérance|Persévérance)\b/gi,
      '<span class="pp-word-faith">$&</span>'
    );

    // 5. Highlight chapters and verses spoken
    highlighted = highlighted.replace(
      /\b(chapitre\s+\d+|verset\s+\d+)\b/gi,
      '<span class="pp-word-chapter">$&</span>'
    );

    p.innerHTML = `<span style="color: var(--pp-text-dim); font-size: 10px; font-family: var(--pp-font-mono); margin-right: 6px;">[${time}]</span> ${highlighted}`;
    ppFeed.insertBefore(p, ppFeed.firstChild);
    while (ppFeed.children.length > 30) ppFeed.removeChild(ppFeed.lastChild);
  }


  if (!feed) return;

  const item = document.createElement('div');
  item.className = 'transcript-item';
  const time = new Date(message.timestamp || Date.now()).toLocaleTimeString();
  const confidenceHtml =
    typeof message.confidence === 'number'
      ? `<span class="status-badge ${message.confidence >= 0.6 ? 'success' : message.confidence >= 0.3 ? 'warning' : 'error'}">${Math.round(message.confidence * 100)}%</span>`
      : '';
  item.innerHTML = `
                <div class="transcript-time"><span>${time}</span><span>${escapeHtmlDashboard(message.source || 'Audio')}${confidenceHtml}</span></div>
                <div class="transcript-text">${escapeHtmlDashboard(message.text || '')}</div>
            `;

  feed.insertBefore(item, feed.firstChild);

  while (feed.children.length > 50) {
    feed.removeChild(feed.lastChild);
  }

  state.transcripts.unshift(message);
  if (state.transcripts.length > 50) state.transcripts.pop();
}


// AJOUT (frontend — candidateVerse) : formate une référence reçue en objet
// ({ book, chapter, verseStart }) ou en chaîne toute faite en un libellé
// lisible, quel que soit le cas — utilisé à la fois par showCandidateVerse
// et par ws-dispatch.js pour l'activité (avant, un message affichait
// "[object Object]" dans le flux d'activité). book est normalisé en
// minuscules par le détecteur ("jean") — capitalisé pour l'affichage.
export function formatReferenceLabel(reference) {
  if (typeof reference === 'string') return reference;
  if (!reference || typeof reference !== 'object') return '';
  const book = String(reference.book || '').trim();
  const displayBook = book ? book.charAt(0).toUpperCase() + book.slice(1) : '';
  const chapter = reference.chapter ? ` ${reference.chapter}` : '';
  const verse = reference.verseStart ? `:${reference.verseStart}` : '';
  return `${displayBook}${chapter}${verse}`;
}

// AJOUT (Étape 5 — candidateVerse spéculative) : cycle de vie unique des
// bandeaux "candidat" (fuzzy + spéculatif). Masque les deux bandeaux et
// annule leurs timeouts — appelé quand un vrai showVerse arrive (la
// confirmation est là, plus rien à signaler), quand une nouvelle candidate
// remplace l'ancienne, et au masquage manuel.
export function clearCandidateNotices() {
  const fuzzyEl = document.getElementById('fuzzyMatchNotice');
  const candidateEl = document.getElementById('candidateNotice');
  if (fuzzyEl) {
    fuzzyEl.style.display = 'none';
    clearTimeout(fuzzyEl._hideTimer);
  }
  if (candidateEl) {
    candidateEl.style.display = 'none';
    clearTimeout(candidateEl._hideTimer);
  }
}

export function showCandidateVerse(message) {
  const refLabel = formatReferenceLabel(message.reference);

  // Correspondance floue ("Correction automatique") : le texte original
  // transcrit ("chapitre quatorze" → "Jean 14") — bandeau violet existant.
  const isFuzzyCorrection =
    typeof message.distance === 'number' && !message.speculative && message.original;
  if (isFuzzyCorrection) {
    const el = document.getElementById('fuzzyMatchNotice');
    if (el) {
      const book = refLabel || formatReferenceLabel(message.reference && message.reference.book);
      el.textContent = `Correction automatique : "${message.original}" → livre "${book}" (distance ${message.distance})`;
      el.style.display = 'block';
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => {
        el.style.display = 'none';
      }, 8000);
    }
    return;
  }

  // Candidate spéculative (Étape 5) : référence entendue (explicite, stable,
  // ou chapitre seul d'un partial local) — on ATTEND la confirmation du
  // texte final officiel avant tout affichage. Bandeau cyan distinct, effacé
  // au showVerse réel / remplacé / timeout. Un message de remplacement
  // n'empile jamais : la nouvelle candidate masque la précédente.
  const el = document.getElementById('candidateNotice');
  if (el && refLabel) {
    clearCandidateNotices();
    el.textContent = `Référence entendue : ${refLabel} — en attente de confirmation du texte…`;
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 8000);
  }
}

export function updateAnalysis(message) {
  if (document.getElementById('wordCount'))
    document.getElementById('wordCount').textContent = message.wordCount;
  if (document.getElementById('keyPoints'))
    document.getElementById('keyPoints').textContent = message.keyPoints.length;
  if (document.getElementById('themesCount'))
    document.getElementById('themesCount').textContent = message.themes.length;

  const themesList = document.getElementById('themesList');
  if (themesList) {
    themesList.innerHTML = '';
    message.themes.slice(0, 5).forEach((theme) => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `
                        <span class="stat-label">${theme.name}</span>
                        <span class="stat-value">${theme.strength}</span>
                    `;
      themesList.appendChild(row);
    });
  }
}

// AJOUT (effet JS "gratuit" en CPU) : petite animation de comptage
// quand un chiffre de métrique change, plutôt qu'un saut sec. Se
// déclenche uniquement sur un vrai changement de valeur (pas à
// chaque appel de updateDashboard), dure ~350ms via requestAnimationFrame,
// puis s'arrête complètement d'elle-même — aucun coût entre deux
// mises à jour de données.
const _metricAnimState = new Map();
export function setMetricValue(id, value, suffix = '') {
  const el = document.getElementById(id);
  if (!el) return;
  const numeric = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(numeric)) {
    el.textContent = value;
    return;
  }
  const prev = _metricAnimState.has(id) ? _metricAnimState.get(id) : numeric;
  _metricAnimState.set(id, numeric);
  if (prev === numeric) {
    el.textContent = `${numeric}${suffix}`;
    return;
  }
  const start = performance.now();
  const duration = 350;
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(prev + (numeric - prev) * eased);
    el.textContent = `${current}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

export function updateMLStats(message) {
  setMetricValue('totalDetections', message.totalDetections);
  setMetricValue('highConfidence', message.highConfidence);
  if (document.getElementById('avgConfidence'))
    document.getElementById('avgConfidence').textContent =
      `${Math.round(message.avgConfidence * 100)}%`;

  state.detectionRate =
    message.totalDetections > 0
      ? Math.round((message.highConfidence / message.totalDetections) * 100)
      : 100;
  updateDashboard();
}

export function updateDashboard() {
  // AJOUT (audit perf) : cette minuterie tournait chaque seconde même
  // fenêtre cachée/sans focus (opérateur basculé sur OBS pendant tout le
  // culte) — seule minuterie que le throttle de visibilité existant
  // (setupAmbientAnimationThrottle, voir .animations-paused plus bas dans
  // ce fichier) ne couvrait pas encore. Réutilise le même signal plutôt que
  // de dupliquer la logique document.hidden/hasFocus().
  if (document.body.classList.contains('animations-paused')) return;

  setMetricValue('totalVerses', state.totalVerses);
  setMetricValue('detectionRate', state.detectionRate, '%');
  if (document.getElementById('activeLanguage'))
    document.getElementById('activeLanguage').textContent = state.activeLanguage;

  const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  if (document.getElementById('sessionDuration'))
    document.getElementById('sessionDuration').textContent = `${minutes}:${seconds}`;
}

export function updateStatus(connected, reconnectAttempt) {
  const statusEls = document.querySelectorAll('.status');
  statusEls.forEach((status) => {
    const dot = status.querySelector('.status-dot');
    const text = status.querySelector('span');
    status.classList.toggle('offline', !connected);
    if (connected) {
      if (dot) dot.style.background = 'var(--accent-emerald)';
      if (dot) dot.style.boxShadow = '0 0 8px var(--accent-emerald)';
      if (text) text.textContent = 'Connecté';
    } else {
      if (dot) dot.style.background = 'var(--accent-rose)';
      if (dot) dot.style.boxShadow = '0 0 8px var(--accent-rose)';
      if (text)
        text.textContent = reconnectAttempt
          ? `Déconnecté — reconnexion en cours (tentative ${reconnectAttempt})...`
          : 'Déconnecté';
    }
  });
  const sidebarText = document.getElementById('sidebarStatusText');
  if (sidebarText) sidebarText.textContent = connected ? 'Serveur En Ligne' : 'Serveur Hors Ligne';
  const sidebarPill = sidebarText ? sidebarText.closest('.live-status-pill') : null;
  if (sidebarPill) sidebarPill.classList.toggle('offline', !connected);
}

// Control Actions
export function sendCustomSpeechText(customText) {
  const input = document.getElementById('speechTextInput');
  const val = customText || (input ? input.value : '');
  if (!val || !val.trim()) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        action: 'transcript',
        text: val.trim(),
        timestamp: Date.now(),
        source: 'manual_speech',
      })
    );
    if (input && !customText) input.value = '';
    addActivity(`Phrase transmise : "${val.trim().substring(0, 30)}..."`, 'info');
  } else {
    showToast('Connexion WebSocket fermée. Veuillez patienter...', 'error');
  }
}

export function showManualVerse() {
  const reference = prompt('Entrez une référence biblique (ex. Jean 3:16) :');
  if (reference) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'showVerse',
          reference: reference,
          // CORRECTIF (bug trouvé via les tests Playwright, lot 8) :
          // validation.js exige un champ `text` non vide pour tout message
          // client 'showVerse' (voir SCHEMAS.showVerse), mais le handler
          // serveur (server.js > sanitized.action === 'showVerse') ne lit
          // JAMAIS ce champ — il refait sa propre recherche via
          // bibleLookup.getVerseMultilang() et diffuse CE texte-là. Sans ce
          // champ, le message est rejeté par validation.js avant même
          // d'atteindre ce handler (dès que VALIDATE_MESSAGES=true, actif
          // par défaut) : "Afficher un Verset" ne faisait donc jamais rien.
          // Valeur purement cosmétique côté client, jamais affichée nulle
          // part — seule sa présence/longueur compte pour la validation.
          text: reference,
        })
      );
      addActivity(`Recherche manuelle : ${reference}`, 'info');
      showToast(`Affichage de ${reference}...`, 'info');
    }
  }
}

export function hideVerse() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'hideVerse' }));
    addActivity('Verset masqué', 'info');
    showToast('Verset masqué', 'info');
  }
}

export function pauseTimer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'pauseTimer' }));
    showToast('Timer mis en pause', 'warning');
  }
}

export function resumeTimer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'resumeTimer' }));
    showToast('Timer repris', 'success');
  }
}

export function emergencyStop() {
  if (confirm("Confirmez-vous l'arrêt d'urgence de l'affichage ?")) {
    hideVerse();
    addActivity("Arrêt d'urgence déclenché", 'error');
    showToast("Arrêt d'urgence activé", 'error');
  }
}

let blackScreenActive = false;
export function toggleBlackScreen() {
  blackScreenActive = !blackScreenActive;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setBlackScreen', enabled: blackScreenActive }));
  }
  addActivity(blackScreenActive ? 'Écran noir activé' : 'Écran noir désactivé', 'warning');
  showToast(
    blackScreenActive ? 'Écran noir activé' : 'Écran noir désactivé',
    blackScreenActive ? 'error' : 'info'
  );
}
window.toggleBlackScreen = toggleBlackScreen;

let previewProgramMode = false;
export function togglePreviewProgramMode() {
  previewProgramMode = !previewProgramMode;
  const preview = document.getElementById('previewPane');
  const programLabel = document.getElementById('programLabel');
  const label = document.getElementById('previewModeLabel');
  if (preview) preview.style.display = previewProgramMode ? '' : 'none';
  if (programLabel) programLabel.style.display = previewProgramMode ? '' : 'none';
  if (label) label.textContent = previewProgramMode ? 'Aperçu / Programme' : 'Aperçu en direct';
  addActivity(previewProgramMode ? 'Mode Aperçu/Programme activé' : 'Mode simple rétabli', 'info');
}
window.togglePreviewProgramMode = togglePreviewProgramMode;

window.startServiceCountdown = function () {
  const sel = document.getElementById('countdownDuration');
  const minutes = sel ? parseInt(sel.value, 10) : 10;
  const endTimeMs = Date.now() + minutes * 60 * 1000;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({ action: 'startCountdown', endTimeMs, label: 'Le culte commence dans' })
    );
  }
  addActivity('Compteur lancé : ' + minutes + ' minutes', 'info');
  showToast('Compteur de ' + minutes + ' min lancé', 'info');
};
window.stopServiceCountdown = function () {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'stopCountdown' }));
  }
  addActivity('Compteur arrêté', 'warning');
};

export function setLanguage(lang) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setLanguage', language: lang }));
  }
  state.activeLanguage = lang.toUpperCase();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  updateDashboard();
}

export function clearTranscript() {
  const feed = document.getElementById('transcriptFeed');
  if (feed) {
    feed.innerHTML = `
                    <div class="transcript-item">
                        <div class="transcript-time"><span>00:00:00</span><span>Info</span></div>
                        <div class="transcript-text transcript-text--placeholder">Historique effacé. En attente de nouvelles entrées audio.</div>
                    </div>
                `;
  }
  state.transcripts = [];
  showToast('Transcription effacée', 'info');
}

setInterval(updateDashboard, 1000);

// CORRECTIF (bug signalé — "quand j'active le micro ça se désactive
// seul et les mêmes messages d'erreurs reviennent") : le bouton "Démarrer
// le Micro" en haut du tableau de bord appelait toggleSpeechRecognition(),
// qui pilotait l'ancienne dictée du navigateur (webkitSpeechRecognition) —
// PAS le vrai pipeline micro (Whisper/Groq/Deepgram, voir
// startRealAudioCapture() plus haut, qui démarre automatiquement et n'a
// besoin d'aucun bouton). Cette dictée navigateur est cassée de façon
// permanente dans Electron (le moteur de Chromium embarqué n'a pas la clé
// API Google interne nécessaire — voir electron/electron#46143, jamais
// résolu depuis 2016) : elle échouait avec une erreur réseau après 3
// tentatives, puis s'arrêtait d'elle-même — exactement le comportement
// "s'active puis se désactive tout seul" avec les mêmes messages
// d'erreur à chaque fois. Le bouton ne servait donc à rien d'utile et ne
// faisait que semer la confusion : rien n'indiquait qu'il ne contrôlait
// pas le vrai micro. Supprimé (avec toute la dictée navigateur associée,
// ~235 lignes de code mort) et remplacé par un vrai statut/contrôle du
// pipeline réel.
export function updateMicButtonUI() {
  const btn = document.getElementById('speechBtn');
  const btnText = document.getElementById('speechBtnText');
  const badge = document.getElementById('speechStatus');
  const active = !!realMicCaptureState;
  if (btnText) btnText.textContent = active ? 'Arrêter le Micro' : 'Démarrer le Micro';
  if (btn) btn.classList.toggle('btn-active', active);
  if (badge) {
    badge.textContent = active ? 'Capture active (Whisper/Groq/Deepgram)' : 'Capture arrêtée';
    badge.className = 'status-badge ' + (active ? 'success' : 'warning');
  }
  // AJOUT (bandeau d'état permanent) : "arrêté" n'est pas une erreur en soi
  // (micro légitimement coupé entre deux cultes) — 'off' (neutre), pas
  // 'warn', pour ne pas alarmer à tort en dehors d'un service.
  setStatusStripItem('Micro', active ? 'ok' : 'off', active ? 'Capture active' : 'Arrêté');
}

export async function toggleRealMicCapture() {
  if (realMicCaptureState) {
    stopRealAudioCapture();
    addActivity('Capture micro arrêtée manuellement', 'info');
    showToast('Micro arrêté', 'info');
  } else {
    await startRealAudioCapture();
    showToast(
      realMicCaptureState ? 'Micro démarré' : 'Échec du démarrage du micro',
      realMicCaptureState ? 'success' : 'error'
    );
  }
  updateMicButtonUI();
}

export function refreshOverlay() {
  const frame = document.getElementById('overlayFrame');
  if (frame && state.overlayUrl) {
    const url = new URL(state.overlayUrl);
    url.searchParams.set('_refresh', Date.now());
    frame.src = url.toString();
  }
  showToast('Aperçu Overlay rafraîchi', 'info');
}

window.sendCustomSpeechText = sendCustomSpeechText;
window.showManualVerse = showManualVerse;
window.hideVerse = hideVerse;
window.pauseTimer = pauseTimer;
window.resumeTimer = resumeTimer;
window.emergencyStop = emergencyStop;
window.setLanguage = setLanguage;
window.clearTranscript = clearTranscript;
window.toggleRealMicCapture = toggleRealMicCapture;
window.refreshOverlay = refreshOverlay;
