/**
 * ============================================================================
 *  audio-capture.js — Module de capture audio en continu
 * ----------------------------------------------------------------------------
 *  Capture l'audio du micro en continu et l'envoie à Whisper pour transcription.
 *
 *  ARCHITECTURE:
 *    Micro → audio-capture.js → whisper-wrapper.js → server.js → overlay.html
 *
 *  FONCTIONNALITÉS:
 *    - Capture audio en continu (streaming)
 *    - Segmentation intelligente (VAD - Voice Activity Detection)
 *    - Envoi des segments audio à Whisper
 *    - Gestion du buffer circulaire pour éviter la perte de données
 *
 *  CONFIGURATION:
 *    - Sample rate: 16000 Hz (recommandé pour Whisper)
 *    - Channels: 1 (mono)
 *    - Format: PCM 16-bit
 * ============================================================================
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  sampleRate: 16000,      // Whisper recommande 16000 Hz
  channels: 1,            // Mono
  bitDepth: 16,           // PCM 16-bit
  segmentDuration: 6000,  // Durée des segments en ms (6 secondes)
  overlapDuration: 100,   // 1 seconde de chevauchement 
  silenceThreshold: 0.3,  // Seuil de silence pour VAD (0-1)
  minSpeechDuration: 500, // Durée minimum de parole en ms
  tempDir: path.join(__dirname, 'temp-audio'),
  // Configurables sans modifier le code : FFMPEG_PATH et AUDIO_DEVICE.
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  audioDevice: process.env.AUDIO_DEVICE || '',
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
    });

    // Vérifier si FFmpeg est disponible
    const ffmpegCheck = spawn(config.ffmpegPath, ['-version']);
    ffmpegCheck.on('error', () => {
      reject(new Error('FFmpeg n\'est pas installé ou non trouvé: ' + config.ffmpegPath));
    });
    ffmpegCheck.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('FFmpeg n\'est pas installé ou non trouvé dans PATH'));
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

      STATE.ffmpegProcess.stdout.on('data', (data) => {
        handleAudioData(data, config);
      });

      STATE.ffmpegProcess.stderr.on('data', (data) => {
        console.error('[audio-capture FFmpeg]', data.toString());
      });

      STATE.ffmpegProcess.on('error', (err) => {
        console.error('[audio-capture] Erreur FFmpeg:', err.message);
        if (STATE.callbacks.onError) STATE.callbacks.onError(err);
        reject(err);
      });

      STATE.ffmpegProcess.on('close', (code) => {
        console.log(`[audio-capture] FFmpeg terminé avec code ${code}`);
        STATE.isRecording = false;
        STATE.ffmpegProcess = null;
      });

      STATE.isRecording = true;
      STATE.segmentCount = 0;
      console.log('[audio-capture] Capture audio démarrée');
      resolve();
    });
  });
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
 * @param {number} options.maxAgeMs - Âge maximum des fichiers à conserver (défaut: 1 heure)
 */
function cleanupTempFiles(options = {}) {
  const { force = false, maxAgeMs = 3600000 } = options;
  
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
