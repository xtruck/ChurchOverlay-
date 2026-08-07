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
  sampleRate: 16000,      // recommandé pour Whisper large-v3 (Groq)
  channels: 1,            // Mono
  bitDepth: 16,           // PCM 16-bit
  // AJOUT (audit — reflexes plus rapides, gratuit) : 5000ms → 4000ms.
  // whisper-large-v3-turbo (voir groq-wrapper.js) transcrit un segment plus
  // vite que l'ancien modèle, donc raccourcir la fenêtre réduit la latence
  // perçue sans changer de fournisseur ni de coût — juste moins d'audio à
  // attendre avant l'envoi. 4s reste au-dessus du plancher usuel pour une
  // bonne précision Whisper (le contexte se dégrade nettement sous ~3s).
  segmentDuration: 4000,
  overlapDuration: 400,   // 400ms de chevauchement (meilleur contexte)
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
const LOOPBACK_PATTERNS = /stereo mix|what u hear|wave ?out|loopback|cable output|mix st[ée]r[ée]o|virtual cable/i;

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

  console.log('[audio-capture] Capture navigateur (Web Audio, sans FFmpeg) démarrée — ' +
    'en attente de chunks PCM du renderer.');
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
 * Volontairement simple (RMS par sous-fenêtre, pas de state machine
 * Silence/Speech/Trailing façon Rhema) : ici on ne fait QUE décider si un
 * segment déjà découpé mérite d'être envoyé au STT, pas gater l'audio en
 * temps réel frame par frame — donc pas besoin de la complexité d'un VAD
 * "streaming".
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
 * Traite les données audio reçues (segmentation, écriture WAV, callback).
 * @param {Buffer} data - Données audio brutes (PCM16LE)
 * @param {Object} config - Configuration actuelle
 */
function handleAudioData(data, config) {
  // Ajouter au buffer
  STATE.audioBuffer.push(data);

  // Calculer la taille du buffer en échantillons
  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const segmentSize = (config.segmentDuration / 1000) * samplesPerSecond * bytesPerSample;

  // Si le buffer est assez grand, créer un segment
  let bufferSize = STATE.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
  
  if (bufferSize >= segmentSize) {
    // Concaténer le buffer
    const segmentBuffer = Buffer.concat(STATE.audioBuffer);
    
    // Garder le chevauchement pour le prochain segment
    const overlapSize = (config.overlapDuration / 1000) * samplesPerSecond * bytesPerSample;
    const keepSize = Math.max(0, segmentBuffer.length - overlapSize);
    
    if (keepSize > 0) {
      STATE.audioBuffer = [segmentBuffer.slice(keepSize)];
    } else {
      STATE.audioBuffer = [];
    }

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
      return;
    }

    // Créer le fichier WAV pour ce segment
    const wavBuffer = createWavFile(segmentBuffer, config.sampleRate, config.channels, config.bitDepth);
    
    STATE.segmentCount++;
    const segmentFile = path.join(config.tempDir, `segment_${STATE.segmentCount}.wav`);
    fs.writeFileSync(segmentFile, wavBuffer);

    console.log(`[audio-capture] Segment ${STATE.segmentCount} créé (${segmentBuffer.length} bytes, ${voiceInfo.voicedMs}ms de voix détectée)`);

    // Envoyer le segment au callback
    if (STATE.callbacks.onAudioSegment) {
      STATE.callbacks.onAudioSegment(segmentFile);
    }
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
    console.log(`[audio-capture] ${cleanedCount} fichier(s) temporaire(s) nettoyé(s)${keptCount > 0 ? `, ${keptCount} conservé(s)` : ''}`);
  }
  
  // Tenter de supprimer le répertoire temporaire s'il est vide
  try {
    const remainingFiles = fs.readdirSync(CONFIG.tempDir);
    if (remainingFiles.length === 0) {
      fs.rmdirSync(CONFIG.tempDir);
      console.log('[audio-capture] Répertoire temporaire supprimé (vide)');
    }
  } catch (error) {
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
