/**
 * dashboard/features/preservice-ai.js — vérification avant culte,
 * fonctions IA avancées (thème de prédication, résumé en direct,
 * références croisées, traduction, récap fin de culte, statistiques
 * de session, export des temps forts, recherche d'archives, questions
 * sur une prédication), accessibilité (contraste élevé, sous-titres),
 * fenêtres d'affichage secondaires, et messages de scène.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { state, ws } from '../state.js';
import { showToast, escapeHtmlDashboard, requireWsOrWarn } from '../utils.js';

// CORRECTIF (checklist mise en production, point 9) : bouton "Tester avant
// le culte" — envoie une demande de vérification au serveur (connexion WS,
// validité des clés Groq/Deepgram) et affiche le résultat sans quitter le
// tableau de bord.
export function runPreServiceCheck() {
  const btn = document.getElementById('preServiceCheckBtn');
  const resultsEl = document.getElementById('preServiceCheckResults');
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible de lancer le test.', 'error');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Vérification en cours...';
  }
  if (resultsEl) {
    resultsEl.style.display = 'none';
  }
  ws.send(JSON.stringify({ action: 'preServiceCheck' }));
}

// CORRECTIF (audit round 6) : déclencheurs des fonctions IA avancées
// (ai-enricher.js) — le backend existait déjà pour toutes ces actions,
// il manquait uniquement le bouton et l'affichage du résultat.
export function renderAiEnricherOutput(text) {
  const el = document.getElementById('aiEnricherOutput');
  if (el) el.innerHTML = `<span class="stat-label">${text}</span>`;
}

export function requestSermonTheme() {
  if (!requireWsOrWarn()) return;
  renderAiEnricherOutput('⏳ Analyse du thème en cours...');
  ws.send(JSON.stringify({ action: 'getSermonTheme' }));
}

export function requestLiveSummary() {
  if (!requireWsOrWarn()) return;
  renderAiEnricherOutput('⏳ Génération du résumé en cours...');
  ws.send(JSON.stringify({ action: 'getLiveSummary' }));
}

// AJOUT (statistiques IA — fonctionnalité déjà codée côté serveur, jamais
// exposée côté tableau de bord jusqu'ici) : getAiStats existait déjà
// (server.js), purement diagnostique — utile pour vérifier que le
// détecteur sémantique/correcteur tournent réellement, pas pour une
// décision en direct pendant un culte.
export function requestAiStats() {
  if (!requireWsOrWarn()) return;
  renderAiEnricherOutput('⏳ Chargement des statistiques IA...');
  ws.send(JSON.stringify({ action: 'getAiStats' }));
}

export function renderAiStats(message) {
  // CORRECTIF : renderAiEnricherOutput() enveloppe systématiquement son
  // contenu dans <span class="stat-label">...</span> (voir plus haut) —
  // adapté à une seule ligne de texte, pas à une liste de .stat-row (des
  // <div>, invalides à l'intérieur d'un <span>). Écrit donc directement
  // dans le même élément plutôt que de réutiliser ce wrapper ici.
  const el = document.getElementById('aiEnricherOutput');
  if (!el) return;
  const rows = [];
  if (message.semanticDetector) {
    rows.push(
      `<div class="stat-row"><span class="stat-label">Détecteur sémantique — cache</span><span class="stat-value">${message.semanticDetector.cacheSize}</span></div>`
    );
    rows.push(
      `<div class="stat-row"><span class="stat-label">Détecteur sémantique — appels récents</span><span class="stat-value">${message.semanticDetector.recentCalls}</span></div>`
    );
  } else {
    rows.push(
      '<div class="stat-row"><span class="stat-label">Détecteur sémantique</span><span class="stat-value">Indisponible</span></div>'
    );
  }
  if (message.corrector) {
    rows.push(
      `<div class="stat-row"><span class="stat-label">Corrections rapides</span><span class="stat-value">${message.corrector.fastCorrections || 0}</span></div>`
    );
    rows.push(
      `<div class="stat-row"><span class="stat-label">Corrections avancées</span><span class="stat-value">${message.corrector.smartCorrections || 0}</span></div>`
    );
  }
  rows.push(
    `<div class="stat-row"><span class="stat-label">Enrichisseur IA (résumé/thème/récap)</span><span class="stat-value">${message.aiEnricher ? 'Actif' : 'Indisponible'}</span></div>`
  );
  if (message.loadErrors && message.loadErrors.length) {
    rows.push(
      `<div class="stat-row"><span class="stat-label">Erreurs de chargement</span><span class="stat-value stat-value-sub">${message.loadErrors.map((e) => escapeHtmlDashboard(String(e))).join(', ')}</span></div>`
    );
  }
  el.innerHTML = rows.join('');
}

export function requestCrossReferences() {
  if (!requireWsOrWarn()) return;
  const verse = state.currentVerse;
  if (!verse || !verse.reference) {
    renderAiEnricherOutput(
      'Aucun verset affiché récemment — affiche un verset avant de demander des références croisées.'
    );
    return;
  }
  renderAiEnricherOutput('⏳ Recherche de références croisées...');
  ws.send(
    JSON.stringify({
      action: 'getCrossReferences',
      reference: verse.reference,
      text: verse.text || '',
    })
  );
}

export function requestLiveTranslation() {
  if (!requireWsOrWarn()) return;
  const verse = state.currentVerse;
  if (!verse || !verse.text) {
    renderAiEnricherOutput('Aucun texte de verset à traduire pour le moment.');
    return;
  }
  renderAiEnricherOutput('⏳ Traduction en cours...');
  ws.send(JSON.stringify({ action: 'translateText', text: verse.text, targetLang: 'en' }));
}

export function requestPostServiceRecap() {
  if (!requireWsOrWarn()) return;
  renderAiEnricherOutput('⏳ Génération du récapitulatif...');
  ws.send(JSON.stringify({ action: 'getPostServiceRecap' }));
}

// AJOUT (audit round 9) : session-store.js persiste déjà chaque verset
// affiché et chaque erreur de pipeline en SQLite (survie à un crash),
// mais rien ne relisait jamais cette base côté tableau de bord — la
// persistance tournait "dans le vide" sans jamais être consultable par
// l'opérateur. Bouton + panneau pour l'exposer : combien de versets
// affichés, combien d'erreurs, sur la période choisie (défaut : 24h).
export function requestSessionStats(days) {
  if (!requireWsOrWarn()) return;
  const el = document.getElementById('sessionStatsOutput');
  if (el) el.innerHTML = '<span class="stat-label">⏳ Chargement des statistiques...</span>';
  ws.send(JSON.stringify({ action: 'getSessionStats', days: days || 1 }));
}

export function renderSessionStats(message) {
  const el = document.getElementById('sessionStatsOutput');
  if (!el) return;

  if (!message.persistenceEnabled) {
    el.innerHTML =
      '<span class="stat-label">Persistance SQLite indisponible sur cet appareil — aucun historique conservé entre les sessions.</span>';
    return;
  }

  const period = message.days === 1 ? 'les dernières 24h' : `les ${message.days} derniers jours`;
  const errorLines = Object.entries(message.errorsByType || {})
    .map(([type, count]) => `${type} : ${count}`)
    .join(' · ');

  const recentVerses = (message.verses || [])
    .slice(0, 10)
    .map((v) => {
      const time = new Date(v.shown_at).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `<div class="stat-row"><span class="stat-label">${time} — ${escapeHtmlDashboard(v.reference)}</span></div>`;
    })
    .join('');

  el.innerHTML = `
    <div class="stat-row"><span class="stat-label">Versets affichés (${period})</span><span class="stat-value">${message.verseCount}</span></div>
    <div class="stat-row"><span class="stat-label">Erreurs de pipeline</span><span class="stat-value">${message.errorCount}</span></div>
    ${errorLines ? `<div class="stat-row"><span class="stat-label">Détail des erreurs</span><span class="stat-value stat-value-sub">${errorLines}</span></div>` : ''}
    ${recentVerses ? `<div class="stat-scroll-list">${recentVerses}</div>` : ''}
  `;
}

// AJOUT (export des temps forts — voir highlight-export.js) : réutilise le
// même historique persistant que ci-dessus, mis en forme pour un
// enregistrement vidéo du culte EN COURS (depuis le démarrage du serveur,
// pas une période choisie comme requestSessionStats).
export function exportHighlights() {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'exportHighlights' }));
}

export function renderHighlightsExport(message) {
  const output = document.getElementById('highlightsExportOutput');
  if (!output) return;

  if (!message.count) {
    showToast('Aucun temps fort à exporter pour le moment.', 'info');
    output.style.display = 'none';
    return;
  }

  output.value = message.youtubeChapters || '';
  output.style.display = 'block';

  if (navigator.clipboard && navigator.clipboard.writeText && message.csv) {
    navigator.clipboard
      .writeText(message.csv)
      .then(() =>
        showToast(
          `${message.count} temps fort(s) — CSV copié, chapitres YouTube ci-dessous.`,
          'success'
        )
      )
      .catch(() => showToast(`${message.count} temps fort(s) exportés ci-dessous.`, 'success'));
  } else {
    showToast(`${message.count} temps fort(s) exportés ci-dessous.`, 'success');
  }
}

// AJOUT : badge de mode de culte auto-détecté (Louange / Prédication /
// Prière / Annonces...). Le texte de `theme` provient de detectSermonTheme
// côté ai-enricher.js ; on l'affiche tel quel sans le réinterpréter pour
// rester cohérent avec ce que l'IA a réellement détecté.
export function updateSermonModeBadge(message) {
  const badge = document.getElementById('sermonModeBadge');
  if (!badge) return;
  if (!message || !message.theme) {
    badge.style.display = 'none';
    return;
  }
  badge.textContent = `Mode détecté : ${message.theme}`;
  badge.className = 'status-badge success';
  badge.style.display = 'inline-flex';
}

// AJOUT : toggle "Traduction live sur l'overlay" — active/désactive
// l'auto-détection et déclenche/arrête immédiatement selon le verset
// actuellement affiché.
export function onAutoTranslateToggle() {
  const checkbox = document.getElementById('autoTranslateToggle');
  state.autoTranslateEnabled = !!(checkbox && checkbox.checked);
  if (state.autoTranslateEnabled) {
    showToast("Traduction live activée sur l'overlay.", 'success');
    if (state.currentVerse && state.currentVerse.text) {
      requestAutoTranslation(state.currentVerse);
    }
  } else {
    showToast('Traduction live désactivée.', 'info');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'hideTranslation' }));
    }
  }
}

export function onAutoTranslateLangChange() {
  const select = document.getElementById('autoTranslateLang');
  state.autoTranslateLang = select ? select.value : 'en';
  if (state.autoTranslateEnabled && state.currentVerse && state.currentVerse.text) {
    requestAutoTranslation(state.currentVerse);
  }
}

// AJOUT (audit — accessibilité, gratuit/léger, session parallèle) : bascule
// "Mode grand contraste" — un seul message WS, le serveur retransmet à
// tous les overlays connectés (voir action 'setHighContrast' -> 'accessibilityMode'
// dans server.js).
export function onHighContrastToggle() {
  const checkbox = document.getElementById('highContrastToggle');
  const enabled = !!(checkbox && checkbox.checked);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setHighContrast', enabled }));
  }
  showToast(
    enabled ? "Mode grand contraste activé sur l'overlay." : 'Mode grand contraste désactivé.',
    'info'
  );
}

// AJOUT (audit — accessibilité, session parallèle) : bascule "Sous-titres
// en direct" — même schéma que le contraste élevé.
export function onCaptionsToggle() {
  const checkbox = document.getElementById('captionsToggle');
  const enabled = !!(checkbox && checkbox.checked);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setCaptions', enabled }));
  }
  showToast(enabled ? "Sous-titres activés sur l'overlay." : 'Sous-titres désactivés.', 'info');
}

// AJOUT (sous-titres traduits en direct — voir caption-translator.js) :
// même schéma que onCaptionsToggle(), avec une langue cible en plus.
export function onTranslatedCaptionsToggle() {
  const checkbox = document.getElementById('translatedCaptionsToggle');
  const langSelect = document.getElementById('captionTargetLangSelect');
  const enabled = !!(checkbox && checkbox.checked);
  const targetLang = langSelect ? langSelect.value : 'en';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setTranslatedCaptions', enabled, targetLang }));
  }
  showToast(
    enabled ? `Sous-titres traduits activés (${targetLang}).` : 'Sous-titres traduits désactivés.',
    'info'
  );
}

// AJOUT (audit — plusieurs façons d'afficher l'overlay, gratuit/léger,
// session parallèle) : fenêtre plein écran indépendante d'OBS (voir
// createDisplayWindow dans main.js). Même garde que les autres panneaux
// Electron-only : n'existe que côté application de bureau (le pont IPC
// vient de preload.js).
(function initDisplayWindowPanel() {
  const unavailable = document.getElementById('displayWindowUnavailable');
  const controls = document.getElementById('displayWindowControls');
  if (!controls) return;

  if (!window.churchOverlay || !window.churchOverlay.listDisplays) {
    if (unavailable) unavailable.style.display = 'block';
    return;
  }
  controls.style.display = 'block';
  refreshDisplays();
})();

export async function refreshDisplays() {
  const select = document.getElementById('displaySelect');
  if (!select || !window.churchOverlay || !window.churchOverlay.listDisplays) return;
  try {
    const displays = await window.churchOverlay.listDisplays();
    select.innerHTML = (displays || [])
      .map((d) => `<option value="${d.id}">${d.label}</option>`)
      .join('');
  } catch (err) {
    showToast(
      'Impossible de lister les écrans : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

// AJOUT (stage display / diaporama d'annonces) : le mode sélectionné décide
// QUELLE page (overlay.html / stage-display.html / announcement-loop.html)
// s'ouvre — voir DISPLAY_MODES dans main.js. Chaque mode a sa PROPRE fenêtre
// (peuvent être ouvertes simultanément sur des écrans différents).
export function getSelectedDisplayMode() {
  const modeSelect = document.getElementById('displayModeSelect');
  return modeSelect ? modeSelect.value || 'overlay' : 'overlay';
}

const DISPLAY_MODE_LABELS = {
  overlay: 'Overlay',
  stage: 'Écran scène',
  announcements: 'Diaporama annonces',
};

export async function openDisplayWindow() {
  const select = document.getElementById('displaySelect');
  if (!select || !window.churchOverlay || !window.churchOverlay.openDisplayWindow) return;
  const displayId = select.value ? Number(select.value) : undefined;
  const mode = getSelectedDisplayMode();
  try {
    await window.churchOverlay.openDisplayWindow(displayId, mode);
    showToast(`${DISPLAY_MODE_LABELS[mode] || mode} affiché en plein écran.`, 'success');
  } catch (err) {
    showToast("Échec de l'affichage : " + (err && err.message ? err.message : err), 'error');
  }
}

export async function closeDisplayWindow() {
  if (!window.churchOverlay || !window.churchOverlay.closeDisplayWindow) return;
  const mode = getSelectedDisplayMode();
  try {
    await window.churchOverlay.closeDisplayWindow(mode);
    showToast(`Fenêtre "${DISPLAY_MODE_LABELS[mode] || mode}" fermée.`, 'info');
  } catch (err) {
    showToast('Échec de la fermeture : ' + (err && err.message ? err.message : err), 'error');
  }
}

// AJOUT (stage display) : message texte opérateur -> écran scène uniquement.
export function sendStageMessage() {
  const input = document.getElementById('stageMessageInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'sendStageMessage', text }));
  if (input) input.value = '';
}

export function clearStageMessage() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'clearStageMessage' }));
}

// AJOUT (audit — motif de test, gratuit/léger, session parallèle) : barres
// de couleur pures CSS côté overlay (voir #test-pattern dans overlay.html)
// — aucun calcul, juste un dégradé statique pour vérifier la chaîne vidéo
// avant un culte.
export function onTestPatternToggle() {
  const checkbox = document.getElementById('testPatternToggle');
  const enabled = !!(checkbox && checkbox.checked);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setTestPattern', enabled }));
  }
  showToast(enabled ? "Motif de test activé sur l'overlay." : 'Motif de test désactivé.', 'info');
}

// AJOUT (audit — mémoire des cultes, gratuit/léger, session parallèle) :
// recherche locale par mots-clés, pas d'appel API — voir sermon-archive.js.
export function requestArchiveSearch() {
  if (!requireWsOrWarn()) return;
  const input = document.getElementById('archiveSearchInput');
  const query = input ? input.value.trim() : '';
  if (!query) {
    renderAiEnricherOutput('Tapez un mot-clé ou un thème avant de lancer la recherche.');
    return;
  }
  renderAiEnricherOutput('⏳ Recherche dans les cultes archivés...');
  ws.send(JSON.stringify({ action: 'getArchiveMatches', query }));
}

// AJOUT (cahier des charges — assistant sermons, Point 5) : voir sermon-qa.js
// côté serveur pour le garde-fou "jamais de réponse sans source". Cette
// fonction/sa carte restent volontairement séparées de
// renderAiEnricherOutput() ci-dessus.
export function askSermonQuestion() {
  if (!requireWsOrWarn()) return;
  const input = document.getElementById('sermonQaInput');
  const outputEl = document.getElementById('sermonQaOutput');
  const sourcesEl = document.getElementById('sermonQaSources');
  const question = input ? input.value.trim() : '';
  if (!question) {
    if (outputEl)
      outputEl.innerHTML =
        '<span class="stat-label">Tapez une question avant de lancer la recherche.</span>';
    return;
  }
  if (outputEl) outputEl.innerHTML = '<span class="stat-label">⏳ Recherche en cours...</span>';
  if (sourcesEl) sourcesEl.innerHTML = '';
  ws.send(JSON.stringify({ action: 'askSermonQuestion', question }));
}

// AJOUT (cahier des charges — assistant sermons) : les sources sont
// TOUJOURS affichées à côté de la réponse générée, jamais seulement citées
// dans le texte du modèle — garantie au niveau de l'interface que "jamais
// de réponse sans citation" tient même si la réponse elle-même oublie de
// toutes les mentionner.
export function renderSermonQaResult(result) {
  const outputEl = document.getElementById('sermonQaOutput');
  const sourcesEl = document.getElementById('sermonQaSources');
  if (!outputEl) return;

  if (!result.ok) {
    outputEl.innerHTML = `<span class="stat-label">❌ ${escapeHtmlDashboard(result.message || 'Erreur inconnue')}</span>`;
    if (sourcesEl) sourcesEl.innerHTML = '';
    return;
  }

  if (!result.answered) {
    outputEl.innerHTML = `<span class="stat-label">${escapeHtmlDashboard(result.message)}</span>`;
    if (sourcesEl) sourcesEl.innerHTML = '';
    return;
  }

  outputEl.innerHTML = `<span class="stat-value" style="display:block; white-space:pre-wrap;">${escapeHtmlDashboard(result.answer)}</span>`;
  if (sourcesEl) {
    sourcesEl.innerHTML =
      '<div class="qa-sources-label">Sources citées :</div>' +
      (result.sources || [])
        .map(
          (s) =>
            `<div class="media-item-phrase-badge qa-source-card">
               <strong>${escapeHtmlDashboard(s.label)}</strong><br>
               <span class="qa-source-excerpt">${escapeHtmlDashboard(s.excerpt.slice(0, 200))}${s.excerpt.length > 200 ? '…' : ''}</span>
             </div>`
        )
        .join('');
  }
}

export function requestAutoTranslation(verse) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      action: 'translateText',
      text: verse.text,
      targetLang: state.autoTranslateLang,
      reference: verse.reference || null,
      autoBroadcast: true,
    })
  );
}

// AJOUT : export du dernier récap de fin de culte en fichier .txt
// téléchargeable, pour le partager sans avoir à copier-coller le texte
// affiché dans le panneau IA.
export function exportPostServiceRecap() {
  if (!state.lastPostServiceRecap) {
    if (!requireWsOrWarn()) return;
    renderAiEnricherOutput('⏳ Génération du récapitulatif avant export...');
    ws.send(JSON.stringify({ action: 'getPostServiceRecap' }));
    showToast(
      'Récap en cours de génération — cliquez à nouveau sur Exporter dans quelques secondes.',
      'info'
    );
    return;
  }
  const r = state.lastPostServiceRecap;
  const lines = [
    r.title || 'Récap du culte',
    '='.repeat((r.title || 'Récap du culte').length),
    '',
    'Points clés :',
    ...(r.keyPoints || []).map((p) => `- ${p}`),
    '',
    `Application : ${r.application || '—'}`,
    `Verset à retenir : ${r.memoryVerse || '—'}`,
    '',
    `Exporté le ${new Date().toLocaleString()}`,
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recap-culte-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Récap exporté.', 'success');
}

export function renderPreServiceCheckResult(message) {
  const btn = document.getElementById('preServiceCheckBtn');
  const resultsEl = document.getElementById('preServiceCheckResults');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '✅ Tester avant le culte';
  }
  if (!resultsEl) return;

  function row(label, ok, detail) {
    const icon = ok ? '✅' : '⚠️';
    return `<div class="preflight-row">
                    <span class="preflight-row-label">${icon} ${label}</span>
                    <span class="preflight-row-status ${ok ? 'ok' : 'warn'}">${detail || (ok ? 'OK' : 'Problème')}</span>
                </div>`;
  }

  const groqDetail =
    message.groq && message.groq.configured
      ? message.groq.ok
        ? 'Clé valide'
        : `Erreur : ${message.groq.error}`
      : 'Non configurée';
  const deepgramDetail =
    message.deepgram && message.deepgram.configured
      ? message.deepgram.ok
        ? 'Clé valide'
        : `Erreur : ${message.deepgram.error}`
      : 'Non configurée (optionnel)';
  const authDetail = message.wsAuthEnabled ? 'Activée' : `Désactivée (hôte : ${message.wsHost})`;

  // AJOUT (checkup — un seul endroit pour vérifier tout ce qui a été ajouté
  // cette session, pas seulement la transcription). Poster principal et
  // logo restent des fonctionnalités OPTIONNELLES : leur absence n'est pas
  // un "problème" (pas de ⚠️), juste une information — seule la base
  // biblique hors-ligne et la caméra téléphone ont un état réellement
  // actionnable (à télécharger / à configurer WS_HOST).
  const offlineBibleDetail =
    {
      done: 'Téléchargée',
      downloading: 'Téléchargement en cours…',
      error: 'Échec — vérifiez la connexion',
      idle: 'Non démarrée (secours réseau utilisé si besoin)',
    }[message.offlineBibleStatus] || 'Statut inconnu';

  resultsEl.innerHTML =
    row('Connexion WebSocket', true, 'Connecté') +
    row('Clé Groq (transcription principale)', !!(message.groq && message.groq.ok), groqDetail) +
    row(
      'Clé Deepgram (secours)',
      !message.deepgram || message.deepgram.ok || !message.deepgram.configured,
      deepgramDetail
    ) +
    row('Authentification WebSocket', true, authDetail) +
    row(
      'Médiathèque',
      true,
      message.mediaLibraryCount ? `${message.mediaLibraryCount} média(s)` : 'Aucun média ajouté'
    ) +
    row(
      'Poster principal',
      true,
      message.hasDefaultPoster ? 'Configuré' : 'Non configuré (écran vide entre les versets)'
    ) +
    row(
      'Habillage caméra (logo)',
      true,
      message.brandingLogoConfigured ? 'Configuré' : 'Non configuré'
    ) +
    row('Base biblique hors-ligne', message.offlineBibleStatus === 'done', offlineBibleDetail) +
    row(
      'Caméra téléphone (QR)',
      message.qrCameraReady,
      message.qrCameraReady ? 'Prêt' : 'Nécessite un serveur accessible sur le réseau (WS_HOST)'
    ) +
    row(
      'Caméras IP actives',
      true,
      message.ipCameraCount ? `${message.ipCameraCount} caméra(s)` : 'Aucune'
    ) +
    `<div class="preflight-note">
                    ⚠️ Le microphone n'est pas vérifié ici — voir "Statut Capture Micro" ci-dessus.
                </div>`;
  resultsEl.style.display = 'block';

  const groqOk = !message.groq || message.groq.ok;
  showToast(
    groqOk ? 'Vérification pré-culte terminée.' : 'Vérification terminée — vérifiez Groq.',
    groqOk ? 'success' : 'warning'
  );
}

window.runPreServiceCheck = runPreServiceCheck;
window.requestSermonTheme = requestSermonTheme;
window.requestLiveSummary = requestLiveSummary;
window.requestAiStats = requestAiStats;
window.requestCrossReferences = requestCrossReferences;
window.requestLiveTranslation = requestLiveTranslation;
window.requestPostServiceRecap = requestPostServiceRecap;
window.requestSessionStats = requestSessionStats;
window.exportHighlights = exportHighlights;
window.refreshDisplays = refreshDisplays;
window.openDisplayWindow = openDisplayWindow;
window.closeDisplayWindow = closeDisplayWindow;
window.sendStageMessage = sendStageMessage;
window.clearStageMessage = clearStageMessage;
window.requestArchiveSearch = requestArchiveSearch;
window.askSermonQuestion = askSermonQuestion;
window.exportPostServiceRecap = exportPostServiceRecap;
window.onAutoTranslateToggle = onAutoTranslateToggle;
window.onAutoTranslateLangChange = onAutoTranslateLangChange;
window.onHighContrastToggle = onHighContrastToggle;
window.onCaptionsToggle = onCaptionsToggle;
window.onTranslatedCaptionsToggle = onTranslatedCaptionsToggle;
window.onTestPatternToggle = onTestPatternToggle;
