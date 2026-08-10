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

export function displayVerse(message) {
  const refEl = document.getElementById('verseReference');
  const textEl = document.getElementById('verseText');
  const bilingualEl = document.getElementById('verseTextBilingual');
  // AJOUT (redesign visuel — carte verset en direct) : jusqu'ici cette
  // carte avait le même aspect qu'un verset soit réellement à l'écran
  // devant l'assemblée ou non — .live-badge affichait "Diffusion Overlay
  // En Direct" en permanence, sans lien avec l'état réel. .is-live donne
  // une confirmation visuelle immédiate (voir .hero-verse-card.is-live
  // dans dashboard.css), retirée par hideVerseDisplay() ci-dessous.
  const heroCard = document.getElementById('verseDisplay');
  if (heroCard) heroCard.classList.add('is-live');
  if (refEl) refEl.textContent = message.reference;
  if (textEl) textEl.textContent = message.text;
  // CORRECTIF (bilingue dashboard) : jusqu'ici seule verseReference
  // recevait le texte bilingue ("Jean 3:16 · John 3:16") construit
  // côté serveur ; verseText n'affichait que message.text (FR), et
  // message.text_en n'était jamais lu. Même condition que
  // overlay.html : langMode === 'both' ET texte EN réellement reçu.
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
}

export function addTranscript(message) {
  const feed = document.getElementById('transcriptFeed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = 'transcript-item';

  // CORRECTIF (audit production — XSS) : message.text vient soit du moteur
  // STT (Groq/Deepgram, jamais passé par le filtre <>">' appliqué aux
  // SEULS messages entrants côté serveur), soit d'un client déjà
  // authentifié opérateur. escapeHtmlDashboard() existait déjà mais
  // n'était jamais appliqué ici, le point d'entrée le plus direct entre
  // "parole captée" et innerHTML.
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

export function showCandidateVerse(message) {
  console.log('Verset candidat (correspondance floue) détecté :', message);
  const el = document.getElementById('fuzzyMatchNotice');
  if (el && message.original) {
    el.textContent = `Correction automatique : "${message.original}" → livre "${message.reference.book || message.reference}" (distance ${message.distance || 1})`;
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
