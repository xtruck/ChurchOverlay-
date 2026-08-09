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
    updateMicButtonUI();
  } catch (err) {
    console.error('[dashboard] Échec démarrage capture micro réelle:', err);
    showToast('❌ Micro : ' + (err && err.message ? err.message : err), 'error');
    updateMicButtonUI();
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

function escapeHtmlDashboard(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

function renderMediaLibrary(items) {
  mediaLibraryItems = Array.isArray(items) ? items : [];
  const list = document.getElementById('mediaLibraryList');
  const countEl = document.getElementById('mediaLibraryCount');
  if (countEl) countEl.textContent = mediaLibraryItems.length;
  if (!list) return;

  if (mediaLibraryItems.length === 0) {
    list.innerHTML =
      '<div style="font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucun média ajouté. Choisissez une photo ou une vidéo ci-dessus.</div>';
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
      return `
                <div class="queue-item" style="${item.isDefault ? 'border-color: var(--accent-amber, #d9a441);' : ''}">
                    <span class="queue-item-position">${item.mediaType === 'video' ? '🎬' : '🖼️'}</span>
                    <div class="media-item-info">
                        <div class="media-item-label">${item.isDefault ? '⭐ ' : ''}${item.includeInLoop ? '🔁 ' : ''}${escapeHtmlDashboard(item.label)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}${item.isDefault ? ' <span class="media-item-phrase-badge">Poster principal — affiché quand rien d’autre n’est à l’écran</span>' : ''}</div>
                        <div style="display:flex; align-items:center; gap:0.4rem; margin-top:0.35rem; flex-wrap:wrap;">
                            <input type="number" min="1" step="1" placeholder="secondes" value="${durationSec}" id="mediaDuration-${item.id}" ${item.isDefault ? 'disabled title="Le poster principal reste affiché en continu — pas de minuterie"' : `title="Durée d'affichage en secondes — vide = pas de minuterie automatique (masquage manuel)"`} style="width:80px; padding:0.25rem 0.4rem; font-size:0.75rem; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); background:var(--bg-input); color:var(--text-main);">
                            <select id="mediaStyle-${item.id}" style="padding:0.25rem 0.4rem; font-size:0.75rem; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); background:var(--bg-input); color:var(--text-main);" title="Style d'apparition à l'écran">
                                ${styleOptions}
                            </select>
                            <button class="queue-icon-btn" onclick="saveMediaItemDetails('${item.id}')" title="Enregistrer la durée/le style">💾</button>
                        </div>
                    </div>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="toggleDefaultMediaItem('${item.id}', ${item.isDefault ? 'true' : 'false'})" title="${item.isDefault ? 'Retirer le statut de poster principal' : 'Définir comme poster principal (affiché quand rien d’autre n’est à l’écran)'}">${item.isDefault ? '⭐' : '☆'}</button>
                        <button class="queue-icon-btn queue-send" onclick="triggerMediaLibraryItem('${item.id}')" title="Afficher maintenant">▶</button>
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
      if (activeEl.src !== branding.logoUrl) activeEl.src = branding.logoUrl;
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

// AJOUT (audit — second écran pour l'assemblée, session parallèle) :
// affiche l'URL de la page compagnon (même origine que le tableau de bord,
// juste /companion) — à coller dans n'importe quel générateur de QR code
// gratuit.
(function initCompanionLink() {
  const link = document.getElementById('companionLink');
  if (!link) return;
  const url = window.location.origin + '/companion';
  link.href = url;
  link.textContent = url;
})();

function copyCompanionLink() {
  const url = window.location.origin + '/companion';
  navigator.clipboard
    .writeText(url)
    .then(() => {
      showToast('Lien copié — collez-le dans un générateur de QR code.', 'success');
    })
    .catch(() => {
      showToast('Copie impossible — sélectionnez le lien manuellement.', 'error');
    });
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

  // CORRECTIF (audit production — XSS) : message.text vient soit du moteur
  // STT (Groq/Deepgram, jamais passé par le filtre <>">' appliqué aux
  // SEULS messages entrants côté serveur), soit d'un client déjà
  // authentifié opérateur. escapeHtmlDashboard() existait déjà mais
  // n'était jamais appliqué ici, le point d'entrée le plus direct entre
  // "parole captée" et innerHTML.
  const time = new Date(message.timestamp || Date.now()).toLocaleTimeString();
  item.innerHTML = `
                <div class="transcript-time"><span>${time}</span><span>${escapeHtmlDashboard(message.source || 'Audio')}</span></div>
                <div class="transcript-text">${escapeHtmlDashboard(message.text || '')}</div>
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
function updateMicButtonUI() {
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

async function toggleRealMicCapture() {
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

function refreshOverlay() {
  const frame = document.getElementById('overlayFrame');
  if (frame && state.overlayUrl) {
    const url = new URL(state.overlayUrl);
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

  // CORRECTIF (audit production — XSS) : message est souvent un gabarit
  // incluant err.message ou un champ serveur dynamique, jamais échappé
  // avant insertion.
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtmlDashboard(message)}</span>`;
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

  // CORRECTIF (audit production — XSS) : title inclut souvent des champs
  // dynamiques (message.error, message.reference, un fuzzyOriginal qui
  // reflète la transcription vocale...) jamais échappés avant insertion.
  // `type` reste un littéral interne, pas besoin de l'échapper.
  item.innerHTML = `
                <div class="activity-icon ${type}">•</div>
                <div class="activity-content">
                    <div class="activity-title">${escapeHtmlDashboard(title)}</div>
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
      // CORRECTIF (audit — regroupement de navigation) : "settings" fait
      // maintenant partie d'un data-sections combiné ("Réglages"), plus
      // une valeur exacte isolée — sélecteur par sous-chaîne.
      const settingsNav = document.querySelector('.nav-item[data-sections*="settings"]');
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

/* ============================================================================
 * Capture webcam — aperçu opérateur (voir camera-capture.js)
 * ----------------------------------------------------------------------------
 * AJOUT (demande explicite). Module ISOLÉ du pipeline audio existant
 * (audio-capture.js/groq-wrapper.js/realMicCaptureState) : ne touche à
 * aucune variable ni fonction audio, ne fait aucun appel réseau/serveur —
 * juste un aperçu vidéo local piloté via window.CameraCapture.
 * ============================================================================ */

async function refreshCameraList() {
  const select = document.getElementById('cameraSelect');
  if (!select || !window.CameraCapture) return;
  try {
    const cameras = await window.CameraCapture.listCameras();
    if (cameras.length === 0) {
      select.innerHTML = '<option value="">Aucune caméra détectée</option>';
      return;
    }
    select.innerHTML = cameras
      .map((c) => `<option value="${c.deviceId}">${escapeHtmlDashboard(c.label)}</option>`)
      .join('');
    const best = window.CameraCapture.pickBestCamera(cameras);
    if (best.chosen) select.value = best.chosen.deviceId;
    hideCameraErrorHint();
  } catch (err) {
    showCameraErrorHint(err && err.message ? err.message : String(err));
  }
}

function showCameraErrorHint(message) {
  const hint = document.getElementById('cameraErrorHint');
  if (!hint) return;
  hint.textContent = message;
  hint.style.display = 'block';
}

function hideCameraErrorHint() {
  const hint = document.getElementById('cameraErrorHint');
  if (hint) hint.style.display = 'none';
}

function updateCameraButtonUI() {
  const btn = document.getElementById('cameraToggleBtn');
  const badge = document.getElementById('cameraStatus');
  const video = document.getElementById('cameraPreview');
  const placeholder = document.getElementById('cameraPreviewPlaceholder');
  const active = !!(window.CameraCapture && window.CameraCapture.isCapturing());

  if (btn) btn.textContent = active ? '⏹ Arrêter la caméra' : '📷 Démarrer la caméra';
  if (badge) {
    badge.textContent = active ? 'Aperçu actif' : 'Capture arrêtée';
    badge.className = 'status-badge ' + (active ? 'success' : 'warning');
  }
  if (video) video.style.display = active ? 'block' : 'none';
  if (placeholder) placeholder.style.display = active ? 'none' : 'flex';
}

async function toggleCameraCapture() {
  if (!window.CameraCapture) {
    showToast('Module caméra indisponible.', 'error');
    return;
  }

  if (window.CameraCapture.isCapturing()) {
    window.CameraCapture.stopCapture();
    updateCameraButtonUI();
    addActivity('Caméra arrêtée manuellement', 'info');
    return;
  }

  const select = document.getElementById('cameraSelect');
  const video = document.getElementById('cameraPreview');
  const deviceId = select ? select.value : '';
  try {
    hideCameraErrorHint();
    await window.CameraCapture.startCapture(deviceId, video);
    updateCameraButtonUI();
    addActivity('Caméra démarrée', 'success');
    showToast('Caméra démarrée', 'success');
  } catch (err) {
    updateCameraButtonUI();
    const message = err && err.message ? err.message : String(err);
    showCameraErrorHint(message);
    showToast('Caméra : ' + message, 'error');
  }
}

(function initCameraPanel() {
  if (!document.getElementById('cameraToggleBtn') || !window.CameraCapture) return;

  window.CameraCapture.onStopped((reason) => {
    updateCameraButtonUI();
    if (reason === 'device-ended') {
      showCameraErrorHint('Caméra débranchée ou désactivée.');
      addActivity('Caméra déconnectée', 'warning');
      showToast('Caméra débranchée', 'warning');
    }
  });

  updateCameraButtonUI();
  refreshCameraList();

  // Redécouvre les vrais libellés une fois la permission accordée (avant
  // ça, enumerateDevices() ne renvoie que des libellés vides/génériques) et
  // suit le branchement/débranchement de caméras en cours d'utilisation.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshCameraList);
  }
})();

/* ============================================================================
 * Indicateur de performance (CPU/RAM) — voir perf-monitor.js
 * ----------------------------------------------------------------------------
 * AJOUT (audit perf). L'échantillonnage (perf-monitor.js) et le pont IPC
 * (main.js/preload.js, onPerfUpdate) existaient déjà côté Electron mais
 * n'étaient consommés par aucune UI — ce bloc ferme la boucle. Absent en
 * mode "serveur seul" navigateur (window.churchOverlay n'existe pas alors),
 * la pastille reste masquée dans ce cas (voir style="display:none" en HTML).
 * ============================================================================ */
(function initPerfPill() {
  const pill = document.getElementById('perfPill');
  const text = document.getElementById('perfPillText');
  const dot = document.getElementById('perfDot');
  if (!pill || !text || !dot || !window.churchOverlay || !window.churchOverlay.onPerfUpdate) return;

  pill.style.display = 'flex';
  window.churchOverlay.onPerfUpdate((stats) => {
    if (!stats) return;
    const cpu = Math.round(stats.cpuPercent || 0);
    const ram = Math.round(stats.rssMB || 0);
    text.textContent = `CPU ${cpu}% · RAM ${ram} Mo`;
    const color =
      cpu >= 70
        ? 'var(--accent-rose)'
        : cpu >= 40
          ? 'var(--accent-amber)'
          : 'var(--accent-emerald)';
    dot.style.background = color;
    dot.style.boxShadow = `0 0 8px ${color}`;
  });
})();
