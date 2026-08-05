/**
 * dashboard.js — Interface opérateur (tableau de bord)
 *
 * Extrait de dashboard.html (chantier de découpage du 2026-08-05) : ce
 * fichier était auparavant un <script> inline de ~1660 lignes. Comportement
 * identique — seulement déplacé dans un fichier externe pour rendre le
 * fichier navigable, chargé via <script src="dashboard.js"> dans
 * dashboard.html.
 *
 * NOTE ESLint : de nombreuses fonctions ci-dessous (setLanguage, setMood,
 * clearTranscript, etc.) semblent "jamais utilisées" à ESLint car il analyse
 * ce fichier isolément — en réalité, dashboard.html les appelle via des
 * attributs onclick="..." inline (certains statiques dans le HTML, d'autres
 * générés dynamiquement dans ce fichier même via des template strings, ex.
 * moveQueueItem/setMoodTheme dans le rendu de liste). C'est le même modèle
 * que le reste du projet (overlay.html, setup.html) — pas une régression
 * introduite par l'extraction.
 */
/* eslint-disable no-unused-vars -- voir note ci-dessus : fonctions
   appelées depuis des attributs onclick="..." en HTML, invisibles à
   l'analyse statique d'un fichier isolé. */

// State Management
const state = {
  totalVerses: 0,
  detectionRate: 100,
  activeLanguage: 'FR',
  sessionStartTime: Date.now(),
  transcripts: [],
  currentVerse: null,
  // AJOUT (mode culte + traduction live + export récap)
  autoTranslateEnabled: false,
  autoTranslateLang: 'en',
  lastPostServiceRecap: null,
};

// AJOUT : intervalle d'auto-détection du mode de culte (louange, prédication,
// prière, annonces...). Tourne toutes les 2 minutes en tâche de fond une fois
// le WebSocket connecté ; volontairement peu fréquent pour ne pas multiplier
// les appels IA inutilement. unref() n'existe pas côté navigateur (pas besoin :
// la page se ferme avec l'onglet, pas de process Node à libérer ici).
const SERMON_MODE_INTERVAL_MS = 120000;
let sermonModeTimer = null;

function startSermonModeAutoDetect() {
  if (sermonModeTimer) return;
  sermonModeTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'getSermonTheme', silent: true }));
    }
  }, SERMON_MODE_INTERVAL_MS);
}

function stopSermonModeAutoDetect() {
  if (sermonModeTimer) {
    clearInterval(sermonModeTimer);
    sermonModeTimer = null;
  }
}

// Navigation tab switching
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    item.classList.add('active');

    document.querySelectorAll('.section').forEach((s) => (s.style.display = 'none'));
    const targetSec = document.getElementById(item.dataset.section);
    if (targetSec) targetSec.style.display = 'block';
  });
});

// Dynamic WebSocket connection URL
// CORRECTIF (bug "app tout le temps déconnectée") : le token n'était
// jamais transmis à la connexion WebSocket. En Electron, main.js
// injecte ?token=... via l'option `query` de loadFile() ; on le
// relit ici depuis l'URL de la PAGE (pas celle du WebSocket).
//
// SECURITY (backend audit) : le token n'est plus ajouté en ?token=
// sur l'URL WebSocket elle-même — un reverse proxy / CDN placé
// devant un serveur exposé au réseau journalise typiquement l'URI
// de requête, ce qui aurait exposé le jeton en clair dans ces logs.
// Il voyage maintenant via l'en-tête de handshake
// Sec-WebSocket-Protocol (2e argument du constructeur WebSocket),
// que les proxys ne journalisent pas par défaut.
const getWsToken = () => new URLSearchParams(window.location.search).get('token');
const getWsUrl = () => {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return `ws://localhost:8765`;
};

let ws = null;
let reconnectAttempts = 0;
// CORRECTIF (bug de production signalé — "l'application reste
// déconnectée et je ne peux rien faire") : `maxReconnectAttempts`
// faisait ABANDONNER toute tentative de reconnexion après 10 essais
// (~90s de backoff cumulé), contrairement à overlay.html qui retente
// indéfiniment toutes les 3s. Si le serveur redémarrait ou avait un
// simple hoquet de plus de 90s (mise à jour, redémarrage Electron,
// pic de charge), le dashboard restait bloqué déconnecté pour de bon
// — seul un rechargement manuel de la page pouvait le réparer.
// On retente maintenant indéfiniment, avec le même backoff plafonné
// à 10s qu'avant, sans jamais s'arrêter.
let reconnectTimer = null;

function initWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    const token = getWsToken();
    ws = token ? new WebSocket(getWsUrl(), [token]) : new WebSocket(getWsUrl());
  } catch (e) {
    console.error('Erreur création WebSocket :', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('Connecté au serveur ChurchOverlay');
    updateStatus(true);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // AJOUT : (re)démarre l'auto-détection du mode de culte à chaque
    // connexion/reconnexion — pas d'effet si déjà démarré (voir
    // startSermonModeAutoDetect, protégé contre le double-démarrage).
    startSermonModeAutoDetect();
    // AJOUT (innovation frontend — sélecteur d'ambiances) : le serveur
    // sait déjà répondre à 'getMoods' (ai-theme-generator.js) mais rien
    // côté dashboard ne le demandait jusqu'ici. On récupère la liste à
    // chaque connexion pour peupler les boutons dynamiquement plutôt
    // que de coder les moods en dur (ils pourraient changer côté serveur).
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'getMoods' }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch (e) {
      console.error("Échec de l'analyse du message WebSocket :", e);
    }
  };

  ws.onerror = (err) => {
    console.error('Erreur WebSocket :', err);
    updateStatus(false);
  };

  ws.onclose = () => {
    console.log('Déconnecté du serveur ChurchOverlay');
    updateStatus(false);
    stopSermonModeAutoDetect();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectAttempts++;
  const delay = Math.min(2000 * reconnectAttempts, 10000);
  updateStatus(false, reconnectAttempts);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWebSocket();
  }, delay);
}

initWebSocket();

// ==================================================================
// CORRECTIF (problème signalé — "parler sans appuyer sur activer le
// micro ne bougeait pas et ne passait pas") : la capture micro
// RÉELLE qui alimente le pipeline de détection (Web Audio -> PCM16
// -> window.churchOverlay.sendAudioChunk() -> worker -> Whisper/
// Groq/Deepgram -> detector.js -> bible-lookup) avait été introduite
// le 26/07/2026 (commit 44f2000) puis intégralement supprimée trois
// jours plus tard lors d'une grosse réécriture du fichier (commit
// 890dde9), sans que rien ne la remplace depuis. Résultat : aucun
// bouton de ce dashboard ne déclenchait plus la capture réelle —
// parler au micro ne "passait" plus du tout, peu importe le bouton
// pressé, car rien n'appelait plus sendAudioChunk().
//
// Comme à l'origine, cette capture démarre AUTOMATIQUEMENT dès que
// le pipeline serveur signale qu'il est prêt (onAudioPipelineReady)
// — ce n'est PAS un bouton à activer manuellement, exactement comme
// avant la régression.
//
// Le graphique de flux audio disparu en même temps est restauré ici
// aussi (canvas #audioVisualizer déjà présent dans le HTML), mais
// branché sur ce VRAI flux micro plutôt que sur l'ancienne dictée
// du navigateur (bouton "Démarrer le Micro" ci-dessous) qui, elle,
// ne fonctionne pas dans Electron (voir commentaire plus bas sur
// recognition.onerror : limitation connue de Chromium embarqué,
// sans lien avec le pipeline réel de détection de versets).
// ==================================================================
let realMicCaptureState = null; // { stream, audioCtx, sourceNode, processorNode, silentGain, analyser }
let realVisualizerAnimId = null;

function downsampleBuffer(buffer, sampleRate, outSampleRate) {
  if (outSampleRate === sampleRate) return buffer;
  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function drawRealAudioVisualizer() {
  const canvas = document.getElementById('audioVisualizer');
  if (!canvas || !realMicCaptureState) return;
  const ctx = canvas.getContext('2d');
  const analyserNode = realMicCaptureState.analyser;
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  // Dégradé calculé une seule fois (voir correctif de lenteur UI
  // plus bas dans le fichier pour visualizeAudio() — même piège
  // évité ici : pas de createLinearGradient() par frame).
  const barGradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
  barGradient.addColorStop(0, '#6366f1');
  barGradient.addColorStop(1, '#06b6d4');

  function draw() {
    if (!realMicCaptureState) return; // capture arrêtée entre-temps
    realVisualizerAnimId = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(dataArray);

    ctx.fillStyle = 'rgba(17, 24, 39, 0.4)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = barGradient;

    const barWidth = (canvas.width / bufferLength) * 2.2;
    let barHeight;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      barHeight = dataArray[i] / 2.5;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
      x += barWidth + 1;
    }
  }
  draw();
}

async function startRealAudioCapture() {
  if (realMicCaptureState) return; // déjà démarrée (ex: double signal ready)

  try {
    const settings = window.churchOverlay ? await window.churchOverlay.getSettings() : null;
    const deviceId = settings && settings.audioDevice;

    // echoCancellation/noiseSuppression/autoGainControl désactivés :
    // ces traitements Chromium visent la visioconférence, pas la
    // fidélité maximale attendue par un moteur de transcription —
    // signal le plus brut possible vers Whisper/Groq/Deepgram.
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const sourceNode = audioCtx.createMediaStreamSource(stream);

    const processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(input, audioCtx.sampleRate, 16000);
      const pcm16 = floatTo16BitPCM(downsampled);
      if (window.churchOverlay) window.churchOverlay.sendAudioChunk(pcm16.buffer);
    };

    // Un ScriptProcessorNode ne déclenche son callback que s'il
    // est connecté à une destination — un GainNode à volume 0
    // satisfait cette exigence sans renvoyer le son du micro
    // vers les haut-parleurs (pas d'écho/larsen).
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    // AnalyserNode dédié pour le graphique de flux — branché sur
    // le vrai signal micro, pas sur la dictée navigateur.
    const analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    sourceNode.connect(analyserNode);

    realMicCaptureState = {
      stream,
      audioCtx,
      sourceNode,
      processorNode,
      silentGain,
      analyser: analyserNode,
    };
    console.log('[dashboard] Capture micro réelle démarrée automatiquement (pipeline prêt).');
    addActivity('Capture micro démarrée automatiquement', 'success');
    drawRealAudioVisualizer();
  } catch (err) {
    console.error('[dashboard] Échec démarrage capture micro réelle:', err);
    showToast('❌ Micro : ' + (err && err.message ? err.message : err), 'error');
  }
}

function stopRealAudioCapture() {
  if (realVisualizerAnimId) {
    cancelAnimationFrame(realVisualizerAnimId);
    realVisualizerAnimId = null;
  }
  if (!realMicCaptureState) return;
  try {
    realMicCaptureState.sourceNode.disconnect();
    realMicCaptureState.processorNode.disconnect();
    realMicCaptureState.silentGain.disconnect();
    realMicCaptureState.analyser.disconnect();
    realMicCaptureState.stream.getTracks().forEach((t) => t.stop());
    realMicCaptureState.audioCtx.close();
  } catch (_) {
    /* nettoyage best-effort à la fermeture */
  }
  realMicCaptureState = null;
  const canvas = document.getElementById('audioVisualizer');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

if (window.churchOverlay && window.churchOverlay.onAudioPipelineReady) {
  window.churchOverlay.onAudioPipelineReady(startRealAudioCapture);
}
window.addEventListener('beforeunload', stopRealAudioCapture);

// --- Bannière d'erreur pipeline (voir CORRECTIF plus haut dans le HTML) ---
function setPipelineAlert(payload) {
  const banner = document.getElementById('pipelineAlertBanner');
  const icon = document.getElementById('pipelineAlertIcon');
  const msg = document.getElementById('pipelineAlertMessage');
  if (!banner || !msg) return;

  if (!payload || payload.clear) {
    banner.style.display = 'none';
    return;
  }

  const isError = (payload.severity || 'warning') === 'error';
  banner.style.background = isError ? 'rgba(244, 63, 94, 0.12)' : 'rgba(124, 140, 245, 0.12)';
  banner.style.border = `1px solid ${isError ? 'var(--accent-rose)' : '#7c8cf5'}`;
  banner.style.display = 'flex';
  if (icon) icon.textContent = isError ? '⛔' : '⚠️';
  msg.textContent = payload.message || 'Le pipeline a rencontré un problème.';
}

if (window.churchOverlay && window.churchOverlay.onPipelineAlert) {
  window.churchOverlay.onPipelineAlert(setPipelineAlert);
}

// Au chargement, on récupère aussi l'état courant (utile si l'alerte a
// été émise avant que le tableau de bord ait fini de charger).
if (window.churchOverlay && window.churchOverlay.getStatus) {
  window.churchOverlay
    .getStatus()
    .then((s) => {
      if (s && s.status === 'error') {
        setPipelineAlert({
          severity: 'error',
          message:
            'Le pipeline audio est arrêté après plusieurs erreurs. Cliquez sur "Redémarrer le pipeline".',
        });
      }
    })
    .catch(() => {});
}

let restartInFlight = false;
async function restartPipeline() {
  if (restartInFlight || !window.churchOverlay || !window.churchOverlay.requestRestart) return;
  restartInFlight = true;
  showToast('Redémarrage du pipeline en cours...', 'info');
  try {
    await window.churchOverlay.requestRestart();
    showToast('Pipeline redémarré', 'success');
  } catch (e) {
    showToast('Échec du redémarrage : ' + (e && e.message ? e.message : e), 'error');
  } finally {
    restartInFlight = false;
  }
}

function handleMessage(message) {
  switch (message.action) {
    case 'showVerse':
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
      break;
    case 'hideVerse':
      hideVerseDisplay();
      addActivity('Verset masqué', 'info');
      break;
    case 'transcript':
      addTranscript(message);
      break;
    case 'candidateVerse':
      showCandidateVerse(message);
      addActivity(`Verset candidat : ${message.reference}`, 'warning');
      break;
    case 'error':
      addActivity(`Erreur : ${message.error}`, 'error');
      showToast(`Erreur : ${message.error}`, 'error');
      break;
    case 'transcriptionError':
      addActivity(`Transcription indisponible : ${message.error}`, 'error');
      showToast(`Transcription en échec — vérifier la connexion internet`, 'error');
      break;
    case 'audioError':
      addActivity(`Capture audio interrompue : ${message.error}`, 'error');
      showToast(`Micro/audio en échec — vérifier la capture`, 'error');
      break;
    case 'preServiceCheckResult':
      renderPreServiceCheckResult(message);
      break;
    // CORRECTIF (audit round 6) : réponses des modules ai-enricher.js,
    // jusqu'ici sans destination côté dashboard (les WS envoyaient bien
    // ces actions, mais rien n'écoutait la réponse).
    case 'sermonTheme':
      // AJOUT : les requêtes auto (silent:true, voir startSermonModeAutoDetect)
      // mettent seulement à jour le badge, sans polluer le panneau de sortie
      // manuel avec un texte qui change toutes les 2 minutes.
      updateSermonModeBadge(message);
      if (!message.silent) {
        renderAiEnricherOutput(
          message.theme
            ? `Thème détecté : ${message.theme}${message.keywords ? ' — mots-clés : ' + message.keywords.join(', ') : ''}`
            : 'Aucun thème identifiable pour le moment (transcription encore trop courte).'
        );
      }
      break;
    case 'liveSummary':
      renderAiEnricherOutput(
        message.summary ? `Résumé : ${message.summary}` : 'Résumé indisponible pour le moment.'
      );
      break;
    case 'crossReferences':
      renderAiEnricherOutput(
        message.results && message.results.length
          ? `Références croisées pour ${message.reference} : ` +
              message.results
                .map((r) => `${r.ref}${r.reason ? ' (' + r.reason + ')' : ''}`)
                .join(' · ')
          : `Aucune référence croisée trouvée pour ${message.reference || 'ce verset'}.`
      );
      break;
    case 'textTranslated':
      // Le broadcast vers l'overlay (action showTranslation) est fait
      // directement par le serveur quand autoBroadcast est vrai (voir
      // requestAutoTranslation) — ici on ne fait qu'afficher côté dashboard.
      if (!message.autoBroadcast) {
        renderAiEnricherOutput(`Traduction (${message.targetLang}) : ${message.translation}`);
      }
      break;
    case 'postServiceRecap':
      // AJOUT : on garde le dernier récap en mémoire pour permettre
      // l'export en .txt sans le régénérer si l'opérateur clique export
      // juste après avoir cliqué "Récap fin de culte".
      state.lastPostServiceRecap = message.recap || null;
      renderAiEnricherOutput(
        message.recap
          ? `${message.recap.title || 'Récap du culte'} — Points clés : ${(message.recap.keyPoints || []).join(', ')}. ` +
              `Application : ${message.recap.application || '—'}. Verset à retenir : ${message.recap.memoryVerse || '—'}.`
          : 'Récap indisponible.'
      );
      break;
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

/* ======================================================================
           Sélecteur d'ambiances (moods)
           ====================================================================== */
function renderMoodPicker(moods) {
  const container = document.getElementById('moodPicker');
  if (!container) return;
  if (!moods.length) {
    container.innerHTML =
      '<span style="font-size:0.8rem; color:var(--text-dim);">Générateur d\'ambiances indisponible.</span>';
    return;
  }
  container.innerHTML = moods
    .map(
      (m) => `
                <button class="mood-btn" id="mood-btn-${m.id}" onclick="setMoodTheme('${m.id}')" title="${m.name}">
                    ${m.name}
                </button>
            `
    )
    .join('');
}

function setMoodTheme(mood) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible de changer l'ambiance.", 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setMoodTheme', mood }));
}

function setActiveMoodButton(mood) {
  document.querySelectorAll('.mood-btn').forEach((btn) => btn.classList.remove('active'));
  const active = document.getElementById(`mood-btn-${mood}`);
  if (active) active.classList.add('active');
}

/* ======================================================================
           File d'attente de versets (innovation frontend, inspirée de Rhema) :
           permet à l'opérateur de préparer à l'avance les versets d'une
           prédication (recherche manuelle) et de les envoyer un par un au bon
           moment, plutôt que de taper chaque référence en direct. Purement
           côté dashboard — réutilise l'action 'showVerse' déjà supportée par
           le serveur, aucun changement serveur nécessaire.
           ====================================================================== */
const verseQueue = [];

function addToQueue() {
  const input = document.getElementById('queueRefInput');
  const reference = input ? input.value.trim() : '';
  if (!reference) return;
  verseQueue.push({ id: Date.now() + Math.random(), reference });
  if (input) input.value = '';
  renderQueue();
}

function removeFromQueue(id) {
  const idx = verseQueue.findIndex((v) => v.id === id);
  if (idx !== -1) verseQueue.splice(idx, 1);
  renderQueue();
}

function moveQueueItem(id, direction) {
  const idx = verseQueue.findIndex((v) => v.id === id);
  const target = idx + direction;
  if (idx === -1 || target < 0 || target >= verseQueue.length) return;
  [verseQueue[idx], verseQueue[target]] = [verseQueue[target], verseQueue[idx]];
  renderQueue();
}

function sendQueueItem(id) {
  const item = verseQueue.find((v) => v.id === id);
  if (!item) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'envoyer le verset.", 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'showVerse', reference: item.reference }));
  addActivity(`Verset envoyé depuis la file : ${item.reference}`, 'info');
  removeFromQueue(id);
}

function sendNextInQueue() {
  if (verseQueue.length === 0) {
    showToast("File d'attente vide.", 'info');
    return;
  }
  sendQueueItem(verseQueue[0].id);
}

function renderQueue() {
  const list = document.getElementById('queueList');
  const countEl = document.getElementById('queueCount');
  if (countEl) countEl.textContent = verseQueue.length;
  if (!list) return;

  if (verseQueue.length === 0) {
    list.innerHTML =
      '<div style="font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucun verset en attente. Ajoutez une référence ci-dessus.</div>';
    return;
  }

  list.innerHTML = verseQueue
    .map(
      (item, i) => `
                <div class="queue-item">
                    <span class="queue-item-position">${i + 1}</span>
                    <span class="queue-item-ref">${escapeHtmlDashboard(item.reference)}</span>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="moveQueueItem(${item.id}, -1)" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button class="queue-icon-btn" onclick="moveQueueItem(${item.id}, 1)" title="Descendre" ${i === verseQueue.length - 1 ? 'disabled' : ''}>↓</button>
                        <button class="queue-icon-btn queue-send" onclick="sendQueueItem(${item.id})" title="Envoyer maintenant">▶</button>
                        <button class="queue-icon-btn queue-remove" onclick="removeFromQueue(${item.id})" title="Retirer">✕</button>
                    </div>
                </div>
            `
    )
    .join('');
}

function escapeHtmlDashboard(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

renderQueue();

// CORRECTIF (checklist mise en production, point 9) : bouton "Tester avant
// le culte" — envoie une demande de vérification au serveur (connexion WS,
// validité des clés Groq/Deepgram) et affiche le résultat sans quitter le
// tableau de bord.
function runPreServiceCheck() {
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
function renderAiEnricherOutput(text) {
  const el = document.getElementById('aiEnricherOutput');
  if (el) el.innerHTML = `<span class="stat-label">${text}</span>`;
}

function requireWsOrWarn() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible de lancer l'analyse IA.", 'error');
    return false;
  }
  return true;
}

function requestSermonTheme() {
  if (!requireWsOrWarn()) return;
  renderAiEnricherOutput('⏳ Analyse du thème en cours...');
  ws.send(JSON.stringify({ action: 'getSermonTheme' }));
}

function requestLiveSummary() {
  if (!requireWsOrWarn()) return;
  renderAiEnricherOutput('⏳ Génération du résumé en cours...');
  ws.send(JSON.stringify({ action: 'getLiveSummary' }));
}

function requestCrossReferences() {
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

function requestLiveTranslation() {
  if (!requireWsOrWarn()) return;
  const verse = state.currentVerse;
  if (!verse || !verse.text) {
    renderAiEnricherOutput('Aucun texte de verset à traduire pour le moment.');
    return;
  }
  renderAiEnricherOutput('⏳ Traduction en cours...');
  ws.send(JSON.stringify({ action: 'translateText', text: verse.text, targetLang: 'en' }));
}

function requestPostServiceRecap() {
  if (!requireWsOrWarn()) return;
  renderAiEnricherOutput('⏳ Génération du récapitulatif...');
  ws.send(JSON.stringify({ action: 'getPostServiceRecap' }));
}

// AJOUT : badge de mode de culte auto-détecté (Louange / Prédication /
// Prière / Annonces...). Le texte de `theme` provient de detectSermonTheme
// côté ai-enricher.js ; on l'affiche tel quel sans le réinterpréter pour
// rester cohérent avec ce que l'IA a réellement détecté.
function updateSermonModeBadge(message) {
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
function onAutoTranslateToggle() {
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

function onAutoTranslateLangChange() {
  const select = document.getElementById('autoTranslateLang');
  state.autoTranslateLang = select ? select.value : 'en';
  if (state.autoTranslateEnabled && state.currentVerse && state.currentVerse.text) {
    requestAutoTranslation(state.currentVerse);
  }
}

function requestAutoTranslation(verse) {
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
function exportPostServiceRecap() {
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

function renderPreServiceCheckResult(message) {
  const btn = document.getElementById('preServiceCheckBtn');
  const resultsEl = document.getElementById('preServiceCheckResults');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '✅ Tester avant le culte';
  }
  if (!resultsEl) return;

  function row(label, ok, detail) {
    const icon = ok ? '✅' : '⚠️';
    const color = ok ? 'var(--accent-emerald, #10b981)' : 'var(--accent-amber, #7c8cf5)';
    return `<div style="display:flex; justify-content:space-between; gap:0.75rem; padding: 0.35rem 0;">
                    <span>${icon} ${label}</span>
                    <span style="color:${color}; text-align:right;">${detail || (ok ? 'OK' : 'Problème')}</span>
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

  resultsEl.innerHTML =
    row('Connexion WebSocket', true, 'Connecté') +
    row('Clé Groq (transcription principale)', !!(message.groq && message.groq.ok), groqDetail) +
    row(
      'Clé Deepgram (secours)',
      !message.deepgram || message.deepgram.ok || !message.deepgram.configured,
      deepgramDetail
    ) +
    row('Authentification WebSocket', true, authDetail) +
    `<div style="font-size:0.75rem; color: var(--text-dim); margin-top:0.5rem;">
                    ⚠️ Le microphone n'est pas vérifié ici — voir "Statut Reconnaissance Vocale" ci-dessus.
                </div>`;
  resultsEl.style.display = 'block';

  const groqOk = !message.groq || message.groq.ok;
  showToast(
    groqOk ? 'Vérification pré-culte terminée.' : 'Vérification terminée — vérifiez Groq.',
    groqOk ? 'success' : 'warning'
  );
}

function displayVerse(message) {
  const refEl = document.getElementById('verseReference');
  const textEl = document.getElementById('verseText');
  const bilingualEl = document.getElementById('verseTextBilingual');
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
}

function hideVerseDisplay() {
  const refEl = document.getElementById('verseReference');
  const textEl = document.getElementById('verseText');
  const bilingualEl = document.getElementById('verseTextBilingual');
  if (refEl) refEl.textContent = 'Aucun verset affiché';
  if (textEl) textEl.textContent = 'Les versets apparaîtront ici une fois détectés';
  if (bilingualEl) {
    bilingualEl.textContent = '';
    bilingualEl.style.display = 'none';
  }
  state.currentVerse = null;
}

function addTranscript(message) {
  const feed = document.getElementById('transcriptFeed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = 'transcript-item';

  const time = new Date(message.timestamp || Date.now()).toLocaleTimeString();
  item.innerHTML = `
                <div class="transcript-time"><span>${time}</span><span>${message.source || 'Audio'}</span></div>
                <div class="transcript-text">${message.text}</div>
            `;

  feed.insertBefore(item, feed.firstChild);

  while (feed.children.length > 50) {
    feed.removeChild(feed.lastChild);
  }

  state.transcripts.unshift(message);
  if (state.transcripts.length > 50) state.transcripts.pop();
}

function showCandidateVerse(message) {
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

function updateAnalysis(message) {
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
function setMetricValue(id, value, suffix = '') {
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

function updateMLStats(message) {
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

function updateDashboard() {
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

function updateStatus(connected, reconnectAttempt) {
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
function sendCustomSpeechText(customText) {
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

function showManualVerse() {
  const reference = prompt('Entrez une référence biblique (ex. Jean 3:16) :');
  if (reference) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'showVerse',
          reference: reference,
        })
      );
      addActivity(`Recherche manuelle : ${reference}`, 'info');
      showToast(`Affichage de ${reference}...`, 'info');
    }
  }
}

function hideVerse() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'hideVerse' }));
    addActivity('Verset masqué', 'info');
    showToast('Verset masqué', 'info');
  }
}

function pauseTimer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'pauseTimer' }));
    showToast('Timer mis en pause', 'warning');
  }
}

function resumeTimer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'resumeTimer' }));
    showToast('Timer repris', 'success');
  }
}

function emergencyStop() {
  if (confirm("Confirmez-vous l'arrêt d'urgence de l'affichage ?")) {
    hideVerse();
    addActivity("Arrêt d'urgence déclenché", 'error');
    showToast("Arrêt d'urgence activé", 'error');
  }
}

function setLanguage(lang) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setLanguage', language: lang }));
  }
  state.activeLanguage = lang.toUpperCase();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  updateDashboard();
}

function setAnimation(animation) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        action: 'applyAnimation',
        animation: animation,
        options: { duration: parseInt(document.getElementById('animationDuration').value) },
      })
    );
  }
  addActivity(`Animation changée: ${animation}`, 'info');
  showToast(`Animation: ${animation}`, 'success');
}

function setMood(mood) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setMood', mood: mood }));
  }

  // Update active button state
  document.querySelectorAll('.mood-btn').forEach((btn) => {
    btn.classList.remove('active');
    if (btn.dataset.mood === mood) {
      btn.classList.add('active');
    }
  });

  addActivity(`Ambiance changée: ${mood}`, 'info');
  showToast(`Ambiance: ${mood}`, 'success');
}

function setAnimationDuration(duration) {
  document.getElementById('durationValue').textContent = `${duration}ms`;
}

function clearTranscript() {
  const feed = document.getElementById('transcriptFeed');
  if (feed) {
    feed.innerHTML = `
                    <div class="transcript-item">
                        <div class="transcript-time"><span>00:00:00</span><span>Info</span></div>
                        <div class="transcript-text" style="color: var(--text-dim);">Historique effacé. En attente de nouvelles entrées audio.</div>
                    </div>
                `;
  }
  state.transcripts = [];
  showToast('Transcription effacée', 'info');
}

setInterval(updateDashboard, 1000);

// Speech Recognition setup
let recognition = null;
let isListening = false;
let audioContext = null;
let analyser = null;
let microphone = null;
let animationId = null;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechStatus = document.getElementById('speechStatus');

if (SpeechRecognition) {
  if (speechStatus) {
    speechStatus.textContent = 'Disponible';
    speechStatus.className = 'status-badge success';
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'fr-FR';

  recognition.onresult = (event) => {
    networkErrorStreak = 0;
    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      }
    }

    if (finalTranscript) {
      ws.send(
        JSON.stringify({
          action: 'transcript',
          text: finalTranscript,
          timestamp: Date.now(),
          source: 'browser',
        })
      );

      addTranscript({
        text: finalTranscript,
        timestamp: Date.now(),
        source: 'Voix',
      });
    }
  };

  let restartTimeout = null;
  // Nombre d'échecs 'network' consécutifs. Dans Electron, le
  // moteur webkitSpeechRecognition de Chromium n'a pas la clé
  // API Google interne dont il a besoin pour joindre le service
  // en ligne : l'erreur 'network' y est donc permanente, pas un
  // problème de connexion passager (voir electron/electron#46143
  // et issues similaires ouvertes depuis 2016, jamais résolues).
  // Sans ce compteur, onend relançait recognition.start() toutes
  // les secondes indéfiniment dès que "Arrêter le Micro" n'était
  // pas cliqué — boucle infinie inutile qui consommait du CPU en
  // arrière-plan pour un badge qui n'aurait jamais annoncé autre
  // chose que "tentative...".
  let networkErrorStreak = 0;
  const NETWORK_ERROR_GIVE_UP = 3;

  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    if (event.error === 'network') {
      networkErrorStreak++;
      console.warn('Reconnaissance vocale : problème de connexion réseau.');
      if (networkErrorStreak < NETWORK_ERROR_GIVE_UP) {
        if (speechStatus) {
          speechStatus.textContent = 'Réseau (tentative...)';
          speechStatus.className = 'status-badge warning';
        }
        return;
      }
      console.error(
        "Reconnaissance vocale du navigateur indisponible dans l'application " +
          "(limitation connue d'Electron : le moteur de dictée intégré à Chromium " +
          "n'a pas accès au service en ligne de Google). Utilisez le pipeline " +
          'micro → Whisper/Groq/Deepgram intégré à ChurchOverlay à la place.'
      );
      if (speechStatus) {
        speechStatus.textContent = "Indisponible dans l'app";
        speechStatus.className = 'status-badge error';
      }
      showToast(
        'La dictée du navigateur ne fonctionne pas dans ChurchOverlay (limitation ' +
          'Electron). Utilisez le pipeline micro intégré (Whisper/Groq/Deepgram).',
        'error'
      );
      stopSpeechRecognition();
      return;
    }
    console.error('Erreur de reconnaissance vocale :', event.error);
    if (event.error === 'not-allowed') {
      if (speechStatus) {
        speechStatus.textContent = 'Permission refusée';
        speechStatus.className = 'status-badge error';
      }
      stopSpeechRecognition();
    }
  };

  recognition.onend = () => {
    if (isListening) {
      clearTimeout(restartTimeout);
      restartTimeout = setTimeout(() => {
        if (isListening) {
          try {
            recognition.start();
          } catch (e) {}
        }
      }, 1000);
    }
  };
} else {
  if (speechStatus) {
    speechStatus.textContent = 'Non prise en charge';
    speechStatus.className = 'status-badge error';
  }
  const btn = document.getElementById('speechBtn');
  if (btn) btn.disabled = true;
}

function toggleSpeechRecognition() {
  if (isListening) {
    stopSpeechRecognition();
  } else {
    startSpeechRecognition();
  }
}

async function startSpeechRecognition() {
  if (!recognition) {
    alert("La reconnaissance vocale n'est pas prise en charge par votre navigateur.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    analyser.fftSize = 256;

    visualizeAudio();

    recognition.start();
    isListening = true;

    const btn = document.getElementById('speechBtn');
    if (btn) btn.classList.add('active');
    const btnText = document.getElementById('speechBtnText');
    if (btnText) btnText.textContent = 'Arrêter le Micro';

    addActivity('Microphone activé', 'success');
    showToast('Écoute vocale démarrée', 'success');
  } catch (error) {
    console.error('Erreur microphone :', error);
    showToast("Impossible d'accéder au microphone", 'error');
  }
}

function stopSpeechRecognition() {
  if (recognition) recognition.stop();
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  isListening = false;

  const btn = document.getElementById('speechBtn');
  if (btn) btn.classList.remove('active');
  const btnText = document.getElementById('speechBtnText');
  if (btnText) btnText.textContent = 'Démarrer le Micro';

  const canvas = document.getElementById('audioVisualizer');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  addActivity('Microphone désactivé', 'info');
  showToast('Écoute vocale arrêtée', 'info');
}

function visualizeAudio() {
  const canvas = document.getElementById('audioVisualizer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  // CORRECTIF (lenteur UI signalée) : le dégradé était recréé avec
  // ctx.createLinearGradient() pour CHAQUE barre, à CHAQUE frame
  // (~128 barres x 60fps = plusieurs milliers d'allocations/seconde).
  // Ce churn saturait le garbage collector du processus Electron en
  // continu, ce qui rendait tout le thread principal saccadé —
  // dashboard ET overlay, qui partagent le même processus.
  // Le dégradé ne dépend que de la hauteur du canvas (fixe), donc
  // on le calcule une seule fois hors de la boucle de dessin.
  const barGradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
  barGradient.addColorStop(0, '#6366f1');
  barGradient.addColorStop(1, '#06b6d4');

  function draw() {
    animationId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    ctx.fillStyle = 'rgba(17, 24, 39, 0.4)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = barGradient;

    const barWidth = (canvas.width / bufferLength) * 2.2;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = dataArray[i] / 2.5;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
      x += barWidth + 1;
    }
  }
  draw();
}

function refreshOverlay() {
  const frame = document.getElementById('overlayFrame');
  if (frame) {
    const url = new URL(frame.src, window.location.href);
    url.searchParams.set('_refresh', Date.now());
    frame.src = url.toString();
  }
  showToast('Aperçu Overlay rafraîchi', 'info');
}

function showToast(message, type = 'info', duration = 3000) {
  const container = document.querySelector('.toast-container') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '⚠️';
  if (type === 'warning') icon = '⚡';

  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, duration);
}

function createToastContainer() {
  const container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

function addActivity(title, type = 'info') {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = 'activity-item';
  const time = new Date().toLocaleTimeString();

  item.innerHTML = `
                <div class="activity-icon ${type}">•</div>
                <div class="activity-content">
                    <div class="activity-title">${title}</div>
                    <div class="activity-time">${time}</div>
                </div>
            `;

  feed.insertBefore(item, feed.firstChild);

  while (feed.children.length > 20) {
    feed.removeChild(feed.lastChild);
  }
}

// ---------------------------------------------------------------
// Paramètres — Clés API & Microphone
// ---------------------------------------------------------------
// window.churchOverlay n'existe que dans la fenêtre Electron (exposé
// par preload.js). Si ce fichier est ouvert directement dans un
// navigateur (mode "serveur seul"), le panneau se désactive proprement
// au lieu d'échouer silencieusement sur des appels IPC inexistants.
(function initApiSettingsPanel() {
  const els = {
    unavailable: document.getElementById('apiSettingsUnavailable'),
    form: document.getElementById('apiSettingsForm'),
    card: document.getElementById('apiSettingsCard'),
    banner: document.getElementById('setupBanner'),
    requiredBadge: document.getElementById('setupRequiredBadge'),
    micSelect: document.getElementById('settingsMicSelect'),
    micStatus: document.getElementById('settingsMicStatus'),
    btnRefreshMic: document.getElementById('settingsBtnRefreshMic'),
    groqInput: document.getElementById('settingsGroqKey'),
    groqBadge: document.getElementById('groqKeyBadge'),
    deepgramInput: document.getElementById('settingsDeepgramKey'),
    deepgramBadge: document.getElementById('deepgramKeyBadge'),
    geminiInput: document.getElementById('settingsGeminiKey'),
    geminiBadge: document.getElementById('geminiKeyBadge'),
    btnSave: document.getElementById('settingsBtnSave'),
    saveStatus: document.getElementById('settingsSaveStatus'),
    btnClearGroq: document.getElementById('settingsClearGroq'),
    btnClearDeepgram: document.getElementById('settingsClearDeepgram'),
    btnClearGemini: document.getElementById('settingsClearGemini'),
  };

  if (!els.form) return; // section absente de ce build, rien à faire

  if (!window.churchOverlay) {
    if (els.unavailable) els.unavailable.style.display = 'block';
    return;
  }

  function setBadge(el, configured) {
    if (!el) return;
    el.style.display = 'inline-block';
    el.textContent = configured ? '✓ Configurée' : 'Non configurée';
    el.className = 'status-badge ' + (configured ? 'success' : 'warning');
  }

  async function loadMicrophones(preselectId) {
    els.micStatus.className = 'field-hint';
    els.micStatus.textContent = '';
    els.micSelect.innerHTML = '<option value="">🔍 Recherche des microphones…</option>';
    els.btnRefreshMic.disabled = true;

    let devices;
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((t) => t.stop());
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      devices = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Microphone (nom indisponible)' }));
    } catch (err) {
      els.btnRefreshMic.disabled = false;
      els.micSelect.innerHTML = '<option value="">❌ Accès micro refusé</option>';
      els.micStatus.className = 'field-hint';
      els.micStatus.style.color = 'var(--accent-rose)';
      const isPermissionError =
        err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      els.micStatus.textContent = isPermissionError
        ? "⚠️ Autorisation micro refusée (Windows → Confidentialité → Microphone). Cliquez sur Actualiser après avoir autorisé l'accès."
        : `⚠️ Erreur : ${err && err.message ? err.message : err}`;
      return;
    }

    els.btnRefreshMic.disabled = false;
    els.micSelect.innerHTML = '';

    if (devices.length === 0) {
      els.micSelect.innerHTML = '<option value="">❌ Aucun microphone détecté</option>';
      els.micStatus.style.color = 'var(--accent-rose)';
      els.micStatus.textContent =
        "⚠️ Vérifiez qu'un micro est branché, puis cliquez sur Actualiser.";
      return;
    }

    devices.forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      els.micSelect.appendChild(opt);
    });

    if (preselectId && devices.some((d) => d.id === preselectId)) {
      els.micSelect.value = preselectId;
    }

    els.micStatus.style.color = 'var(--accent-emerald)';
    els.micStatus.textContent = `✅ ${devices.length} microphone(s) détecté(s)`;
  }

  async function refreshSettingsUi() {
    const settings = await window.churchOverlay.getSettings();
    setBadge(els.groqBadge, settings.hasGroqKey);
    setBadge(els.deepgramBadge, settings.hasDeepgramKey);
    setBadge(els.geminiBadge, settings.hasGeminiKey);

    const needsSetup = !!settings.needsSetup;
    els.card.classList.toggle('needs-setup', needsSetup);
    els.requiredBadge.style.display = needsSetup ? 'inline-block' : 'none';
    els.banner.style.display = needsSetup ? 'flex' : 'none';

    await loadMicrophones(settings.audioDevice);

    // Au premier lancement (ou tant qu'il manque le micro/la clé
    // Groq), on ouvre directement l'onglet Paramètres pour que la
    // configuration soit visible sans action supplémentaire —
    // qu'elle soit ensuite complétée manuellement par la personne
    // ou déjà pré-remplie automatiquement par une config existante.
    if (needsSetup) {
      const settingsNav = document.querySelector('.nav-item[data-section="settings"]');
      if (settingsNav) settingsNav.click();
    }

    return settings;
  }

  els.form.style.display = 'block';

  els.btnRefreshMic.addEventListener('click', () => loadMicrophones(els.micSelect.value));

  document.querySelectorAll('.settings-copy-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      navigator.clipboard.writeText(url).then(() => {
        const original = link.textContent;
        link.textContent = 'Lien copié ✓';
        setTimeout(() => {
          link.textContent = original;
        }, 2000);
      });
    });
  });

  document.querySelectorAll('.btn-toggle-pass').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      const show = target.type === 'password';
      target.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Masquer' : 'Afficher';
    });
  });

  async function clearKey(provider, inputEl, badgeEl) {
    const label = provider === 'groq' ? 'Groq' : provider === 'deepgram' ? 'Deepgram' : 'Gemini';
    if (!confirm(`Retirer la clé API ${label} enregistrée ?`)) return;
    try {
      await window.churchOverlay.clearApiKey(provider);
      inputEl.value = '';
      setBadge(badgeEl, false);
      showToast(`Clé ${label} retirée`, 'info');
      if (provider === 'groq') await refreshSettingsUi();
    } catch (e) {
      showToast(`Erreur lors du retrait de la clé ${label}`, 'error');
    }
  }

  if (els.btnClearGroq) {
    els.btnClearGroq.addEventListener('click', () =>
      clearKey('groq', els.groqInput, els.groqBadge)
    );
  }
  if (els.btnClearDeepgram) {
    els.btnClearDeepgram.addEventListener('click', () =>
      clearKey('deepgram', els.deepgramInput, els.deepgramBadge)
    );
  }
  if (els.btnClearGemini) {
    els.btnClearGemini.addEventListener('click', () =>
      clearKey('gemini', els.geminiInput, els.geminiBadge)
    );
  }

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const mic = els.micSelect.value;
    if (!mic) {
      els.saveStatus.style.color = 'var(--accent-rose)';
      els.saveStatus.textContent = "⚠️ Sélectionnez un microphone avant d'enregistrer.";
      return;
    }

    els.btnSave.disabled = true;
    const originalLabel = els.btnSave.textContent;
    els.btnSave.textContent = '⏳ Enregistrement…';
    els.saveStatus.textContent = '';

    try {
      // Champs laissés vides = conserver la clé déjà enregistrée
      // (voir saveConfigAsync côté main.js) ; utiliser « Retirer
      // la clé » pour un retrait volontaire.
      await window.churchOverlay.saveSetup(
        mic,
        els.groqInput.value.trim(),
        els.deepgramInput.value.trim(),
        els.geminiInput.value.trim()
      );
      els.groqInput.value = '';
      els.deepgramInput.value = '';
      els.geminiInput.value = '';
      els.saveStatus.style.color = 'var(--accent-emerald)';
      els.saveStatus.textContent = '✅ Configuration enregistrée — pipeline (re)démarré.';
      showToast('Configuration API enregistrée', 'success');
      await refreshSettingsUi();
    } catch (err) {
      els.saveStatus.style.color = 'var(--accent-rose)';
      els.saveStatus.textContent = '❌ Erreur : ' + (err && err.message ? err.message : err);
    } finally {
      els.btnSave.disabled = false;
      els.btnSave.textContent = originalLabel;
    }
  });

  refreshSettingsUi();
})();

// CORRECTIF PERF (audit CPU, 03/08/2026) : voir le commentaire CSS sur
// .animations-paused plus haut dans <style>. On considère la fenêtre
// "au repos" dès qu'elle est masquée (onglet caché / minimisée) OU
// qu'elle perd le focus (opérateur basculé sur OBS pendant tout le
// culte) — les deux cas sont fréquents en régie et n'ont aucune
// raison de garder des animations décoratives actives en continu.
(function setupAmbientAnimationThrottle() {
  function applyState() {
    const shouldPause = document.hidden || !document.hasFocus();
    document.body.classList.toggle('animations-paused', shouldPause);
  }
  document.addEventListener('visibilitychange', applyState);
  window.addEventListener('blur', applyState);
  window.addEventListener('focus', applyState);
  applyState();
})();

// RETIRÉ (sur demande) : l'écouteur pointermove qui pilotait le halo
// suivant le curseur sur .card/.hero-verse-card a été supprimé, en
// même temps que les règles CSS .card::after / .hero-verse-card::before
// correspondantes.

// AJOUT : onde au clic (voir .btn-ripple dans <style>). Délégué sur
// le document, ne crée un élément que sur un vrai clic, et le
// retire dès que l'animation "forwards" se termine (aucun élément
// ni timer qui s'accumule au fil d'un long culte).
(function setupButtonRipple() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.4;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  });
})();
