/**
 * dashboard/features/audio-capture.js — capture micro réelle qui
 * alimente le pipeline de détection (Web Audio -> PCM16 ->
 * window.churchOverlay.sendAudioChunk() -> worker -> Whisper/Groq/
 * Deepgram -> detector.js -> bible-lookup), visualiseur de flux audio,
 * réduction de bruit (gate), aperçu overlay en direct.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { getWsToken, getWsPort } from '../state.js';
// AJOUT (import circulaire, sûr) : verse-session-display.js importe
// realMicCaptureState/startRealAudioCapture/stopRealAudioCapture DEPUIS ce
// fichier ; celui-ci importe updateMicButtonUI en retour. Sûr par la même
// règle que les autres imports circulaires de ce chantier : usage
// uniquement à l'intérieur de corps de fonction, jamais au chargement du
// module.
import { updateMicButtonUI } from './verse-session-display.js';
import { showToast, addActivity } from '../utils.js';

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

export function drawRealAudioVisualizer() {
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
export function toggleNoiseGate() {
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
export function toggleLivePreview() {
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

window.toggleNoiseGate = toggleNoiseGate;
window.toggleLivePreview = toggleLivePreview;
