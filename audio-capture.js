/**
 * ============================================================================
 *  audio-capture.js — Module de capture audio en continu
 * ----------------------------------------------------------------------------
 *  OPTIMISATIONS v0.2.1 (Option A + Bonus):
 *    1. segmentDuration: 6000ms → 5000ms (plus réactif, -17% de latence)
 *    2. overlapDuration: 100ms → 400ms (meilleur contexte entre segments)
 *    3. maxAgeMs: 3600000 (1h) → 180000 (3 minutes) pour nettoyage plus rapide
 *
 *  ARCHITECTURE:
 *    Micro → audio-capture.js → groq-wrapper.js (cloud) → server.js → overlay.html
 *
 *  FONCTIONNALITÉS:
 *    - Capture audio en continu (streaming)
 *    - Segmentation intelligente (VAD - Voice Activity Detection)
 *    - Envoi des segments audio à Groq/Deepgram (transcription cloud)
 *    - Gestion du buffer circulaire pour éviter la perte de données
 *
 *  CONFIGURATION:
 *    - Sample rate: 16000 Hz (recommandé pour Whisper large-v3 côté Groq)
 *    - Channels: 1 (mono)
 *    - Format: PCM 16-bit
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Configuration
const CONFIG = {
  sampleRate: 16000, // recommandé pour Whisper large-v3 (Groq)
  channels: 1, // Mono
  bitDepth: 16, // PCM 16-bit
  // AJOUT (audit — reflexes plus rapides, gratuit) : 5000ms → 4000ms.
  // whisper-large-v3-turbo (voir groq-wrapper.js) transcrit un segment plus
  // vite que l'ancien modèle, donc raccourcir la fenêtre réduit la latence
  // perçue sans changer de fournisseur ni de coût — juste moins d'audio à
  // attendre avant l'envoi. 4s reste au-dessus du plancher usuel pour une
  // bonne précision Whisper (le contexte se dégrade nettement sous ~3s).
  segmentDuration: 4000, // 4 secondes (optimisé pour réactivité)
  overlapDuration: 400, // 400ms de chevauchement (meilleur contexte)
  // CORRECTIF (VAD réel) : ces deux valeurs existaient déjà mais n'étaient
  // lues nulle part dans ce fichier — la segmentation était purement
  // temporelle, aucun filtrage de silence n'avait lieu malgré le commentaire
  // d'en-tête "Segmentation intelligente (VAD)". 0.3 était un placeholder
  // jamais calibré : pour une RMS normalisée par l'amplitude max int16
  // (échelle 0-1, voir computeRms ci-dessous), la parole normale tourne
  // plutôt autour de 0.01-0.08 selon le gain micro — 0.3 aurait classé
  // quasiment tout en "silence". Valeur de départ raisonnable ; À CALIBRER
  // avec de vrais enregistrements de culte (variation de gain micro d'un
  // lieu à l'autre) avant de considérer ce seuil comme définitif.
  silenceThreshold: 0.02, // Seuil RMS de silence pour VAD (0-1)
  minSpeechDuration: 500, // Durée minimum de voix détectée dans un segment (ms) pour l'envoyer au STT

  // AJOUT (VAD streaming — capture de phrases plus rapide) : jusqu'ici la
  // segmentation était PUREMENT temporelle (fenêtre fixe segmentDuration),
  // donc une phrase courte suivie d'un silence attendait quand même la fin
  // des 4s avant d'être transcrite. Ces réglages pilotent une coupure
  // anticipée dès qu'un silence de fin de phrase est détecté (voir
  // processStreamingFrame/flushSegment) — segmentDuration devient un
  // plafond de sécurité plutôt que le seul déclencheur.
  trailingSilenceMs: 600, // silence continu après de la voix => on considère la phrase terminée et on coupe tout de suite
  noiseFloorAdaptRate: 0.1, // vitesse d'adaptation (moyenne mobile exponentielle) de l'estimation du bruit ambiant
  noiseMarginMultiplier: 3, // un niveau doit dépasser (bruit ambiant × ce facteur) pour compter comme "voix" côté détection anticipée
  minAdaptiveThreshold: 0.01, // plancher absolu : ne jamais déclencher sur du bruit de quantification même si la pièce est très calme
  maxAdaptiveThreshold: 0.06, // plafond absolu : ne jamais exiger plus fort qu'une voix normale, même dans une pièce bruyante
  initialNoiseFloor: 0.01, // estimation de départ avant calibration (affinée en continu pendant les silences)
  // CORRECTIF (2026-08-07 — protection quota gratuit Groq) : whisper-large-v3-
  // turbo est plafonné à 20 requêtes/minute côté gratuit Groq (confirmé via
  // console.groq.com/docs/rate-limits). Sans plancher, une coupure anticipée
  // sur CHAQUE petite pause entre phrases (parole hachée, plusieurs phrases
  // courtes rapprochées) pourrait dépasser ce débit et déclencher des 429 en
  // plein culte. Ce plancher ne s'applique qu'aux coupures ANTICIPÉES (voir
  // processStreamingFrame) — le plafond de sécurité segmentDuration (4000ms)
  // reste, lui, naturellement sous 20/min et n'a pas besoin de ce garde-fou.
  minFlushIntervalMs: 3200, // ~18.75 requêtes/min max, marge sous le plafond Groq de 20/min
  // CORRECTIF (audit — même famille de bug que ffmpeg.exe dans setup-ffmpeg.js) :
  // était path.join(__dirname, 'temp-audio'). Dans l'app empaquetée
  // (asar: true), __dirname pointe à l'intérieur de app.asar, un fichier
  // archive à LECTURE SEULE — fs.mkdirSync() y échoue systématiquement avec
  // "ENOTDIR: not a directory". Contrairement au cas ffmpeg.exe, il n'y a
  // ici aucun binaire à exécuter (juste des fichiers .wav à écrire puis
  // relire), donc pas besoin d'un chemin "asar.unpacked" spécifique : le
  // dossier temporaire de l'OS (os.tmpdir()) est le bon choix dans TOUS les
  // modes d'exécution (empaqueté, dev, `node server.js` standalone) sans
  // dépendre d'aucune configuration de packaging.
  tempDir: path.join(os.tmpdir(), 'churchoverlay-audio'),
};

// État du module
const STATE = {
  isRecording: false,
  audioBuffer: [],
  segmentCount: 0,
  // CORRECTIF (audit — remplacement de FFmpeg/dshow) : sur certains
  // portables (typiquement micro intégré piloté par Intel Smart Sound
  // Technology ou équivalent), le micro apparaît normalement dans
  // Windows (Paramètres > Son) mais n'est PAS exposé via l'API DirectShow
  // que FFmpeg utilisait pour l'énumération ET la capture — 0 périphérique
  // trouvé, quel que soit l'état de FFmpeg lui-même. `browserCaptureConfig`
  // porte la config active quand la source audio est la capture native du
  // navigateur (Web Audio, dans dashboard.html) plutôt que le flux stdout
  // d'un processus FFmpeg — l'API Web Audio d'Electron/Chromium passe par
  // WASAPI et voit donc les mêmes périphériques que Windows lui-même.
  browserCaptureConfig: null,
  callbacks: {
    onAudioSegment: null,
    onError: null,
  },
  // AJOUT (VAD streaming) — état de la détection anticipée de fin de phrase,
  // indépendant de STATE.audioBuffer (qui accumule les octets du segment en
  // cours) : voir handleAudioData/processStreamingFrame/flushSegment.
  frameAccumulator: Buffer.alloc(0), // reste d'octets encore trop court pour former une trame VAD complète
  noiseFloor: 0.01, // estimation courante du bruit ambiant, mise à jour uniquement pendant du silence confirmé
  segmentHasSpeech: false, // le segment en cours contient-il déjà assez de voix pour qu'un silence derrière compte comme une fin de phrase ?
  consecutiveSilentFrameMs: 0, // durée de silence consécutif accumulée dans le segment en cours
  voicedFrameMsInSegment: 0, // durée de voix accumulée dans le segment en cours (détection anticipée uniquement)
  lastFlushAt: 0, // horodatage (Date.now()) du dernier segment envoyé — protège minFlushIntervalMs
};

/**
 * Initialise le répertoire temporaire pour les fichiers audio
 */
function initTempDir(tempDir) {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
}

/**
 * ============================================================================
 *  CHANGELOG — remplacement de FFmpeg par la capture navigateur
 * ----------------------------------------------------------------------------
 *  listDevices() et autoDetectDevice() (énumération DirectShow via FFmpeg)
 *  sont retirées : elles n'étaient de toute façon plus appelées par
 *  startPipeline() (voir server.js, qui appelle startBrowserCapture()), et
 *  DirectShow ne voit tout simplement pas certains micros intégrés modernes
 *  (Intel Smart Sound Technology ou équivalent) — 0 périphérique énuméré,
 *  alors que ce même micro apparaît normalement dans Windows. Le choix du
 *  micro se fait maintenant dans setup.html via navigator.mediaDevices
 *  (même couche WASAPI que Windows), qui stocke un deviceId navigateur —
 *  voir loadMicrophones() dans setup.html. pickBestDevice() est conservée :
 *  son heuristique reste utile pour qui voudrait l'utiliser sur une liste
 *  de libellés navigateur (elle ne dépend pas de FFmpeg elle-même).
 * ============================================================================
 */

// Périphériques à écarter automatiquement : ce sont des boucles de retour
// (ce que les haut-parleurs émettent, pas ce que le micro capte) ou des
// "câbles" virtuels de routage audio — jamais un micro physique.
const LOOPBACK_PATTERNS =
  /stereo mix|what u hear|wave ?out|loopback|cable output|mix st[ée]r[ée]o|virtual cable/i;

// Mots qui indiquent fortement un vrai micro.
const MIC_HINT_PATTERNS = /micro|mic\b|headset|casque|webcam/i;

/**
 * Choisit le périphérique le plus probable parmi une liste détectée.
 * Heuristique : élimine les boucles de retour/périphériques virtuels,
 * privilégie les noms contenant "micro"/"mic"/"casque"/"webcam", et à
 * défaut garde le premier de la liste (ordre renvoyé par Windows, où le
 * périphérique par défaut apparaît généralement en premier).
 * @param {string[]} devices
 * @returns {{ chosen: string|null, candidates: string[], rejected: string[] }}
 */
function pickBestDevice(devices) {
  if (!devices || devices.length === 0) {
    return { chosen: null, candidates: [], rejected: [] };
  }
  const rejected = devices.filter((d) => LOOPBACK_PATTERNS.test(d));
  const candidates = devices.filter((d) => !LOOPBACK_PATTERNS.test(d));

  if (candidates.length === 0) {
    // Rien de sûr : mieux vaut ne rien choisir que de capter un loopback.
    return { chosen: null, candidates: [], rejected };
  }
  if (candidates.length === 1) {
    return { chosen: candidates[0], candidates, rejected };
  }

  const withMicHint = candidates.filter((d) => MIC_HINT_PATTERNS.test(d));
  const chosen = withMicHint.length > 0 ? withMicHint[0] : candidates[0];
  return { chosen, candidates, rejected };
}

/**
 * CORRECTIF (audit — remplacement de FFmpeg par la capture navigateur) :
 * démarre une session de capture SANS lancer de processus FFmpeg. La
 * source des échantillons PCM est maintenant `dashboard.html` (Web Audio /
 * getUserMedia, exécuté dans le renderer — seul endroit avec accès micro
 * sans dépendre de DirectShow), qui pousse ses chunks via IPC jusqu'ici en
 * appelant feedPcmChunk() ci-dessous. Le reste du pipeline (segmentation en
 * handleAudioData, écriture WAV, callback onAudioSegment vers la
 * transcription) est RÉUTILISÉ TEL QUEL — handleAudioData() ne s'est
 * jamais soucié de la provenance des octets, seulement de leur format
 * (PCM16LE mono 16kHz), donc aucune duplication de logique ici.
 * @param {Object} [options] - surcharge de CONFIG (sampleRate, etc.)
 */
function startBrowserCapture(options = {}) {
  if (STATE.isRecording) {
    console.warn('[audio-capture] Enregistrement déjà en cours');
    return;
  }

  const config = { ...CONFIG, ...options };
  initTempDir(config.tempDir);

  STATE.isRecording = true;
  STATE.segmentCount = 0;
  STATE.audioBuffer = [];
  STATE.browserCaptureConfig = config;
  STATE.frameAccumulator = Buffer.alloc(0);
  STATE.noiseFloor = config.initialNoiseFloor;
  STATE.segmentHasSpeech = false;
  STATE.consecutiveSilentFrameMs = 0;
  STATE.voicedFrameMsInSegment = 0;
  STATE.lastFlushAt = 0; // pas de délai artificiel avant le tout premier segment

  console.log(
    '[audio-capture] Capture navigateur (Web Audio, sans FFmpeg) démarrée — ' +
      'en attente de chunks PCM du renderer.'
  );
}

/**
 * Reçoit un chunk PCM16LE mono envoyé par le renderer (dashboard.html) et le
 * fait passer par exactement la même logique de segmentation/transcription
 * que le flux stdout de FFmpeg utilisait auparavant.
 * @param {Buffer} buffer - PCM16LE, mono, au sampleRate de STATE.browserCaptureConfig
 */
function feedPcmChunk(buffer) {
  if (!STATE.isRecording || !STATE.browserCaptureConfig) {
    // Chunk arrivé après un stop (course renderer/worker normale à l'arrêt) : ignoré sans bruit.
    return;
  }
  handleAudioData(buffer, STATE.browserCaptureConfig);
}

/**
 * Calcule le RMS (Root Mean Square) normalisé (0-1) d'un buffer PCM16LE.
 * @param {Buffer} buffer - échantillons PCM16LE
 * @returns {number} niveau RMS normalisé par l'amplitude max int16 (32768)
 */
function computeRms(buffer) {
  const sampleCount = buffer.length / 2;
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

// Taille des sous-fenêtres utilisées pour l'analyse VAD à l'intérieur d'un
// segment. 100ms est un bon compromis (assez court pour détecter des
// silences internes, assez long pour rester rapide en JS pur, sans lib
// externe).
const VAD_FRAME_MS = 100;

/**
 * Analyse un segment PCM déjà assemblé et retourne la durée totale de voix
 * détectée à l'intérieur, en découpant le segment en sous-fenêtres de
 * VAD_FRAME_MS et en comptant celles qui dépassent config.silenceThreshold.
 *
 * MISE À JOUR (VAD streaming) : cette fonction reste volontairement simple
 * (RMS par sous-fenêtre, seuil STATIQUE config.silenceThreshold) — c'est le
 * filtre final "ce segment déjà découpé mérite-t-il d'être envoyé au STT ?",
 * appelé une fois par segment dans flushSegment(). La state machine
 * Silence/Speech/Trailing à seuil ADAPTATIF (bruit ambiant appris en continu)
 * qui décide QUAND couper un segment, elle, vit maintenant dans
 * processStreamingFrame() ci-dessous — les deux couches sont volontairement
 * séparées : l'une décide du découpage en temps réel, l'autre du go/no-go
 * final avec un seuil prévisible et testable.
 * @param {Buffer} segmentBuffer - PCM16LE du segment complet
 * @param {Object} config - config active (sampleRate, channels, bitDepth, silenceThreshold)
 * @returns {{ voicedMs: number, totalMs: number }}
 */
function analyzeVoiceActivity(segmentBuffer, config) {
  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const frameBytes = Math.floor((VAD_FRAME_MS / 1000) * samplesPerSecond * bytesPerSample);

  if (frameBytes <= 0 || segmentBuffer.length < frameBytes) {
    // Segment trop court pour être découpé : on l'analyse en un seul bloc.
    const rms = computeRms(segmentBuffer);
    const totalMs = (segmentBuffer.length / (samplesPerSecond * bytesPerSample)) * 1000;
    return { voicedMs: rms >= config.silenceThreshold ? totalMs : 0, totalMs };
  }

  let voicedFrames = 0;
  let totalFrames = 0;
  for (let offset = 0; offset + frameBytes <= segmentBuffer.length; offset += frameBytes) {
    const frame = segmentBuffer.slice(offset, offset + frameBytes);
    if (computeRms(frame) >= config.silenceThreshold) voicedFrames++;
    totalFrames++;
  }
  return { voicedMs: voicedFrames * VAD_FRAME_MS, totalMs: totalFrames * VAD_FRAME_MS };
}

/**
 * Traite UNE trame VAD (VAD_FRAME_MS) déjà extraite du flux entrant. Alimente
 * la state machine de détection anticipée de fin de phrase : met à jour
 * l'estimation adaptative du bruit ambiant pendant le silence, et déclenche
 * un flush précoce dès qu'un silence de fin de phrase (config.trailingSilenceMs)
 * suit un segment qui contenait déjà assez de voix (config.minSpeechDuration).
 * AJOUT (VAD streaming — capture de phrases plus rapide/robuste au bruit).
 * @param {Buffer} frame - trame PCM16LE de VAD_FRAME_MS
 * @param {Object} config - configuration active
 */
function processStreamingFrame(frame, config) {
  const rms = computeRms(frame);
  const adaptiveThreshold = Math.min(
    config.maxAdaptiveThreshold,
    Math.max(config.minAdaptiveThreshold, STATE.noiseFloor * config.noiseMarginMultiplier)
  );
  const isVoiced = rms >= adaptiveThreshold;

  if (isVoiced) {
    STATE.consecutiveSilentFrameMs = 0;
    STATE.voicedFrameMsInSegment += VAD_FRAME_MS;
    if (STATE.voicedFrameMsInSegment >= config.minSpeechDuration) {
      STATE.segmentHasSpeech = true;
    }
  } else {
    STATE.consecutiveSilentFrameMs += VAD_FRAME_MS;
    if (!STATE.segmentHasSpeech) {
      // On n'a encore détecté aucune voix dans ce segment : ce silence est
      // du bruit ambiant fiable, on peut affiner l'estimation dessus. Une
      // fois de la voix détectée, on arrête d'adapter pour ne pas laisser
      // un souffle/une respiration entre deux phrases faire dériver le
      // seuil vers le haut et rater le début de la phrase suivante.
      STATE.noiseFloor =
        STATE.noiseFloor * (1 - config.noiseFloorAdaptRate) + rms * config.noiseFloorAdaptRate;
    }
  }

  const sinceLastFlushMs = Date.now() - STATE.lastFlushAt;
  if (
    STATE.segmentHasSpeech &&
    STATE.consecutiveSilentFrameMs >= config.trailingSilenceMs &&
    sinceLastFlushMs >= config.minFlushIntervalMs
  ) {
    flushSegment(config, { early: true });
  }
}

/**
 * Concatène le segment en cours, décide (via analyzeVoiceActivity, seuil
 * STATIQUE config.silenceThreshold) s'il mérite d'être envoyé au STT, et
 * réinitialise l'état du segment en cours. Appelée soit tôt (silence de fin
 * de phrase détecté par processStreamingFrame), soit au plafond de sécurité
 * (segmentDuration atteint, voir handleAudioData).
 * @param {Object} config - configuration active
 * @param {{ early?: boolean }} [opts] - early=true : fin de phrase naturelle
 *   (pas de chevauchement conservé) ; early=false : coupure de sécurité en
 *   pleine parole (chevauchement conservé pour le contexte Whisper).
 */
function flushSegment(config, { early = false } = {}) {
  const segmentBuffer = Buffer.concat(STATE.audioBuffer);
  if (segmentBuffer.length === 0) return;

  STATE.lastFlushAt = Date.now();

  if (early) {
    // Silence de fin de phrase confirmé : rien à reporter sur le prochain
    // segment, la coupure tombe déjà à un bon endroit.
    STATE.audioBuffer = [];
  } else {
    const bytesPerSample = config.bitDepth / 8;
    const samplesPerSecond = config.sampleRate * config.channels;
    const overlapSize = (config.overlapDuration / 1000) * samplesPerSecond * bytesPerSample;
    const keepSize = Math.max(0, segmentBuffer.length - overlapSize);
    STATE.audioBuffer = keepSize > 0 ? [segmentBuffer.slice(keepSize)] : [];
  }

  // Le segment suivant repart de zéro pour la détection de fin de phrase.
  // noiseFloor n'est PAS réinitialisé : l'estimation du bruit de la pièce
  // doit survivre aux coupures de segment pour rester utile sur la durée
  // d'un culte entier.
  STATE.segmentHasSpeech = false;
  STATE.consecutiveSilentFrameMs = 0;
  STATE.voicedFrameMsInSegment = 0;

  // AJOUT (VAD réel) : avant d'écrire le WAV et de déclencher le STT,
  // on vérifie que le segment contient assez de voix détectée. Sans ce
  // filtre, un segment de 5s de silence/musique (bruit de fond, temps
  // de transition, chant) partait quand même vers Groq/Deepgram — coût
  // API inutile et source de faux positifs de transcription.
  const voiceInfo = analyzeVoiceActivity(segmentBuffer, config);
  if (voiceInfo.voicedMs < config.minSpeechDuration) {
    STATE.segmentCount++;
    console.log(
      `[audio-capture] Segment ${STATE.segmentCount} ignoré (silence — ` +
        `${voiceInfo.voicedMs}ms de voix détectée < seuil ${config.minSpeechDuration}ms)`
    );
    // CORRECTIF (problème récurrent — transcription qui ne démarre jamais
    // sans qu'aucune erreur ne soit visible) : ce rejet était auparavant
    // silencieux (console.log uniquement, jamais vu en usage normal). Si
    // le micro reste durablement sous silenceThreshold (mauvais gain,
    // mauvais périphérique sélectionné...), CHAQUE segment est rejeté et
    // rien n'apparaît jamais côté opérateur, sans qu'aucun message
    // n'explique pourquoi. Rendu visible via ce callback ; server.js
    // limite lui-même la fréquence d'alerte pour ne pas spammer le
    // dashboard si le silence est normal (temps mort entre deux prises
    // de parole).
    if (STATE.callbacks.onSegmentSkipped) {
      STATE.callbacks.onSegmentSkipped({
        voicedMs: voiceInfo.voicedMs,
        totalMs: voiceInfo.totalMs,
        threshold: config.silenceThreshold,
        minSpeechDuration: config.minSpeechDuration,
      });
    }
    return;
  }

  // Créer le fichier WAV pour ce segment
  const wavBuffer = createWavFile(
    segmentBuffer,
    config.sampleRate,
    config.channels,
    config.bitDepth
  );

  STATE.segmentCount++;
  const segmentFile = path.join(config.tempDir, `segment_${STATE.segmentCount}.wav`);
  fs.writeFileSync(segmentFile, wavBuffer);

  console.log(
    `[audio-capture] Segment ${STATE.segmentCount} créé (${segmentBuffer.length} bytes, ` +
      `${voiceInfo.voicedMs}ms de voix détectée${early ? ', coupure anticipée (fin de phrase)' : ''})`
  );

  // Envoyer le segment au callback
  if (STATE.callbacks.onAudioSegment) {
    STATE.callbacks.onAudioSegment(segmentFile);
  }
}

/**
 * Traite les données audio reçues : alimente à la fois l'accumulateur de
 * segment (octets bruts, pour l'écriture WAV finale) et le scan VAD
 * streaming trame par trame (détection anticipée de fin de phrase, voir
 * processStreamingFrame). segmentDuration agit désormais comme un plafond
 * de sécurité — la coupure normale arrive plus tôt, dès qu'un silence de
 * fin de phrase est détecté.
 * @param {Buffer} data - Données audio brutes (PCM16LE)
 * @param {Object} config - Configuration actuelle
 */
function handleAudioData(data, config) {
  STATE.audioBuffer.push(data);
  STATE.frameAccumulator = Buffer.concat([STATE.frameAccumulator, data]);

  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const frameBytes = Math.floor((VAD_FRAME_MS / 1000) * samplesPerSecond * bytesPerSample);

  while (frameBytes > 0 && STATE.frameAccumulator.length >= frameBytes) {
    const frame = STATE.frameAccumulator.slice(0, frameBytes);
    STATE.frameAccumulator = STATE.frameAccumulator.slice(frameBytes);
    processStreamingFrame(frame, config);
  }

  // Plafond de sécurité : même sans silence de fin de phrase détecté (voix
  // continue), on ne laisse jamais un segment grossir indéfiniment.
  const segmentSize = (config.segmentDuration / 1000) * samplesPerSecond * bytesPerSample;
  const bufferSize = STATE.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
  if (bufferSize >= segmentSize) {
    flushSegment(config, { early: false });
  }
}

/**
 * Crée un fichier WAV à partir de données PCM brutes
 * @param {Buffer} pcmData - Données PCM
 * @param {number} sampleRate - Taux d'échantillonnage
 * @param {number} channels - Nombre de canaux
 * @param {number} bitDepth - Bits par échantillon
 * @returns {Buffer} Fichier WAV complet
 */
function createWavFile(pcmData, sampleRate, channels, bitDepth) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Arrête la capture audio (capture navigateur uniquement — plus de process
 * FFmpeg à tuer depuis le remplacement par getUserMedia/Web Audio).
 * @returns {Promise<void>}
 */
function stopRecording() {
  STATE.isRecording = false;
  STATE.browserCaptureConfig = null;
  STATE.audioBuffer = [];
  STATE.frameAccumulator = Buffer.alloc(0);
  STATE.segmentHasSpeech = false;
  STATE.consecutiveSilentFrameMs = 0;
  STATE.voicedFrameMsInSegment = 0;
  console.log('[audio-capture] Capture arrêtée.');
  cleanupTempFiles({ force: true });
  return Promise.resolve();
}

/**
 * Enregistre les callbacks d'événements
 * @param {Object} callbacks - { onAudioSegment, onError }
 */
function on(callbacks) {
  STATE.callbacks = { ...STATE.callbacks, ...callbacks };
}

/**
 * Vérifie si l'enregistrement est en cours
 * @returns {boolean}
 */
function isRecording() {
  return STATE.isRecording;
}

/**
 * Nettoie les fichiers temporaires de manière robuste
 * @param {Object} options - Options de nettoyage
 * @param {boolean} options.force - Force le nettoyage même si l'enregistrement est en cours
 * @param {number} options.maxAgeMs - Âge maximum des fichiers à conserver (défaut: 3 minutes)
 */
function cleanupTempFiles(options = {}) {
  const { force = false, maxAgeMs = 180000 } = options; // 3 minutes par défaut (optimisé)

  if (!fs.existsSync(CONFIG.tempDir)) {
    return;
  }

  // Ne pas nettoyer si l'enregistrement est en cours sauf si force=true
  if (STATE.isRecording && !force) {
    console.log('[audio-capture] Enregistrement en cours, nettoyage partiel uniquement');
  }

  const files = fs.readdirSync(CONFIG.tempDir);
  let cleanedCount = 0;
  let keptCount = 0;
  const now = Date.now();

  files.forEach((file) => {
    const filePath = path.join(CONFIG.tempDir, file);

    try {
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      // Nettoyer les fichiers plus vieux que maxAgeMs ou si force=true
      if (fileAge > maxAgeMs || force) {
        fs.unlinkSync(filePath);
        cleanedCount++;
      } else {
        keptCount++;
      }
    } catch (error) {
      console.warn('[audio-capture] Impossible de supprimer:', filePath, error.message);
    }
  });

  if (cleanedCount > 0) {
    console.log(
      `[audio-capture] ${cleanedCount} fichier(s) temporaire(s) nettoyé(s)${keptCount > 0 ? `, ${keptCount} conservé(s)` : ''}`
    );
  }

  // Tenter de supprimer le répertoire temporaire s'il est vide
  try {
    const remainingFiles = fs.readdirSync(CONFIG.tempDir);
    if (remainingFiles.length === 0) {
      fs.rmdirSync(CONFIG.tempDir);
      console.log('[audio-capture] Répertoire temporaire supprimé (vide)');
    }
  } catch (_error) {
    // Le répertoire n'est pas vide ou ne peut pas être supprimé
  }
}

module.exports = {
  startBrowserCapture,
  feedPcmChunk,
  stopRecording,
  on,
  isRecording,
  cleanupTempFiles,
  getConfig: () => ({ ...CONFIG }),
  // Heuristique de choix de micro — pure, ne dépend plus de FFmpeg. Exposée
  // pour les tests ; setup.html fait son propre choix manuel via l'UI.
  pickBestDevice,
  // AJOUT (VAD réel) — exposées pour tests unitaires (test-audio-capture.js).
  computeRms,
  analyzeVoiceActivity,
};
