/**
 * ============================================================================
 *  audio-capture.js — Module de segmentation audio en continu
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.5.0 — Remplacement de FFmpeg/DirectShow par la capture
 *  native du navigateur (getUserMedia + AudioWorklet, voir capture.html) :
 *    - FFmpeg ne voyait tout simplement pas certains micros (backend dshow),
 *      indépendamment du nom affiché — un problème de couche de capture, pas
 *      de nommage. La capture native utilise exactement la même couche audio
 *      que les Paramètres Windows, où le micro apparaît bien.
 *    - Ce module ne spawn plus aucun process externe : il reçoit des blocs
 *      PCM16 mono 16kHz déjà décodés (via pushAudioChunk(), appelé depuis
 *      server.js quand le worker reçoit un message {type:'audio-chunk'} —
 *      voir main.js qui relaie capture.html -> worker), et garde exactement
 *      la même logique de segmentation/chevauchement/nettoyage qu'avant
 *      (backend-agnostique dès le départ, donc inchangée).
 *    - listDevices()/autoDetectDevice() (énumération via `ffmpeg -f dshow
 *      -list_devices`) ont disparu : l'énumération des micros se fait
 *      désormais dans capture.html (navigator.mediaDevices.enumerateDevices())
 *      via detectAudioDevices() dans main.js. pickBestDevice() reste ici :
 *      c'est une heuristique pure sur de simples libellés, indépendante du
 *      backend, réutilisée par main.js pour présélectionner un micro parmi
 *      les libellés renvoyés par la fenêtre de capture.
 *
 *  ARCHITECTURE:
 *    Micro → capture.html (getUserMedia/AudioWorklet) → IPC → main.js →
 *    worker.postMessage() → server.js → audio-capture.js (segmentation) →
 *    groq-wrapper.js (cloud) → server.js → overlay.html
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
  segmentDuration: 5000,  // 5 secondes (optimisé pour réactivité)
  overlapDuration: 400,   // 400ms de chevauchement (meilleur contexte)
  silenceThreshold: 0.3,  // Seuil de silence pour VAD (0-1)
  minSpeechDuration: 500, // Durée minimum de parole en ms
  // Dans l'app empaquetée (asar: true), __dirname pointe à l'intérieur de
  // app.asar, une archive à LECTURE SEULE — fs.mkdirSync() y échoue
  // systématiquement avec "ENOTDIR: not a directory". Le dossier temporaire
  // de l'OS (os.tmpdir()) est le bon choix dans TOUS les modes d'exécution
  // (empaqueté, dev, `node server.js` standalone) sans dépendre d'aucune
  // configuration de packaging.
  tempDir: path.join(os.tmpdir(), 'churchoverlay-audio'),
};

// État du module
const STATE = {
  isRecording: false,
  audioBuffer: [],
  segmentCount: 0,
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

// Périphériques à écarter automatiquement : ce sont des boucles de retour
// (ce que les haut-parleurs émettent, pas ce que le micro capte) ou des
// "câbles" virtuels de routage audio — jamais un micro physique. Le
// navigateur peut renvoyer ces mêmes types de périphériques dans
// enumerateDevices() (ex: "Stereo Mix", "CABLE Output"), donc l'heuristique
// reste pertinente même sans dshow.
const LOOPBACK_PATTERNS = /stereo mix|what u hear|wave ?out|loopback|cable output|mix st[ée]r[ée]o|virtual cable/i;

// Mots qui indiquent fortement un vrai micro.
const MIC_HINT_PATTERNS = /micro|mic\b|headset|casque|webcam/i;

/**
 * Choisit le périphérique le plus probable parmi une liste de libellés
 * (ex: ceux renvoyés par navigator.mediaDevices.enumerateDevices() dans
 * capture.html, relayés par main.js). Heuristique : élimine les boucles de
 * retour/périphériques virtuels, privilégie les noms contenant
 * "micro"/"mic"/"casque"/"webcam", et à défaut garde le premier de la liste.
 * @param {string[]} devices - libellés de périphériques
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
 * Démarre la capture : initialise l'état et le répertoire temporaire.
 * Ne lance plus aucun process — les échantillons arrivent via
 * pushAudioChunk(), poussés depuis capture.html/main.js.
 * @param {Object} options - Options de configuration (surcharge CONFIG)
 * @returns {Promise<void>}
 */
async function startRecording(options = {}) {
  if (STATE.isRecording) {
    console.warn('[audio-capture] Enregistrement déjà en cours');
    return;
  }

  const config = { ...CONFIG, ...options };
  initTempDir(config.tempDir);

  STATE.isRecording = true;
  STATE.segmentCount = 0;
  STATE.audioBuffer = [];
  console.log('[audio-capture] Prêt à recevoir des chunks audio (capture native).');
}

/**
 * Reçoit un bloc PCM16 mono en provenance de capture.html (relayé par
 * main.js -> worker.postMessage({type:'audio-chunk', buffer})). Appelée
 * depuis server.js sur réception de ce message.
 * @param {ArrayBuffer|Buffer} chunk - échantillons PCM16 LE mono
 * @param {Object} options - surcharge CONFIG (sampleRate/segmentDuration...)
 */
function pushAudioChunk(chunk, options = {}) {
  if (!STATE.isRecording) return;
  const config = { ...CONFIG, ...options };

  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  handleAudioData(buffer, config);
}

/**
 * Découpe le flux audio reçu en segments WAV (chevauchement inclus)
 * @param {Buffer} data - Données audio brutes (PCM16 LE)
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

    // Créer le fichier WAV pour ce segment
    const wavBuffer = createWavFile(segmentBuffer, config.sampleRate, config.channels, config.bitDepth);

    STATE.segmentCount++;
    const segmentFile = path.join(config.tempDir, `segment_${STATE.segmentCount}.wav`);
    fs.writeFileSync(segmentFile, wavBuffer);

    console.log(`[audio-capture] Segment ${STATE.segmentCount} créé (${segmentBuffer.length} bytes)`);

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
 * Arrête la capture audio (réinitialise l'état — aucun process à tuer)
 * @returns {Promise<void>}
 */
function stopRecording() {
  return new Promise((resolve) => {
    if (!STATE.isRecording) {
      console.warn('[audio-capture] Aucun enregistrement en cours');
      resolve();
      return;
    }

    console.log('[audio-capture] Arrêt de la capture audio...');
    STATE.isRecording = false;
    STATE.audioBuffer = [];
    console.log('[audio-capture] Capture audio arrêtée');
    // Nettoyer automatiquement les fichiers temporaires après l'arrêt
    cleanupTempFiles({ force: true });
    resolve();
  });
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
  startRecording,
  stopRecording,
  pushAudioChunk,
  on,
  isRecording,
  cleanupTempFiles,
  getConfig: () => ({ ...CONFIG }),
  // Heuristique de sélection de micro — pure, indépendante du backend de
  // capture. Réutilisée par main.js (detectAudioDevices()).
  pickBestDevice,
};
