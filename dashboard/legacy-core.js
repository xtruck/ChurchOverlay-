/**
 * dashboard/legacy-core.js — Interface opérateur (tableau de bord)
 *
 * ÉTAT DE TRANSITION (chantier de modularisation "dashboard/", front end
 * plus léger/mieux construit) : ce fichier est l'ancien dashboard.js déplacé
 * tel quel, chargé maintenant via dashboard/main.js (import './legacy-core.js')
 * en <script type="module">, plutôt que l'ancien <script src="dashboard.js">
 * classique. Comportement identique pour l'instant — voir le bloc
 * `window.x = x` en fin de fichier pour pourquoi (exposition explicite
 * requise, un module ne rend rien global par défaut contrairement à un
 * script classique). Les lots suivants démantèlent ce fichier en modules
 * dédiés sous dashboard/features/* ; il rétrécit à chaque lot.
 *
 * NOTE ESLint : de nombreuses fonctions ci-dessous (setLanguage,
 * clearTranscript, etc.) sont appelées par dashboard.html via des attributs
 * onclick="..." inline (certains statiques dans le HTML, d'autres générés
 * dynamiquement dans ce fichier même via des template strings, ex.
 * moveQueueItem/setMoodTheme dans le rendu de liste), invisibles à l'analyse
 * statique d'un fichier isolé. Contrairement à l'ancien dashboard.js (un
 * <script> classique, où ces fonctions étaient globales par défaut), le
 * bloc `window.x = x` en fin de fichier les rend explicitement globales ET
 * donne à ESLint une vraie référence de lecture pour chacune — plus besoin
 * du désactivateur `no-unused-vars` que ce fichier portait auparavant.
 */

// AJOUT (modularisation, lot 4) : showToast/addActivity/escapeHtmlDashboard/
// requireWsOrWarn ont déménagé dans dashboard/utils.js — importés ici car
// le reste de ce fichier les appelle encore par leur nom nu (même portée
// partagée qu'avant l'extraction).
import { showToast, addActivity, escapeHtmlDashboard, requireWsOrWarn } from './utils.js';
// AJOUT (modularisation, lot 5) : import CIRCULAIRE assumé et sûr —
// verse-session-display.js importe state/ws depuis CE fichier (voir plus
// bas), et ce fichier importe ses fonctions ici. Sûr uniquement parce que
// tous les usages de state/ws dans verse-session-display.js sont à
// l'intérieur de corps de fonction (jamais évalués immédiatement à
// l'import) — au moment où l'une de ces fonctions s'exécute réellement
// (WS reçu, clic opérateur...), tout le graphe de modules a fini de se
// charger et state/ws sont déjà initialisés.
import {
  displayVerse,
  hideVerseDisplay,
  addTranscript,
  showCandidateVerse,
  updateDashboard,
  updateStatus,
  updateMicButtonUI,
} from './features/verse-session-display.js';

// State Management
// AJOUT (modularisation, lot 5) : exporté pour verse-session-display.js —
// un seul objet partagé, muter une propriété depuis l'import reste visible
// partout (aucun wrapper nécessaire, contrairement à ws qui est réassigné).
export const state = {
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
  // AJOUT (audit — lien OBS manquant) : URL file:// avec jeton
  // WS_VIEWER_TOKEN, poussée par main.js (voir applyOverlayUrl).
  overlayUrl: null,
  // AJOUT (habillage caméra) : même mécanisme, pour branding-overlay.html.
  brandingOverlayUrl: null,
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
//
// CORRECTIF (audit — tableau de bord "trop rempli") : 6 onglets séparés
// regroupés en 2 vues ("En Direct" / "Réglages"), chacune affichant
// PLUSIEURS <section> existantes ensemble plutôt qu'une seule — aucune
// section n'a été déplacée ni son id changé, donc tout le reste du
// câblage (getElementById, WS handlers...) continue de fonctionner sans
// modification. item.dataset.sections (pluriel, liste séparée par des
// virgules) remplace l'ancien item.dataset.section (singulier, une seule
// section à la fois).
function showSectionsFor(item) {
  document.querySelectorAll('.section').forEach((s) => (s.style.display = 'none'));
  const targetIds = (item.dataset.sections || '').split(',').filter(Boolean);
  targetIds.forEach((id) => {
    const targetSec = document.getElementById(id);
    if (targetSec) targetSec.style.display = 'block';
  });
}

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    item.classList.add('active');
    showSectionsFor(item);
  });
});

// Applique l'état initial (l'onglet marqué "active" dans le HTML, "En
// Direct" par défaut) dès le chargement — sans ça, seule la section
// "overview" (sans display:none en dur) serait visible au démarrage,
// alors que "transcript" (micro/transcription) fait aussi partie du
// groupe "En Direct" mais reste display:none tant qu'aucun clic n'a eu
// lieu.
const initialNavItem = document.querySelector('.nav-item.active');
if (initialNavItem) showSectionsFor(initialNavItem);

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
// CORRECTIF (bug "overlay hors ligne par défaut" — même famille pour le
// dashboard) : ce port était codé en dur (8765) et ignorait le paramètre
// ?port=... que main.js transmet pourtant via l'option `query` de
// loadFile() (voir main.js > mainWindow.loadFile). Ça fonctionnait par
// coïncidence tant que PORT restait à sa valeur par défaut (8765,
// justement), mais silencieusement plus dès que PORT était personnalisé
// dans .env — le dashboard tentait alors de se connecter au mauvais port
// sans qu'aucune erreur explicite n'indique pourquoi. Aligné sur le même
// pattern que overlay.html (getWsPort()), qui lisait déjà correctement ce
// paramètre.
const getWsPort = () => new URLSearchParams(window.location.search).get('port') || '8765';
const getWsUrl = () => {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return `ws://localhost:${getWsPort()}`;
};

// CORRECTIF (bug production — logo d'habillage caméra invisible dans le
// tableau de bord, "Failed to load resource: /C:/branding/..."). Ce
// tableau de bord est chargé en file:// dans Electron (pas via le
// serveur Express), donc un chemin racine-relatif comme "/branding/xxx"
// (renvoyé tel quel par le serveur, voir server.js > logoUrl) se
// résolvait contre la racine du disque au lieu du serveur HTTP local —
// même famille de bug que getWsUrl() ci-dessus pour le WebSocket.
const getHttpOrigin = () => {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    return window.location.origin;
  }
  return `http://localhost:${getWsPort()}`;
};

// AJOUT (modularisation, lot 4) : exporté pour que dashboard/utils.js
// (requireWsOrWarn) y accède en lecture seule — liaison "live" ES module,
// voir son commentaire d'en-tête. Seul CE fichier réassigne ws.
export let ws = null;
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
      // AJOUT (médiathèque) : la liste vit côté serveur (le déclenchement
      // vocal doit y accéder même sans tableau de bord ouvert) — récupérée
      // à chaque connexion/reconnexion pour rester synchronisée.
      ws.send(JSON.stringify({ action: 'getMediaLibrary' }));
      // AJOUT (bibliothèque de chants) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getSongLibrary' }));
      // AJOUT (caméras de téléphone) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getIpCameras' }));
      // AJOUT (habillage caméra) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getBranding' }));
      // AJOUT (base biblique hors-ligne) : un seul statut suffit à la
      // connexion ; pollOfflineBibleStatusUntilDone() prend le relais si un
      // téléchargement est en cours (voir plus bas).
      ws.send(JSON.stringify({ action: 'getOfflineBibleStatus' }));
      // AJOUT (carte réseau) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getNetworkStatus' }));
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
// AJOUT (modularisation, lot 5) : exporté — toggleRealMicCapture() a
// déménagé dans verse-session-display.js mais reste couplé à l'état de
// capture micro, pas encore extrait (voir plan, lot parqué "audio-capture.js").
export let realMicCaptureState = null; // { stream, audioCtx, sourceNode, compressor, processorNode, silentGain, analyser }
let realVisualizerAnimId = null;

function drawRealAudioVisualizer() {
  const canvas = document.getElementById('audioVisualizer');
  if (!canvas || !realMicCaptureState) return;
  const ctx = canvas.getContext('2d');
  const analyserNode = realMicCaptureState.analyser;
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  let barGradient = null;
  let lastWidth = -1;
  let lastHeight = -1;

  // CORRECTIF (audit — "pas de courbe audio visible") : ce canvas vit dans
  // l'onglet "Transcript", masqué (display:none) par défaut. La capture
  // micro démarre automatiquement dès que le pipeline est prêt — souvent
  // avant que l'opérateur n'ait cliqué sur cet onglet. canvas.offsetWidth/
  // offsetHeight valent 0 pour un élément caché : canvas.width/height
  // n'étaient fixés qu'une seule fois, ici, AVANT la boucle draw() —
  // figés à 0x0 pour toujours, même une fois l'onglet affiché ensuite,
  // car rien ne les recalculait après coup. Revérifié à chaque frame
  // (comparaison bon marché) pour s'auto-corriger dès que le canvas
  // redevient visible, au lieu d'un calcul figé une fois pour toutes.
  function ensureCanvasSize() {
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    if (w > 0 && h > 0 && (w !== lastWidth || h !== lastHeight)) {
      canvas.width = w;
      canvas.height = h;
      lastWidth = w;
      lastHeight = h;
      // Le dégradé dépend de la hauteur : recalculé seulement quand la
      // taille change réellement, pas à chaque frame.
      barGradient = ctx.createLinearGradient(0, h, 0, 0);
      barGradient.addColorStop(0, '#6366f1');
      barGradient.addColorStop(1, '#06b6d4');
    }
  }

  function draw() {
    if (!realMicCaptureState) return; // capture arrêtée entre-temps
    realVisualizerAnimId = requestAnimationFrame(draw);
    ensureCanvasSize();
    if (!barGradient) return; // toujours masqué : rien à dessiner pour l'instant

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

export async function startRealAudioCapture() {
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

    // AJOUT (audio — protection contre la saturation en cas de cri) : le
    // gate de bruit dans audio-capture-worklet.js atténue le bruit de fond
    // FAIBLE (voir son commentaire d'en-tête, qui exclut explicitement les
    // pics forts — l'inverse de ce qu'il faut ici) ; rien jusqu'ici ne
    // protégeait contre l'écrêtage numérique d'une voix criée, qui sature
    // deux fois (le micro, puis le clamp dur à ±1 dans
    // _downsampleAndSend() du worklet). Valeurs par défaut de la spec Web
    // Audio pour DynamicsCompressorNode — seuil à -24dBFS, bien au-dessus
    // du GATE_THRESHOLD (0.015 ≈ -36dBFS) du gate, donc les passages calmes
    // traversent quasiment inchangés.
    const compressorNode = audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = -24;
    compressorNode.knee.value = 30;
    compressorNode.ratio.value = 12;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.25;

    // CORRECTIF (dépréciation DevTools "ScriptProcessorNode is deprecated,
    // use AudioWorkletNode instead") : createScriptProcessor() tourne sur
    // le thread principal (celui de l'UI) et peut le bloquer sous charge.
    // Un AudioWorkletNode délègue le traitement à audio-capture-worklet.js,
    // exécuté sur le thread audio dédié du navigateur ; la conversion
    // PCM16/downsampling y est réimplémentée (un AudioWorkletProcessor
    // tourne dans un scope global séparé, sans accès aux fonctions de
    // cette page).
    await audioCtx.audioWorklet.addModule('audio-capture-worklet.js');
    const processorNode = new AudioWorkletNode(audioCtx, 'pcm-capture-processor');
    processorNode.port.onmessage = (event) => {
      if (window.churchOverlay) window.churchOverlay.sendAudioChunk(event.data);
    };
    // Synchronise l'état du gate avec la case à cocher (utile si le micro
    // redémarre — ex. changement de périphérique — alors que l'opérateur
    // avait déjà désactivé la réduction de bruit ; le worklet, lui, repart
    // toujours activé par défaut à sa création).
    const gateCheckbox = document.getElementById('noiseGateToggle');
    processorNode.port.postMessage({ gateEnabled: !gateCheckbox || gateCheckbox.checked });

    // Comme pour l'ancien ScriptProcessorNode, le graphe doit atteindre la
    // destination pour que le noeud reste actif — un GainNode à volume 0
    // satisfait cette exigence sans renvoyer le son du micro vers les
    // haut-parleurs (pas d'écho/larsen).
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(compressorNode);
    compressorNode.connect(processorNode);
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
      compressor: compressorNode,
      processorNode,
      silentGain,
      analyser: analyserNode,
    };
    console.log('[dashboard] Capture micro réelle démarrée automatiquement (pipeline prêt).');
    addActivity('Capture micro démarrée automatiquement', 'success');
    drawRealAudioVisualizer();
    updateMicButtonUI();
  } catch (err) {
    console.error('[dashboard] Échec démarrage capture micro réelle:', err);
    showToast('❌ Micro : ' + (err && err.message ? err.message : err), 'error');
    updateMicButtonUI();
  }
}

export function stopRealAudioCapture() {
  if (realVisualizerAnimId) {
    cancelAnimationFrame(realVisualizerAnimId);
    realVisualizerAnimId = null;
  }
  if (!realMicCaptureState) return;
  try {
    realMicCaptureState.sourceNode.disconnect();
    realMicCaptureState.compressor.disconnect();
    realMicCaptureState.processorNode.port.onmessage = null;
    realMicCaptureState.processorNode.port.close();
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

// AJOUT (filtre audio — recommandation "filtres audio" façon OBS) : active/
// désactive l'expandeur/gate de bruit du worklet (voir audio-capture-worklet.js)
// sans redémarrer la capture — juste un message sur le MessagePort déjà ouvert.
function toggleNoiseGate() {
  const checkbox = document.getElementById('noiseGateToggle');
  const enabled = !!(checkbox && checkbox.checked);
  if (realMicCaptureState && realMicCaptureState.processorNode) {
    realMicCaptureState.processorNode.port.postMessage({ gateEnabled: enabled });
  }
  addActivity(enabled ? 'Réduction de bruit activée' : 'Réduction de bruit désactivée', 'info');
}

// AJOUT (aperçu en direct — recommandation "prévisualisation" façon OBS) :
// iframe de overlay.html chargée à la demande, avec le même jeton/port que
// ce tableau de bord (getWsToken/getWsPort, déjà utilisés pour la propre
// connexion WebSocket de ce fichier). Fermée (src vidée) quand l'opérateur
// masque l'aperçu, pour ne pas garder une connexion WebSocket inutile
// ouverte en arrière-plan.
function toggleLivePreview() {
  const wrap = document.getElementById('livePreviewWrap');
  const frame = document.getElementById('livePreviewFrame');
  const btn = document.getElementById('livePreviewToggleBtn');
  if (!wrap || !frame || !btn) return;

  const currentlyShown = wrap.style.display !== 'none';
  if (currentlyShown) {
    wrap.style.display = 'none';
    frame.src = 'about:blank';
    btn.textContent = "👁 Afficher l'aperçu";
    return;
  }

  const token = getWsToken();
  const port = getWsPort();
  const query = token ? `?token=${encodeURIComponent(token)}&port=${encodeURIComponent(port)}` : '';
  frame.src = 'overlay.html' + query;
  wrap.style.display = 'block';
  btn.textContent = "🙈 Masquer l'aperçu";
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

// AJOUT (audit — état de repli visible, session parallèle) : bannière
// distincte de pipelineAlertBanner ci-dessus (qui couvre le crash-loop du
// worker) — celle-ci se résorbe automatiquement dès qu'une transcription
// réussit (voir action 'pipelineHealth'), sans bouton de redémarrage : la
// retry est déjà automatique côté serveur (voir transcribeWithRetry() dans
// server.js). Palette alignée sur setPipelineAlert ci-dessus.
function setTranscriptionHealth(payload) {
  const banner = document.getElementById('transcriptionHealthBanner');
  const icon = document.getElementById('transcriptionHealthIcon');
  const msg = document.getElementById('transcriptionHealthMessage');
  if (!banner || !msg) return;

  if (!payload || payload.status === 'ok') {
    banner.style.display = 'none';
    return;
  }

  const isDegraded = payload.status === 'degraded';
  banner.style.background = isDegraded ? 'rgba(244, 63, 94, 0.12)' : 'rgba(124, 140, 245, 0.12)';
  banner.style.border = `1px solid ${isDegraded ? 'var(--accent-rose)' : '#7c8cf5'}`;
  banner.style.display = 'flex';
  if (icon) icon.textContent = isDegraded ? '⛔' : '⚠️';
  msg.textContent = isDegraded
    ? `Transcription en difficulté (${payload.consecutiveFailures || 1} échec(s) d'affilée) — nouvelle tentative automatique en cours.`
    : `Nouvelle tentative de transcription (${payload.attempt}/${payload.maxAttempts})...`;
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
      if (s && s.overlayUrl) applyOverlayUrl(s.overlayUrl);
      if (s && s.brandingOverlayUrl) applyBrandingOverlayUrl(s.brandingOverlayUrl);
    })
    .catch(() => {});
}

// CORRECTIF (audit — "je ne vois plus le lien à coller dans OBS") :
// main.js calcule déjà overlayUrl (avec le jeton WS_VIEWER_TOKEN requis
// depuis que l'authentification WebSocket est générée automatiquement à
// chaque démarrage) et le pousse via l'évènement IPC 'status-update' —
// preload.js exposait déjà onStatusUpdate(), mais dashboard.js ne
// l'écoutait jamais. Résultat : ce lien n'était affiché NULLE PART dans
// l'interface, y compris l'aperçu iframe de l'onglet "Overlay" (chargé
// sans jeton, donc lui-même incapable de se connecter au serveur).
function applyOverlayUrl(url) {
  if (!url || url === state.overlayUrl) return;
  state.overlayUrl = url;
  const input = document.getElementById('overlayUrlInput');
  if (input) input.value = url;
  const frame = document.getElementById('overlayFrame');
  if (frame && !frame.dataset.loadedWithToken) {
    frame.src = url;
    frame.dataset.loadedWithToken = '1';
  }
}

function copyOverlayUrl() {
  if (!state.overlayUrl) {
    showToast('Lien overlay pas encore disponible — attendez que le pipeline démarre.', 'error');
    return;
  }
  navigator.clipboard
    .writeText(state.overlayUrl)
    .then(() => {
      showToast(
        "Lien copié — collez-le dans OBS comme URL d'une Source Navigateur (Browser Source)",
        'success'
      );
    })
    .catch(() => {
      showToast(
        'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
        'error'
      );
    });
}

// AJOUT (habillage caméra) : même mécanisme que applyOverlayUrl() ci-dessus,
// pour le lien de branding-overlay.html (Source Navigateur OBS séparée, à
// empiler au-dessus de la caméra).
function applyBrandingOverlayUrl(url) {
  if (!url || url === state.brandingOverlayUrl) return;
  state.brandingOverlayUrl = url;
  const input = document.getElementById('brandingOverlayUrlInput');
  if (input) input.value = url;
}

function copyBrandingOverlayUrl() {
  if (!state.brandingOverlayUrl) {
    showToast('Lien pas encore disponible — attendez que le pipeline démarre.', 'error');
    return;
  }
  navigator.clipboard
    .writeText(state.brandingOverlayUrl)
    .then(() => {
      showToast(
        'Lien copié — collez-le dans OBS comme Source Navigateur, au-dessus de la caméra',
        'success'
      );
    })
    .catch(() => {
      showToast(
        'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
        'error'
      );
    });
}

if (window.churchOverlay && window.churchOverlay.onStatusUpdate) {
  window.churchOverlay.onStatusUpdate((payload) => {
    if (payload && payload.overlayUrl) applyOverlayUrl(payload.overlayUrl);
    if (payload && payload.brandingOverlayUrl) applyBrandingOverlayUrl(payload.brandingOverlayUrl);
  });
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
    case 'preServiceCheckResult':
      renderPreServiceCheckResult(message);
      break;
    case 'networkStatus':
      renderNetworkStatus(message);
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
    case 'sessionStats':
      renderSessionStats(message);
      break;
    case 'highlightsExported':
      renderHighlightsExport(message);
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

// AJOUT (audit — affichage/sortie, gratuit/léger, session parallèle) :
// motif de fond CSS (voir #pattern-layer dans overlay.html) — indépendant
// de l'ambiance. Même schéma déterministe que setActiveMoodButton (id
// plutôt que l'objet event global, plus robuste).
function setBackgroundPattern(pattern) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible de changer le motif.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setBackgroundPattern', pattern }));
  document
    .querySelectorAll('#patternPicker .mood-btn')
    .forEach((btn) => btn.classList.remove('active'));
  const active = document.getElementById(`pattern-btn-${pattern}`);
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

renderQueue();

/* ======================================================================
   Médiathèque (déclenchement vocal ou manuel de photos/vidéos, voir
   media-library.js/server.js). Contrairement à la file d'attente de
   versets ci-dessus (purement locale à cet onglet), la liste vit côté
   serveur : le déclenchement vocal doit pouvoir la consulter pendant tout
   le culte, même si aucun tableau de bord n'est ouvert à ce moment-là.
   ====================================================================== */
let mediaLibraryItems = [];

async function addMediaLibraryItem() {
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'ajouter un média.", 'error');
    return;
  }
  try {
    const sourcePath = await window.churchOverlay.pickMediaFile();
    if (!sourcePath) return; // sélection annulée par l'opérateur
    const labelInput = document.getElementById('mediaLabelInput');
    const phrasesInput = document.getElementById('mediaPhrasesInput');
    const loopInput = document.getElementById('mediaLoopInput');
    const durationInput = document.getElementById('mediaDurationInput');
    const styleInput = document.getElementById('mediaStyleInput');
    const label = labelInput ? labelInput.value.trim() : '';
    const triggerPhrases = phrasesInput
      ? phrasesInput.value
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    const includeInLoop = !!(loopInput && loopInput.checked);
    const rawSeconds = durationInput ? durationInput.value.trim() : '';
    const displayDurationMs = rawSeconds ? Math.max(1, Number(rawSeconds)) * 1000 : undefined;
    const transitionStyle = styleInput ? styleInput.value : undefined;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath,
        label,
        triggerPhrases,
        includeInLoop,
        displayDurationMs,
        transitionStyle,
      })
    );
    if (labelInput) labelInput.value = '';
    if (phrasesInput) phrasesInput.value = '';
    if (loopInput) loopInput.checked = false;
    if (durationInput) durationInput.value = '';
    if (styleInput) styleInput.value = 'fade';
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

function triggerMediaLibraryItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'triggerMediaItem', id }));
}

function deleteMediaLibraryItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteMediaItem', id }));
}

function hideMediaNow() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'hideMedia' }));
}

// AJOUT (détails d'affichage média — durée + style d'apparition, pour les
// médias DÉJÀ uploadés, pas seulement au moment de l'ajout).
const MEDIA_STYLE_LABELS = {
  fade: 'Fondu',
  slide: 'Glissement',
  zoom: 'Zoom',
  cut: 'Coupe instantanée',
};

// AJOUT (poster principal — carte dédiée) : simple surface de lecture sur
// mediaLibraryItems, déjà tenu à jour par renderMediaLibrary() ci-dessous —
// aucun nouvel état, aucune nouvelle requête serveur. La source de vérité
// reste isDefault sur chaque item (media-library.js) ; le bouton "Retirer"
// de cette carte réutilise toggleDefaultMediaItem(), déjà utilisé par
// l'étoile ⭐ dans la liste Médiathèque.
function renderDefaultPosterCard(items) {
  const empty = document.getElementById('defaultPosterEmpty');
  const active = document.getElementById('defaultPosterActive');
  const label = document.getElementById('defaultPosterLabel');
  if (!empty || !active || !label) return;

  const defaultItem = (items || []).find((item) => item.isDefault);
  if (defaultItem) {
    label.textContent = `${defaultItem.mediaType === 'video' ? '🎬' : '🖼️'} ${defaultItem.label}`;
    empty.style.display = 'none';
    active.style.display = 'flex';
    active.dataset.id = defaultItem.id;
  } else {
    empty.style.display = 'block';
    active.style.display = 'none';
    delete active.dataset.id;
  }
}

function clearDefaultPosterFromCard() {
  const active = document.getElementById('defaultPosterActive');
  const id = active && active.dataset.id;
  if (!id) return;
  toggleDefaultMediaItem(id, true);
}

function renderMediaLibrary(items) {
  mediaLibraryItems = Array.isArray(items) ? items : [];
  renderDefaultPosterCard(mediaLibraryItems);
  const list = document.getElementById('mediaLibraryList');
  const countEl = document.getElementById('mediaLibraryCount');
  if (countEl) countEl.textContent = mediaLibraryItems.length;
  if (!list) return;

  if (mediaLibraryItems.length === 0) {
    list.innerHTML =
      '<div style="grid-column: 1 / -1; font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucun média ajouté. Choisissez une photo ou une vidéo ci-dessus.</div>';
    return;
  }

  list.innerHTML = mediaLibraryItems
    .map((item) => {
      const phrasesBadges = (item.triggerPhrases || [])
        .map((p) => `<span class="media-item-phrase-badge">${escapeHtmlDashboard(p)}</span>`)
        .join('');
      const durationSec =
        typeof item.displayDurationMs === 'number' ? Math.round(item.displayDurationMs / 1000) : '';
      const styleOptions = Object.entries(MEDIA_STYLE_LABELS)
        .map(
          ([value, styleLabel]) =>
            `<option value="${value}" ${item.transitionStyle === value ? 'selected' : ''}>${styleLabel}</option>`
        )
        .join('');
      // AJOUT (demande explicite — "voir clairement l'image/vidéo") : vraie
      // vignette au lieu d'un simple emoji. filename vient tel quel de
      // media-library.js (jamais une URL absolue) — même correctif de
      // résolution que le logo d'habillage caméra (getHttpOrigin()) : ce
      // tableau de bord tourne en file://, un chemin racine-relatif "/media/..."
      // se résoudrait sinon contre le disque local au lieu du serveur HTTP.
      const thumbUrl = getHttpOrigin() + '/media/' + encodeURIComponent(item.filename || '');
      const thumbMarkup =
        item.mediaType === 'video'
          ? `<video src="${thumbUrl}" muted preload="metadata" playsinline></video>`
          : `<img src="${thumbUrl}" alt="${escapeHtmlDashboard(item.label)}" loading="lazy">`;
      const badges = [
        item.isDefault ? '⭐ Poster' : '',
        item.includeInLoop ? '🔁 Diaporama' : '',
      ].filter(Boolean);
      return `
                <div class="media-gallery-card${item.isDefault ? ' is-default' : ''}">
                    <div class="media-gallery-thumb">
                        ${thumbMarkup}
                        ${badges.map((b) => `<span class="media-gallery-badge">${b}</span>`).join('')}
                    </div>
                    <div class="media-gallery-body">
                        <div class="media-gallery-label" title="${escapeHtmlDashboard(item.label)}">${escapeHtmlDashboard(item.label)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}</div>
                        <div class="media-gallery-details">
                            <input type="number" min="1" step="1" placeholder="s" value="${durationSec}" id="mediaDuration-${item.id}" ${item.isDefault ? 'disabled title="Le poster principal reste affiché en continu — pas de minuterie"' : `title="Durée d'affichage en secondes — vide = pas de minuterie automatique (masquage manuel)"`}>
                            <select id="mediaStyle-${item.id}" title="Style d'apparition à l'écran">
                                ${styleOptions}
                            </select>
                            <button class="queue-icon-btn" onclick="saveMediaItemDetails('${item.id}')" title="Enregistrer la durée/le style">💾</button>
                        </div>
                    </div>
                    <div class="media-gallery-actions">
                        <button class="btn btn-primary" onclick="triggerMediaLibraryItem('${item.id}')" title="Afficher maintenant sur l'overlay">▶ Afficher</button>
                        <button class="queue-icon-btn" onclick="toggleDefaultMediaItem('${item.id}', ${item.isDefault ? 'true' : 'false'})" title="${item.isDefault ? 'Retirer le statut de poster principal' : 'Définir comme poster principal (affiché quand rien d’autre n’est à l’écran)'}">${item.isDefault ? '⭐' : '☆'}</button>
                        <button class="queue-icon-btn queue-remove" onclick="deleteMediaLibraryItem('${item.id}')" title="Supprimer">✕</button>
                    </div>
                </div>
            `;
    })
    .join('');
}

function saveMediaItemDetails(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const durationInput = document.getElementById(`mediaDuration-${id}`);
  const styleSelect = document.getElementById(`mediaStyle-${id}`);
  const rawSeconds = durationInput ? durationInput.value.trim() : '';
  const displayDurationMs = rawSeconds ? Math.max(1, Number(rawSeconds)) * 1000 : null;
  const transitionStyle = styleSelect ? styleSelect.value : 'fade';
  ws.send(JSON.stringify({ action: 'updateMediaItem', id, displayDurationMs, transitionStyle }));
  showToast('Détails d’affichage enregistrés.', 'success');
}

// AJOUT (demande explicite — "poster principal") : affiché automatiquement
// sur l'overlay dès que rien d'autre n'est à l'écran (voir
// maybeShowDefaultMedia() dans overlay.html). Un seul à la fois — le
// marquer en démarque automatiquement un éventuel précédent côté serveur.
function toggleDefaultMediaItem(id, isCurrentlyDefault) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setDefaultMediaItem', id: isCurrentlyDefault ? null : id }));
  showToast(
    isCurrentlyDefault ? 'Poster principal retiré.' : 'Poster principal défini.',
    'success'
  );
}

/* ======================================================================
   Réseau (WS_HOST + statut du jeton WS) — carte "Réseau (caméra téléphone
   par QR)". Décorrélée du gros panneau Clés API (initApiSettingsPanel) :
   un seul champ à lire/écrire, pas besoin de partager son état interne.
   WS_AUTH_TOKEN/WS_VIEWER_TOKEN ne se configurent pas ici — ensureWsToken()
   (main.js) les génère et les persiste déjà tout seul ; cette carte n'en
   affiche que le statut (voir renderNetworkStatus(), alimentée par l'action
   WS 'getNetworkStatus').
   ====================================================================== */
let suggestedLanIp = null;

async function initNetworkCard() {
  if (!window.churchOverlay || !window.churchOverlay.getSettings) return;
  try {
    const settings = await window.churchOverlay.getSettings();
    suggestedLanIp = settings.suggestedLanIp || null;
    const input = document.getElementById('networkWsHostInput');
    if (input && !input.value && settings.wsHost) {
      input.value = settings.wsHost;
    }
  } catch (e) {
    console.error('Impossible de lire les réglages réseau :', e);
  }
}

function useSuggestedLanIp() {
  const input = document.getElementById('networkWsHostInput');
  if (!input) return;
  if (!suggestedLanIp) {
    showToast(
      'Aucune adresse réseau détectée sur ce PC — vérifiez que le Wi-Fi/Ethernet est actif.',
      'error'
    );
    return;
  }
  input.value = suggestedLanIp;
}

function saveNetworkSettings() {
  const input = document.getElementById('networkWsHostInput');
  const value = input ? input.value.trim() : '';
  if (!value) {
    showToast('Renseignez une adresse réseau.', 'error');
    return;
  }
  if (!window.churchOverlay || !window.churchOverlay.saveNetworkSettings) {
    showToast("Réglage réseau indisponible hors de l'application ChurchOverlay.", 'error');
    return;
  }
  window.churchOverlay
    .saveNetworkSettings(value)
    .then(() => {
      showToast('Adresse réseau enregistrée — redémarrage du serveur…', 'success');
      // Le worker redémarre côté main.js (voir save-network-settings) ; la
      // reconnexion WS déclenchera un nouveau 'getNetworkStatus' via
      // ws.onopen, mais on redemande aussi explicitement après un court
      // délai au cas où la reconnexion serait plus lente que ce délai.
      setTimeout(requestNetworkStatus, 2500);
    })
    .catch((err) =>
      showToast("Échec de l'enregistrement : " + (err && err.message ? err.message : err), 'error')
    );
}

function requestNetworkStatus() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'getNetworkStatus' }));
  }
}

function renderNetworkStatus(message) {
  const badge = document.getElementById('networkQrReadyBadge');
  const currentHost = document.getElementById('networkCurrentHost');
  const tokenStatus = document.getElementById('networkTokenStatus');
  if (badge) {
    badge.textContent = message.qrCameraReady ? 'Prêt' : 'Indisponible';
    badge.className = 'status-badge ' + (message.qrCameraReady ? 'success' : 'warning');
  }
  if (currentHost) {
    currentHost.textContent = message.qrCameraReady
      ? message.wsHost
      : `${message.wsHost} (local uniquement)`;
  }
  if (tokenStatus) {
    tokenStatus.textContent = message.wsAuthEnabled
      ? 'généré automatiquement ✓'
      : 'non disponible ⚠️';
  }
}

initNetworkCard();

/* ======================================================================
   Caméras de téléphone (flux MJPEG réseau, voir ip-camera-store.js).
   Distinct de camera-capture.js : pas de navigator.mediaDevices ici — un
   <img> pointé directement sur l'URL du flux réseau. Chromium affiche
   nativement un flux MJPEG (multipart/x-mixed-replace) comme une image
   "vivante", sans librairie ni décodage vidéo ajouté ici. Fonctionne aussi
   en mode "serveur seul" navigateur (pas de dépendance Electron/IPC,
   contrairement au panneau webcam ci-dessus).
   ====================================================================== */
let ipCameraItems = [];
const ipCameraMonitors = {}; // id -> intervalId, nettoyés à chaque ré-rendu

function renderIpCameras(items) {
  ipCameraItems = Array.isArray(items) ? items : [];
  const list = document.getElementById('ipCameraList');
  const countEl = document.getElementById('ipCameraCount');
  if (countEl) countEl.textContent = ipCameraItems.length;
  if (!list) return;

  // Le ré-rendu détruit les <img>/badges existants : on arrête d'abord tout
  // minuteur de reconnexion en cours pour ne pas en accumuler à chaque mise
  // à jour de la liste (ajout/suppression d'une autre caméra, etc.).
  Object.values(ipCameraMonitors).forEach((timerId) => clearInterval(timerId));
  for (const key of Object.keys(ipCameraMonitors)) delete ipCameraMonitors[key];

  if (ipCameraItems.length === 0) {
    list.innerHTML =
      '<div style="font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucune caméra de téléphone ajoutée.</div>';
    return;
  }

  list.innerHTML = ipCameraItems
    .map(
      (item) => `
                <div class="queue-item">
                    <div style="width:120px; height:68px; background:#000; border-radius:6px; overflow:hidden; flex-shrink:0;">
                        <img id="ipcam-img-${item.id}" style="width:100%; height:100%; object-fit:cover;" alt="">
                    </div>
                    <div class="media-item-info">
                        <div class="media-item-label">${escapeHtmlDashboard(item.label)}</div>
                        <span id="ipcam-status-${item.id}" class="status-badge warning">Connexion…</span>
                    </div>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="copyIpCameraUrl('${item.id}')" title="Copier le lien pour OBS">📋</button>
                        <button class="queue-icon-btn queue-remove" onclick="deleteIpCameraItem('${item.id}')" title="Supprimer">✕</button>
                    </div>
                </div>
            `
    )
    .join('');

  for (const item of ipCameraItems) {
    startIpCameraMonitor(item.id, item.url);
  }
}

function startIpCameraMonitor(id, url) {
  const img = document.getElementById(`ipcam-img-${id}`);
  const badge = document.getElementById(`ipcam-status-${id}`);
  if (!img || !badge) return;

  function markOnline() {
    badge.textContent = 'En ligne';
    badge.className = 'status-badge success';
  }
  function markOffline() {
    badge.textContent = 'Hors ligne';
    badge.className = 'status-badge error';
  }

  img.onload = markOnline;
  img.onerror = markOffline;
  img.src = url;

  // CORRECTIF (fiabilité — "En ligne" pouvait rester affiché indéfiniment
  // pour une caméra morte) : un flux MJPEG dont la connexion reste ouverte
  // sans plus jamais pousser d'image ne redéclenche ni onload ni onerror —
  // l'ancien code ne rechargeait QUE si déjà en erreur, donc un téléphone
  // qui perd le Wi-Fi/verrouille son écran en plein culte restait marqué
  // "En ligne" jusqu'à ce que l'opérateur s'en aperçoive autrement. On
  // recharge maintenant PÉRIODIQUEMENT, que le badge soit vert ou rouge —
  // pour une caméra téléphone jumelée par QR, le serveur refuse désormais
  // de répondre si l'image n'est plus fraîche (voir isFrameFresh côté
  // server.js), ce qui fait légitimement échouer ce rechargement et
  // corrige le badge ; pour une caméra IP tierce, une vraie coupure réseau
  // échoue tout aussi légitimement.
  ipCameraMonitors[id] = setInterval(() => {
    img.src = url + (url.includes('?') ? '&' : '?') + '_retry=' + Date.now();
  }, 12000);
}

function addIpCamera() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const labelInput = document.getElementById('ipCameraLabelInput');
  const urlInput = document.getElementById('ipCameraUrlInput');
  const label = labelInput ? labelInput.value.trim() : '';
  const url = urlInput ? urlInput.value.trim() : '';
  if (!url) {
    showToast('Entrez l’adresse du flux (ex. http://192.168.1.50:8080/video).', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'addIpCamera', label, url }));
  if (labelInput) labelInput.value = '';
  if (urlInput) urlInput.value = '';
}

function deleteIpCameraItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteIpCamera', id }));
}

function copyIpCameraUrl(id) {
  const item = ipCameraItems.find((c) => c.id === id);
  if (!item) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(item.url)
      .then(() => showToast('Lien copié — collez-le dans une Source Navigateur OBS.', 'success'))
      .catch(() => showToast(item.url, 'info'));
  } else {
    showToast(item.url, 'info');
  }
}

// AJOUT (caméra téléphone par QR code, demande explicite) : le téléphone
// n'a besoin d'aucune app — il scanne, ouvre phone-camera.html dans son
// propre navigateur, et apparaît automatiquement dans la liste ci-dessus
// (voir POST /phone-camera-pair côté serveur, qui l'ajoute à
// ip-camera-store.js). Le QR encode une URL http://<ip-locale>:<port>/...
// — nécessite donc que le serveur soit accessible sur le réseau (voir le
// message d'erreur clair renvoyé sinon par generateCameraPairing côté serveur).
function generateCameraPairing() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const labelInput = document.getElementById('cameraPairingLabelInput');
  const qualitySelect = document.getElementById('cameraPairingQualitySelect');
  ws.send(
    JSON.stringify({
      action: 'generateCameraPairing',
      label: labelInput ? labelInput.value.trim() : '',
      quality: qualitySelect ? qualitySelect.value : 'medium',
    })
  );
}

function showCameraPairingQr(message) {
  const box = document.getElementById('cameraPairingBox');
  const img = document.getElementById('cameraPairingQr');
  const expiry = document.getElementById('cameraPairingExpiry');
  if (!box || !img) return;

  img.src = message.qrDataUrl;
  box.style.display = 'block';
  if (expiry && typeof message.expiresInMs === 'number') {
    expiry.textContent = `${Math.round(message.expiresInMs / 60000)} minutes`;
  }
  showToast(
    'QR code généré — scannez-le avec le téléphone dans les minutes qui suivent.',
    'success'
  );
}

/* ======================================================================
   Habillage caméra (logo + titre/sous-titre, voir branding-store.js et
   branding-overlay.html). Contrairement au reste de la médiathèque, ce
   n'est PAS une liste — un seul logo, un seul titre/sous-titre actifs à la
   fois, affichés par-dessus la caméra dans OBS via une Source Navigateur
   séparée (voir applyBrandingOverlayUrl() plus haut).
   ====================================================================== */
let brandingState = {
  logoUrl: null,
  position: 'bottom-right',
  title: '',
  subtitle: '',
  visible: false,
};

function renderBranding(branding) {
  if (!branding) return;
  brandingState = branding;

  // AJOUT (demande explicite — "même vidéo, même GIF") : même logique de
  // bascule <img>/<video> que branding-overlay.html, pour l'aperçu côté
  // tableau de bord.
  const img = document.getElementById('brandingLogoImg');
  const video = document.getElementById('brandingLogoVideo');
  const placeholder = document.getElementById('brandingLogoPlaceholder');
  const isVideo = branding.logoType === 'video';
  const activeEl = isVideo ? video : img;
  const inactiveEl = isVideo ? img : video;
  if (inactiveEl) {
    inactiveEl.style.display = 'none';
    inactiveEl.removeAttribute('src');
  }
  if (activeEl && placeholder) {
    if (branding.logoUrl) {
      const absoluteLogoUrl = branding.logoUrl.startsWith('http')
        ? branding.logoUrl
        : getHttpOrigin() + branding.logoUrl;
      if (activeEl.src !== absoluteLogoUrl) activeEl.src = absoluteLogoUrl;
      activeEl.style.display = 'block';
      placeholder.style.display = 'none';
    } else {
      activeEl.style.display = 'none';
      activeEl.removeAttribute('src');
      placeholder.style.display = 'block';
    }
  }

  const positionSelect = document.getElementById('brandingPositionSelect');
  if (positionSelect && document.activeElement !== positionSelect) {
    positionSelect.value = branding.position || 'bottom-right';
  }
  const sizeSelect = document.getElementById('brandingSizeSelect');
  if (sizeSelect && document.activeElement !== sizeSelect) {
    sizeSelect.value = branding.size || 'medium';
  }

  const titleInput = document.getElementById('brandingTitleInput');
  const subtitleInput = document.getElementById('brandingSubtitleInput');
  // Ne pas écraser ce que l'opérateur est EN TRAIN de taper (un autre
  // tableau de bord ouvert ailleurs pourrait diffuser une mise à jour
  // pendant la saisie) — seulement synchroniser un champ non focus.
  if (titleInput && document.activeElement !== titleInput) titleInput.value = branding.title || '';
  if (subtitleInput && document.activeElement !== subtitleInput) {
    subtitleInput.value = branding.subtitle || '';
  }

  const statusBadge = document.getElementById('brandingStatus');
  const toggleBtn = document.getElementById('brandingVisibleToggleBtn');
  if (statusBadge) {
    statusBadge.textContent = branding.visible ? 'Affiché' : 'Masqué';
    statusBadge.className = 'status-badge ' + (branding.visible ? 'success' : 'warning');
  }
  if (toggleBtn) {
    toggleBtn.textContent = branding.visible ? '🙈 Masquer' : '👁️ Afficher sur la diffusion';
  }
}

async function pickBrandingLogo() {
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) {
    showToast(
      'Le choix de fichier natif n’est disponible que dans l’application ChurchOverlay.',
      'error'
    );
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  try {
    const sourcePath = await window.churchOverlay.pickMediaFile();
    if (!sourcePath) return; // sélection annulée par l'opérateur
    ws.send(JSON.stringify({ action: 'setBrandingLogo', sourcePath }));
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

function clearBrandingLogo() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'clearBrandingLogo' }));
}

function onBrandingPositionChange() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const select = document.getElementById('brandingPositionSelect');
  ws.send(
    JSON.stringify({
      action: 'setBrandingPosition',
      position: select ? select.value : 'bottom-right',
    })
  );
}

function onBrandingSizeChange() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const select = document.getElementById('brandingSizeSelect');
  ws.send(JSON.stringify({ action: 'setBrandingSize', size: select ? select.value : 'medium' }));
}

function saveBrandingText() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const titleInput = document.getElementById('brandingTitleInput');
  const subtitleInput = document.getElementById('brandingSubtitleInput');
  ws.send(
    JSON.stringify({
      action: 'setBrandingText',
      title: titleInput ? titleInput.value.trim() : '',
      subtitle: subtitleInput ? subtitleInput.value.trim() : '',
    })
  );
  showToast('Texte enregistré.', 'success');
}

function toggleBrandingVisible() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setBrandingVisible', visible: !brandingState.visible }));
}

// Même garde que les autres panneaux Electron-only (file d'affichage,
// dashboard.js:~1067) : le sélecteur de fichier natif n'existe que côté
// application de bureau (pont IPC depuis preload.js).
(function initMediaLibraryPanel() {
  const unavailable = document.getElementById('mediaLibraryUnavailable');
  const addRow = document.getElementById('mediaLibraryAddRow');
  if (!addRow) return;
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) {
    if (unavailable) unavailable.style.display = 'flex';
    addRow.style.display = 'none';
  }
})();

/* ======================================================================
   Bibliothèque de chants (déclenchement vocal ou manuel, section par
   section, voir song-library.js/server.js). Comme la médiathèque : la
   liste vit côté serveur. songSectionIndex garde en mémoire LOCALE quelle
   section de chaque chant est "en cours" pour la navigation précédent/
   suivant — le serveur, lui, reste sans état entre deux showSongSection().
   ====================================================================== */
let songLibraryItems = [];
const songSectionIndex = {};

function addSongToLibrary() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'ajouter un chant.", 'error');
    return;
  }
  const titleInput = document.getElementById('songTitleInput');
  const phrasesInput = document.getElementById('songPhrasesInput');
  const lyricsInput = document.getElementById('songLyricsInput');
  const title = titleInput ? titleInput.value.trim() : '';
  const lyrics = lyricsInput ? lyricsInput.value : '';
  if (!title || !lyrics.trim()) {
    showToast('Titre et paroles requis.', 'error');
    return;
  }
  const triggerPhrases = phrasesInput
    ? phrasesInput.value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  ws.send(JSON.stringify({ action: 'addSong', title, lyrics, triggerPhrases }));
  if (titleInput) titleInput.value = '';
  if (phrasesInput) phrasesInput.value = '';
  if (lyricsInput) lyricsInput.value = '';
}

function deleteSongFromLibrary(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteSong', id }));
  delete songSectionIndex[id];
}

function showSongSectionNow(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(
    JSON.stringify({ action: 'showSongSection', id, sectionIndex: songSectionIndex[id] || 0 })
  );
}

function stepSongSection(id, direction) {
  const song = songLibraryItems.find((s) => s.id === id);
  if (!song) return;
  const current = songSectionIndex[id] || 0;
  const next = Math.max(0, Math.min(song.sectionCount - 1, current + direction));
  songSectionIndex[id] = next;
  renderSongLibrary(songLibraryItems); // met à jour l'indicateur "N/total" affiché
  showSongSectionNow(id);
}

function renderSongLibrary(songs) {
  songLibraryItems = Array.isArray(songs) ? songs : [];
  const list = document.getElementById('songLibraryList');
  const countEl = document.getElementById('songLibraryCount');
  if (countEl) countEl.textContent = songLibraryItems.length;
  if (!list) return;

  if (songLibraryItems.length === 0) {
    list.innerHTML =
      '<div style="font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucun chant ajouté. Collez des paroles ci-dessus.</div>';
    return;
  }

  list.innerHTML = songLibraryItems
    .map((song) => {
      const phrasesBadges = (song.triggerPhrases || [])
        .map((p) => `<span class="media-item-phrase-badge">${escapeHtmlDashboard(p)}</span>`)
        .join('');
      const current = (songSectionIndex[song.id] || 0) + 1;
      return `
                <div class="queue-item">
                    <span class="queue-item-position">🎵</span>
                    <div class="media-item-info">
                        <div class="media-item-label">${escapeHtmlDashboard(song.title)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}</div>
                    </div>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="stepSongSection('${song.id}', -1)" title="Section précédente">◀</button>
                        <span style="font-size:0.7rem; color:var(--text-dim); white-space:nowrap;">${current}/${song.sectionCount}</span>
                        <button class="queue-icon-btn" onclick="stepSongSection('${song.id}', 1)" title="Section suivante">▶</button>
                        <button class="queue-icon-btn queue-send" onclick="showSongSectionNow('${song.id}')" title="Afficher maintenant">▶▶</button>
                        <button class="queue-icon-btn queue-remove" onclick="deleteSongFromLibrary('${song.id}')" title="Supprimer">✕</button>
                    </div>
                </div>
            `;
    })
    .join('');
}

/* ======================================================================
   Base biblique hors-ligne (cahier des charges — Point 1B). Statut
   téléchargé une seule fois à la connexion ; si un téléchargement est en
   cours, on repasse par-dessus toutes les 5s jusqu'à ce qu'il se termine,
   pour afficher une progression qui avance plutôt qu'un statut figé.
   ====================================================================== */
let offlineBibleStatusPollTimer = null;

function renderOfflineBibleStatus(status) {
  const el = document.getElementById('offlineBibleStatus');
  if (!el) return;

  clearTimeout(offlineBibleStatusPollTimer);

  if (status.status === 'done') {
    el.textContent = '✅ Téléchargée';
    el.className = 'status-badge success';
  } else if (status.status === 'downloading') {
    const pct = status.total > 0 ? Math.round((status.downloaded / status.total) * 100) : 0;
    el.textContent = `⏳ Téléchargement... ${pct}%`;
    el.className = 'status-badge warning';
    offlineBibleStatusPollTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'getOfflineBibleStatus' }));
      }
    }, 5000);
  } else if (status.status === 'error') {
    el.textContent = '❌ Échec du téléchargement';
    el.className = 'status-badge error';
  } else {
    el.textContent = 'En attente';
    el.className = 'status-badge warning';
  }
}

/* ======================================================================
   Pont ProPresenter (écran scène, recommandation "ProPresenter Remote/API").
   Entièrement optionnel — voir propresenter-controller.js/main.js. Passe
   par IPC (window.churchOverlay), pas par WebSocket : la connexion
   ProPresenter elle-même vit dans le process principal (accès à
   safeStorage pour le mot de passe, comme pour OBS).
   ====================================================================== */
async function loadProPresenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.getProPresenterConfig) return;
  try {
    const cfg = await window.churchOverlay.getProPresenterConfig();
    if (!cfg || !cfg.ok) return;
    const enabledInput = document.getElementById('ppEnabledInput');
    const hostInput = document.getElementById('ppHostInput');
    const portInput = document.getElementById('ppPortInput');
    const autoSendInput = document.getElementById('ppAutoSendInput');
    if (enabledInput) enabledInput.checked = !!cfg.enabled;
    if (hostInput) hostInput.value = cfg.host || 'localhost';
    if (portInput) portInput.value = cfg.port || 50001;
    if (autoSendInput) autoSendInput.checked = !!cfg.autoSendVerses;
  } catch (_err) {
    /* silencieux : panneau optionnel, pas d'erreur bloquante au chargement */
  }
}

async function saveProPresenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.setProPresenterConfig) return;
  const enabled = !!document.getElementById('ppEnabledInput')?.checked;
  const host = document.getElementById('ppHostInput')?.value.trim() || 'localhost';
  const port = Number(document.getElementById('ppPortInput')?.value) || 50001;
  const autoSendVerses = !!document.getElementById('ppAutoSendInput')?.checked;
  const password = document.getElementById('ppPasswordInput')?.value || '';
  try {
    await window.churchOverlay.setProPresenterConfig({
      enabled,
      host,
      port,
      autoSendVerses,
      password,
    });
    const pwInput = document.getElementById('ppPasswordInput');
    if (pwInput) pwInput.value = '';
    showToast('Configuration ProPresenter enregistrée.', 'success');
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

async function connectProPresenter() {
  if (!window.churchOverlay || !window.churchOverlay.proPresenterConnect) return;
  const statusEl = document.getElementById('ppStatus');
  if (statusEl) statusEl.textContent = 'Connexion en cours...';
  try {
    const result = await window.churchOverlay.proPresenterConnect();
    if (statusEl) {
      statusEl.textContent =
        result && result.ok ? '✅ Connecté' : '❌ ' + (result?.error || 'Échec');
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '❌ ' + (err && err.message ? err.message : err);
  }
}

async function sendProPresenterTestMessage() {
  if (!window.churchOverlay || !window.churchOverlay.proPresenterSendMessage) return;
  const input = document.getElementById('ppTestMessageInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  try {
    const result = await window.churchOverlay.proPresenterSendMessage(text);
    if (result && result.ok) {
      showToast('Message envoyé à ProPresenter.', 'success');
      if (input) input.value = '';
    } else {
      showToast('Échec : ' + (result?.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

if (window.churchOverlay && window.churchOverlay.getProPresenterConfig) {
  loadProPresenterConfig();
}

/* ======================================================================
   Planning Center Services (ordre du culte, recommandation "sync Planning
   Center"). Lecture seule — voir planning-center-wrapper.js/main.js. Passe
   par IPC comme ProPresenter ci-dessus (le secret vit chiffré côté process
   principal via safeStorage).
   ====================================================================== */
async function loadPlanningCenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.getPlanningCenterConfig) return;
  try {
    const cfg = await window.churchOverlay.getPlanningCenterConfig();
    if (!cfg || !cfg.ok) return;
    const enabledInput = document.getElementById('pcoEnabledInput');
    const appIdInput = document.getElementById('pcoAppIdInput');
    if (enabledInput) enabledInput.checked = !!cfg.enabled;
    if (appIdInput) appIdInput.value = cfg.appId || '';
  } catch (_err) {
    /* silencieux : panneau optionnel */
  }
}

async function savePlanningCenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.setPlanningCenterConfig) return;
  const enabled = !!document.getElementById('pcoEnabledInput')?.checked;
  const appId = document.getElementById('pcoAppIdInput')?.value.trim() || '';
  const secret = document.getElementById('pcoSecretInput')?.value || '';
  try {
    await window.churchOverlay.setPlanningCenterConfig({ enabled, appId, secret });
    const secretInput = document.getElementById('pcoSecretInput');
    if (secretInput) secretInput.value = '';
    showToast('Configuration Planning Center enregistrée.', 'success');
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

async function fetchPlanningCenterPlan() {
  if (!window.churchOverlay || !window.churchOverlay.fetchPlanningCenterPlan) return;
  const statusEl = document.getElementById('pcoStatus');
  const itemsEl = document.getElementById('pcoPlanItems');
  if (statusEl) statusEl.textContent = 'Chargement...';
  if (itemsEl) itemsEl.innerHTML = '';
  try {
    const result = await window.churchOverlay.fetchPlanningCenterPlan();
    if (!result || !result.ok) {
      if (statusEl) statusEl.textContent = '❌ ' + (result?.error || 'Échec du chargement');
      return;
    }
    const dateLabel = result.planDate
      ? new Date(result.planDate).toLocaleDateString('fr-FR', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : '';
    if (statusEl) {
      statusEl.textContent = `${escapeHtmlDashboard(result.planTitle)}${dateLabel ? ' — ' + dateLabel : ''}`;
    }
    if (itemsEl) {
      itemsEl.innerHTML = (result.items || [])
        .map(
          (item) =>
            `<div style="padding:0.3rem 0; border-bottom:1px solid var(--border-subtle);">${escapeHtmlDashboard(item.title)} <span style="color:var(--text-dim); font-size:0.78rem;">(${escapeHtmlDashboard(item.itemType)})</span></div>`
        )
        .join('');
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '❌ ' + (err && err.message ? err.message : err);
  }
}

if (window.churchOverlay && window.churchOverlay.getPlanningCenterConfig) {
  loadPlanningCenterConfig();
}

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

// AJOUT (audit round 9) : session-store.js persiste déjà chaque verset
// affiché et chaque erreur de pipeline en SQLite (survie à un crash),
// mais rien ne relisait jamais cette base côté tableau de bord — la
// persistance tournait "dans le vide" sans jamais être consultable par
// l'opérateur. Bouton + panneau pour l'exposer : combien de versets
// affichés, combien d'erreurs, sur la période choisie (défaut : 24h).
function requestSessionStats(days) {
  if (!requireWsOrWarn()) return;
  const el = document.getElementById('sessionStatsOutput');
  if (el) el.innerHTML = '<span class="stat-label">⏳ Chargement des statistiques...</span>';
  ws.send(JSON.stringify({ action: 'getSessionStats', days: days || 1 }));
}

function renderSessionStats(message) {
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
    ${errorLines ? `<div class="stat-row"><span class="stat-label">Détail des erreurs</span><span class="stat-value" style="font-weight:400; font-size:0.8rem;">${errorLines}</span></div>` : ''}
    ${recentVerses ? `<div style="margin-top:0.75rem; max-height:220px; overflow-y:auto;">${recentVerses}</div>` : ''}
  `;
}

// AJOUT (export des temps forts — voir highlight-export.js) : réutilise le
// même historique persistant que ci-dessus, mis en forme pour un
// enregistrement vidéo du culte EN COURS (depuis le démarrage du serveur,
// pas une période choisie comme requestSessionStats).
function exportHighlights() {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'exportHighlights' }));
}

function renderHighlightsExport(message) {
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

// AJOUT (audit — accessibilité, gratuit/léger, session parallèle) : bascule
// "Mode grand contraste" — un seul message WS, le serveur retransmet à
// tous les overlays connectés (voir action 'setHighContrast' -> 'accessibilityMode'
// dans server.js).
function onHighContrastToggle() {
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
function onCaptionsToggle() {
  const checkbox = document.getElementById('captionsToggle');
  const enabled = !!(checkbox && checkbox.checked);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setCaptions', enabled }));
  }
  showToast(enabled ? "Sous-titres activés sur l'overlay." : 'Sous-titres désactivés.', 'info');
}

// AJOUT (sous-titres traduits en direct — voir caption-translator.js) :
// même schéma que onCaptionsToggle(), avec une langue cible en plus.
function onTranslatedCaptionsToggle() {
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

async function refreshDisplays() {
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
function getSelectedDisplayMode() {
  const modeSelect = document.getElementById('displayModeSelect');
  return modeSelect ? modeSelect.value || 'overlay' : 'overlay';
}

const DISPLAY_MODE_LABELS = {
  overlay: 'Overlay',
  stage: 'Écran scène',
  announcements: 'Diaporama annonces',
};

async function openDisplayWindow() {
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

async function closeDisplayWindow() {
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
function sendStageMessage() {
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

function clearStageMessage() {
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
function onTestPatternToggle() {
  const checkbox = document.getElementById('testPatternToggle');
  const enabled = !!(checkbox && checkbox.checked);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setTestPattern', enabled }));
  }
  showToast(enabled ? "Motif de test activé sur l'overlay." : 'Motif de test désactivé.', 'info');
}

// AJOUT (audit — mémoire des cultes, gratuit/léger, session parallèle) :
// recherche locale par mots-clés, pas d'appel API — voir sermon-archive.js.
function requestArchiveSearch() {
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
function askSermonQuestion() {
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
function renderSermonQaResult(result) {
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
      '<div style="font-size:0.78rem; color:var(--text-dim); margin-bottom:0.4rem;">Sources citées :</div>' +
      (result.sources || [])
        .map(
          (s) =>
            `<div class="media-item-phrase-badge" style="display:block; margin-bottom:0.4rem; padding:0.5rem 0.7rem;">
               <strong>${escapeHtmlDashboard(s.label)}</strong><br>
               <span style="opacity:0.85;">${escapeHtmlDashboard(s.excerpt.slice(0, 200))}${s.excerpt.length > 200 ? '…' : ''}</span>
             </div>`
        )
        .join('');
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
    `<div style="font-size:0.75rem; color: var(--text-dim); margin-top:0.5rem;">
                    ⚠️ Le microphone n'est pas vérifié ici — voir "Statut Capture Micro" ci-dessus.
                </div>`;
  resultsEl.style.display = 'block';

  const groqOk = !message.groq || message.groq.ok;
  showToast(
    groqOk ? 'Vérification pré-culte terminée.' : 'Vérification terminée — vérifiez Groq.',
    groqOk ? 'success' : 'warning'
  );
}

/* ============================================================================
   AJOUT (modularisation — chantier "dashboard/", front end plus léger, mieux
   construit) : dashboard.html charge désormais ce fichier via
   <script type="module">, dans lequel les déclarations top-level ne sont PAS
   globales par défaut (contrairement à un <script> classique). Les 70+
   attributs onclick="..." de dashboard.html référencent ces fonctions par
   leur nom global — exposition explicite ci-dessous pour que rien ne casse.

   Ce fichier est un ÉTAT DE TRANSITION : le contenu ci-dessus est encore
   dashboard.js tel quel, déplacé sans découpage. Les prochains lots le
   démantèlent progressivement en modules par fonctionnalité (voir
   dashboard/features/*.js) ; ce bloc d'exposition rétrécit au fur et à
   mesure — sans usage restant une fois le démantèlement terminé.
   ============================================================================ */
window.addIpCamera = addIpCamera;
window.addMediaLibraryItem = addMediaLibraryItem;
window.addSongToLibrary = addSongToLibrary;
window.addToQueue = addToQueue;
window.applyBrandingOverlayUrl = applyBrandingOverlayUrl;
window.applyOverlayUrl = applyOverlayUrl;
window.askSermonQuestion = askSermonQuestion;
window.clearBrandingLogo = clearBrandingLogo;
window.clearDefaultPosterFromCard = clearDefaultPosterFromCard;
window.clearStageMessage = clearStageMessage;
window.closeDisplayWindow = closeDisplayWindow;
window.connectProPresenter = connectProPresenter;
window.copyBrandingOverlayUrl = copyBrandingOverlayUrl;
window.copyIpCameraUrl = copyIpCameraUrl;
window.copyOverlayUrl = copyOverlayUrl;
window.deleteIpCameraItem = deleteIpCameraItem;
window.deleteMediaLibraryItem = deleteMediaLibraryItem;
window.deleteSongFromLibrary = deleteSongFromLibrary;
window.drawRealAudioVisualizer = drawRealAudioVisualizer;
window.exportHighlights = exportHighlights;
window.exportPostServiceRecap = exportPostServiceRecap;
window.fetchPlanningCenterPlan = fetchPlanningCenterPlan;
window.generateCameraPairing = generateCameraPairing;
window.getHttpOrigin = getHttpOrigin;
window.getSelectedDisplayMode = getSelectedDisplayMode;
window.getWsPort = getWsPort;
window.getWsToken = getWsToken;
window.getWsUrl = getWsUrl;
window.handleMessage = handleMessage;
window.hideMediaNow = hideMediaNow;
window.initNetworkCard = initNetworkCard;
window.initWebSocket = initWebSocket;
window.loadPlanningCenterConfig = loadPlanningCenterConfig;
window.loadProPresenterConfig = loadProPresenterConfig;
window.moveQueueItem = moveQueueItem;
window.onAutoTranslateLangChange = onAutoTranslateLangChange;
window.onAutoTranslateToggle = onAutoTranslateToggle;
window.onBrandingPositionChange = onBrandingPositionChange;
window.onBrandingSizeChange = onBrandingSizeChange;
window.onCaptionsToggle = onCaptionsToggle;
window.onHighContrastToggle = onHighContrastToggle;
window.onTestPatternToggle = onTestPatternToggle;
window.onTranslatedCaptionsToggle = onTranslatedCaptionsToggle;
window.openDisplayWindow = openDisplayWindow;
window.pickBrandingLogo = pickBrandingLogo;
window.refreshDisplays = refreshDisplays;
window.removeFromQueue = removeFromQueue;
window.renderAiEnricherOutput = renderAiEnricherOutput;
window.renderBranding = renderBranding;
window.renderDefaultPosterCard = renderDefaultPosterCard;
window.renderHighlightsExport = renderHighlightsExport;
window.renderIpCameras = renderIpCameras;
window.renderMediaLibrary = renderMediaLibrary;
window.renderMoodPicker = renderMoodPicker;
window.renderNetworkStatus = renderNetworkStatus;
window.renderOfflineBibleStatus = renderOfflineBibleStatus;
window.renderPreServiceCheckResult = renderPreServiceCheckResult;
window.renderQueue = renderQueue;
window.renderSermonQaResult = renderSermonQaResult;
window.renderSessionStats = renderSessionStats;
window.renderSongLibrary = renderSongLibrary;
window.requestArchiveSearch = requestArchiveSearch;
window.requestAutoTranslation = requestAutoTranslation;
window.requestCrossReferences = requestCrossReferences;
window.requestLiveSummary = requestLiveSummary;
window.requestLiveTranslation = requestLiveTranslation;
window.requestNetworkStatus = requestNetworkStatus;
window.requestPostServiceRecap = requestPostServiceRecap;
window.requestSermonTheme = requestSermonTheme;
window.requestSessionStats = requestSessionStats;
window.restartPipeline = restartPipeline;
window.runPreServiceCheck = runPreServiceCheck;
window.saveBrandingText = saveBrandingText;
window.saveMediaItemDetails = saveMediaItemDetails;
window.saveNetworkSettings = saveNetworkSettings;
window.savePlanningCenterConfig = savePlanningCenterConfig;
window.saveProPresenterConfig = saveProPresenterConfig;
window.scheduleReconnect = scheduleReconnect;
window.sendNextInQueue = sendNextInQueue;
window.sendProPresenterTestMessage = sendProPresenterTestMessage;
window.sendQueueItem = sendQueueItem;
window.sendStageMessage = sendStageMessage;
window.setActiveMoodButton = setActiveMoodButton;
window.setBackgroundPattern = setBackgroundPattern;
window.setMoodTheme = setMoodTheme;
window.setPipelineAlert = setPipelineAlert;
window.setTranscriptionHealth = setTranscriptionHealth;
window.showCameraPairingQr = showCameraPairingQr;
window.showSectionsFor = showSectionsFor;
window.showSongSectionNow = showSongSectionNow;
window.startIpCameraMonitor = startIpCameraMonitor;
window.startRealAudioCapture = startRealAudioCapture;
window.startSermonModeAutoDetect = startSermonModeAutoDetect;
window.stepSongSection = stepSongSection;
window.stopRealAudioCapture = stopRealAudioCapture;
window.stopSermonModeAutoDetect = stopSermonModeAutoDetect;
window.toggleBrandingVisible = toggleBrandingVisible;
window.toggleDefaultMediaItem = toggleDefaultMediaItem;
window.toggleLivePreview = toggleLivePreview;
window.toggleNoiseGate = toggleNoiseGate;
window.triggerMediaLibraryItem = triggerMediaLibraryItem;
window.updateSermonModeBadge = updateSermonModeBadge;
window.useSuggestedLanIp = useSuggestedLanIp;
