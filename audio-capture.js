/**
 * ============================================================================
 *  audio-capture.js — Module de capture audio en continu
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.4.0 — Auto-reconnexion micro
 *    Si FFmpeg s'arrête de façon inattendue en cours d'enregistrement (micro
 *    USB débranché, pilote qui plante...), le module ne meurt plus en
 *    silence : il retente automatiquement de relancer la capture avec un
 *    backoff exponentiel (2s, 4s, 8s, 16s, puis 30s en continu), sans
 *    jamais abandonner tant que stopRecording() n'a pas été appelé
 *    explicitement. Dès que le flux audio reprend (données reçues), la
 *    reconnexion est considérée réussie. Nouveaux callbacks disponibles via
 *    on({ onDeviceLost, onReconnecting, onReconnected }).
 *
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
 *    - Reconnexion automatique en cas de coupure micro (v0.4.0)
 *
 *  CONFIGURATION:
 *    - Sample rate: 16000 Hz (recommandé pour Whisper large-v3 côté Groq)
 *    - Channels: 1 (mono)
 *    - Format: PCM 16-bit
 * ============================================================================
 */

const { spawn } = require('child_process');
const fs = require('fs');
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
  tempDir: path.join(__dirname, 'temp-audio'),
  // Configurables sans modifier le code : FFMPEG_PATH et AUDIO_DEVICE.
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  audioDevice: process.env.AUDIO_DEVICE || '',
};

// v0.4.0 — Auto-reconnexion micro (débranchement/rebranchement USB en
// cours de service, sans devoir relancer l'app).
const RECONNECT_CONFIG = {
  baseDelayMs: 2000,   // 1re tentative : 2s après la coupure
  maxDelayMs: 30000,   // plafonné à 30s entre deux tentatives
  factor: 2,           // backoff exponentiel (2s, 4s, 8s, 16s, 30s, 30s…)
};

// État du module
const STATE = {
  isRecording: false,
  ffmpegProcess: null,
  audioBuffer: [],
  segmentCount: 0,
  callbacks: {
    onAudioSegment: null,
    onError: null,
    // v0.4.0 — cycle de vie de la reconnexion micro
    onDeviceLost: null,   // (err) => void — le micro vient de décrocher
    onReconnecting: null, // (attempt, delayMs) => void — nouvelle tentative planifiée
    onReconnected: null,  // () => void — le micro répond de nouveau
  },
  // v0.4.0 — reconnexion
  activeConfig: null,       // config utilisée par le flux courant (pour relancer à l'identique)
  stopRequested: false,     // true seulement si stopRecording() a été appelé explicitement
  reconnectTimer: null,
  reconnectAttempts: 0,
  hasReceivedDataThisSession: false,
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
 * Démarre la capture audio via FFmpeg
 * @param {Object} options - Options de configuration (surcharge CONFIG)
 * @returns {Promise<void>}
 */
function startRecording(options = {}) {
  return new Promise((resolve, reject) => {
    if (STATE.isRecording) {
      console.warn('[audio-capture] Enregistrement déjà en cours');
      resolve();
      return;
    }

    const config = { ...CONFIG, ...options };
    initTempDir(config.tempDir);

    if (!config.audioDevice) {
      reject(new Error('Aucun micro configuré. Lancez "node list-audio-devices.js", puis définissez AUDIO_DEVICE avec le nom exact du micro.'));
      return;
    }

    console.log('[audio-capture] Démarrage de la capture audio...');
    console.log('[audio-capture] Configuration:', {
      sampleRate: config.sampleRate,
      channels: config.channels,
      segmentDuration: config.segmentDuration + 'ms',
      overlapDuration: config.overlapDuration + 'ms',
    });

    STATE.activeConfig = config;
    STATE.stopRequested = false;
    STATE.reconnectAttempts = 0;
    clearReconnectTimer();

    spawnFfmpegProcess(config, { isReconnectAttempt: false })
      .then(resolve)
      .catch(reject);
  });
}

/**
 * Vérifie FFmpeg puis lance le process de capture pour la config donnée.
 * Utilisé à la fois par le démarrage initial (startRecording) et par les
 * tentatives de reconnexion automatique (scheduleReconnect) — dans ce
 * dernier cas, aucune erreur n'est rejetée vers un appelant : on notifie
 * juste via les callbacks onDeviceLost/onReconnecting/onReconnected et on
 * replanifie une tentative.
 *
 * @param {Object} config
 * @param {Object} opts
 * @param {boolean} opts.isReconnectAttempt
 * @returns {Promise<void>}
 */
function spawnFfmpegProcess(config, { isReconnectAttempt }) {
  return new Promise((resolve, reject) => {
    const failFast = (err) => {
      if (isReconnectAttempt) {
        // On ne rejette jamais côté appelant en reconnexion : on replanifie.
        scheduleReconnect(config, err);
        resolve(); // résout quand même la promesse interne (pas d'appelant en attente)
      } else {
        reject(err);
      }
    };

    // Vérifier si FFmpeg est disponible
    const ffmpegCheck = spawn(config.ffmpegPath, ['-version']);
    ffmpegCheck.on('error', () => {
      failFast(new Error('FFmpeg n\'est pas installé ou non trouvé: ' + config.ffmpegPath));
    });
    ffmpegCheck.on('close', (code) => {
      if (code !== 0) {
        failFast(new Error('FFmpeg n\'est pas installé ou non trouvé dans PATH'));
        return;
      }

      // Lancer FFmpeg pour capture audio
      // Utilisation de dshow (DirectShow) sur Windows
      const ffmpegArgs = [
        '-f', 'dshow',           // DirectShow (Windows)
        '-i', `audio=${config.audioDevice}`,
        '-ar', config.sampleRate.toString(),
        '-ac', config.channels.toString(),
        '-f', 's16le',           // PCM 16-bit little-endian
        '-loglevel', 'error',    // Réduire les logs
        'pipe:1',                // Sortie vers stdout
      ];

      STATE.ffmpegProcess = spawn(config.ffmpegPath, ffmpegArgs);
      STATE.hasReceivedDataThisSession = false;

      STATE.ffmpegProcess.stdout.on('data', (data) => {
        if (!STATE.hasReceivedDataThisSession) {
          STATE.hasReceivedDataThisSession = true;
          // De la vraie donnée audio arrive : le micro répond bel et bien.
          if (isReconnectAttempt) {
            console.log('[audio-capture] ✅ Micro reconnecté — flux audio rétabli.');
            STATE.reconnectAttempts = 0;
            if (STATE.callbacks.onReconnected) STATE.callbacks.onReconnected();
          }
        }
        handleAudioData(data, config);
      });

      STATE.ffmpegProcess.stderr.on('data', (data) => {
        console.error('[audio-capture FFmpeg]', data.toString());
      });

      STATE.ffmpegProcess.on('error', (err) => {
        console.error('[audio-capture] Erreur FFmpeg:', err.message);
        if (STATE.callbacks.onError) STATE.callbacks.onError(err);
        failFast(err);
      });

      STATE.ffmpegProcess.on('close', (code) => {
        console.log(`[audio-capture] FFmpeg terminé avec code ${code}`);
        const wasRecording = STATE.isRecording;
        STATE.isRecording = false;
        STATE.ffmpegProcess = null;

        // Arrêt volontaire (stopRecording()) : rien à faire de plus, c'est
        // stopRecording() elle-même qui gère la suite via son propre
        // listener 'close'.
        if (STATE.stopRequested) return;

        // Coupure inattendue en cours de service (micro débranché, pilote
        // qui plante, etc.) : on tente de se reconnecter automatiquement
        // plutôt que de laisser le pipeline mort en silence.
        if (wasRecording || isReconnectAttempt) {
          const err = new Error(`FFmpeg s'est arrêté de façon inattendue (code ${code}) — micro probablement débranché.`);
          if (!isReconnectAttempt) {
            console.error('[audio-capture] 🔌 Perte du micro détectée — tentative de reconnexion automatique…');
            if (STATE.callbacks.onDeviceLost) STATE.callbacks.onDeviceLost(err);
          }
          scheduleReconnect(config, err);
        }
      });

      STATE.isRecording = true;
      STATE.segmentCount = 0;
      console.log('[audio-capture] Capture audio démarrée');
      resolve();
    });
  });
}

/**
 * Planifie une nouvelle tentative de reconnexion avec backoff exponentiel
 * (2s, 4s, 8s, 16s, 30s, 30s, 30s…). Ne s'arrête jamais tant que
 * stopRecording() n'a pas été appelé explicitement — un service peut durer
 * des heures, mieux vaut continuer à réessayer que d'abandonner.
 */
function scheduleReconnect(config, err) {
  if (STATE.stopRequested) return;
  clearReconnectTimer();

  STATE.reconnectAttempts += 1;
  const delayMs = Math.min(
    RECONNECT_CONFIG.baseDelayMs * Math.pow(RECONNECT_CONFIG.factor, STATE.reconnectAttempts - 1),
    RECONNECT_CONFIG.maxDelayMs
  );

  console.warn(
    `[audio-capture] 🔄 Reconnexion micro : tentative #${STATE.reconnectAttempts} dans ${Math.round(delayMs / 1000)}s ` +
    `(${err ? err.message : 'raison inconnue'})`
  );
  if (STATE.callbacks.onReconnecting) STATE.callbacks.onReconnecting(STATE.reconnectAttempts, delayMs);

  STATE.reconnectTimer = setTimeout(() => {
    if (STATE.stopRequested) return;
    spawnFfmpegProcess(config, { isReconnectAttempt: true }).catch(() => {
      // spawnFfmpegProcess ne rejette jamais en mode reconnexion (voir
      // failFast ci-dessus) — ce .catch est juste une garde défensive.
    });
  }, delayMs);
}

function clearReconnectTimer() {
  if (STATE.reconnectTimer) {
    clearTimeout(STATE.reconnectTimer);
    STATE.reconnectTimer = null;
  }
}

/**
 * Traite les données audio reçues de FFmpeg
 * @param {Buffer} data - Données audio brutes
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
 * Arrête la capture audio
 * @returns {Promise<void>}
 */
function stopRecording() {
  return new Promise((resolve) => {
    // v0.4.0 : empêche toute tentative de reconnexion automatique de
    // redémarrer FFmpeg juste après un arrêt volontaire.
    STATE.stopRequested = true;
    clearReconnectTimer();
    STATE.reconnectAttempts = 0;

    if (!STATE.ffmpegProcess) {
      console.warn('[audio-capture] Aucun enregistrement en cours');
      resolve();
      return;
    }

    console.log('[audio-capture] Arrêt de la capture audio...');

    STATE.ffmpegProcess.on('close', () => {
      STATE.isRecording = false;
      STATE.ffmpegProcess = null;
      STATE.audioBuffer = [];
      console.log('[audio-capture] Capture audio arrêtée');
      // Nettoyer automatiquement les fichiers temporaires après l'arrêt
      cleanupTempFiles({ force: true });
      resolve();
    });

    // Tuer le processus FFmpeg
    STATE.ffmpegProcess.kill('SIGTERM');

    // Force kill après 5 secondes
    setTimeout(() => {
      if (STATE.ffmpegProcess) {
        STATE.ffmpegProcess.kill('SIGKILL');
      }
    }, 5000);
  });
}

/**
 * Enregistre les callbacks d'événements
 * @param {Object} callbacks - { onAudioSegment, onError, onDeviceLost,
 *        onReconnecting, onReconnected } (les 3 derniers : v0.4.0)
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
  on,
  isRecording,
  cleanupTempFiles,
  getConfig: () => ({ ...CONFIG }),
};
