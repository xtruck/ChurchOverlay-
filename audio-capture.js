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

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDshowAudioDevices } = require('./dshow-parser');
const { resolveFfmpegPath } = require('./setup-ffmpeg');

// Configuration
const CONFIG = {
  sampleRate: 16000,      // recommandé pour Whisper large-v3 (Groq)
  channels: 1,            // Mono
  bitDepth: 16,           // PCM 16-bit
  segmentDuration: 5000,  // 5 secondes (optimisé pour réactivité)
  overlapDuration: 400,   // 400ms de chevauchement (meilleur contexte)
  silenceThreshold: 0.3,  // Seuil de silence pour VAD (0-1)
  minSpeechDuration: 500, // Durée minimum de parole en ms
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
  // Configurables sans modifier le code : FFMPEG_PATH et AUDIO_DEVICE.
  // AUDIO_DEVICE peut désormais rester VIDE : startRecording() détecte et
  // choisit automatiquement un micro (voir autoDetectDevice() plus bas).
  // CORRECTIF : dupliquait `process.env.FFMPEG_PATH || 'ffmpeg'` en dur,
  // ignorant le binaire auto-installé dans ffmpeg/ffmpeg.exe. Fonctionnait
  // par accident dans l'app Electron (main.js injecte FFMPEG_PATH=<chemin
  // résolu> dans l'environnement du worker), mais cassait en usage
  // standalone (`node server.js` / `npm run server-only`) sur un poste
  // sans FFmpeg système.
  ffmpegPath: resolveFfmpegPath(),
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
 * ============================================================================
 *  AUTO-DÉTECTION DU MICRO (ajouté à la demande : AUDIO_DEVICE ne devrait
 *  plus être obligatoire à configurer à la main)
 * ----------------------------------------------------------------------------
 *  DirectShow (le backend Windows utilisé par FFmpeg ici, -f dshow) n'a
 *  PAS de notion native de "périphérique par défaut" — contrairement à
 *  WASAPI ou PulseAudio, chaque appel dshow doit nommer un périphérique
 *  précis (`audio=<nom exact>`). Il n'existe donc pas de flag FFmpeg du
 *  type `audio=default` qui fonctionne avec dshow : c'est une limite du
 *  backend, pas un bug de ce projet.
 *
 *  Ce qu'on peut automatiser, en revanche, c'est le CHOIX : lister tous
 *  les micros disponibles (comme list-audio-devices.js le fait déjà) puis
 *  choisir le plus probable automatiquement, sans obliger l'utilisateur à
 *  copier un nom depuis une commande. C'est ce que fait autoDetectDevice()
 *  ci-dessous, utilisé par startRecording() quand AUDIO_DEVICE est vide.
 * ============================================================================
 */

/**
 * Interroge FFmpeg pour lister les périphériques audio DirectShow.
 * @param {string} ffmpegPath
 * @param {number} timeoutMs
 * @returns {Promise<string[]>} Liste des noms de périphériques (peut être vide)
 */
function listDevices(ffmpegPath = CONFIG.ffmpegPath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let ff;
    try {
      ff = spawn(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    } catch (_) {
      resolve([]);
      return;
    }

    let output = '';
    let settled = false;
    const finish = (devices) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      resolve(devices);
    };

    ff.stderr.on('data', (d) => { output += d.toString(); });
    ff.on('close', () => finish(parseDshowAudioDevices(output)));
    ff.on('error', () => finish([]));

    const hardKill = setTimeout(() => {
      try { ff.kill('SIGKILL'); } catch (_) { /* déjà terminé */ }
      finish([]);
    }, timeoutMs);
  });
}

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
 * Détecte et choisit automatiquement un micro. Ne lève jamais d'exception :
 * en cas d'échec (FFmpeg absent, aucun périphérique, uniquement des
 * loopbacks), retourne { device: null, reason } pour que l'appelant puisse
 * afficher un message clair plutôt qu'un plantage silencieux.
 * @param {string} ffmpegPath
 * @returns {Promise<{ device: string|null, candidates: string[], rejected: string[], reason?: string }>}
 */
async function autoDetectDevice(ffmpegPath = CONFIG.ffmpegPath) {
  const devices = await listDevices(ffmpegPath);
  if (devices.length === 0) {
    return {
      device: null,
      candidates: [],
      rejected: [],
      reason: 'Aucun périphérique audio DirectShow détecté par FFmpeg (micro débranché, non autorisé dans Windows, ou pilote manquant).',
    };
  }

  const { chosen, candidates, rejected } = pickBestDevice(devices);
  if (!chosen) {
    return {
      device: null,
      candidates,
      rejected,
      reason: `Seuls des périphériques de boucle de retour ont été détectés (${rejected.join(', ')}) — aucun micro physique fiable à choisir automatiquement.`,
    };
  }
  return { device: chosen, candidates, rejected };
}

/**
 * Démarre la capture audio via FFmpeg
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

  // AUDIO_DEVICE non défini : on détecte et choisit un micro automatiquement
  // au lieu d'exiger une configuration manuelle (voir autoDetectDevice()).
  if (!config.audioDevice) {
    console.log('[audio-capture] AUDIO_DEVICE non défini — détection automatique du micro...');
    const auto = await autoDetectDevice(config.ffmpegPath);

    if (!auto.device) {
      throw new Error(
        `Détection automatique du micro impossible : ${auto.reason} ` +
        'Lancez "node list-audio-devices.js" pour un diagnostic détaillé, ' +
        'ou définissez AUDIO_DEVICE manuellement dans .env.'
      );
    }

    config.audioDevice = auto.device;
    console.log(`[audio-capture] Micro choisi automatiquement : "${auto.device}"`);
    const others = auto.candidates.filter((d) => d !== auto.device);
    if (others.length > 0) {
      console.log(`[audio-capture] Autres micros détectés (non retenus) : ${others.join(', ')}. ` +
        'Pour en forcer un autre, définissez AUDIO_DEVICE dans .env avec son nom exact.');
    }
    if (auto.rejected.length > 0) {
      console.log(`[audio-capture] Périphériques ignorés (boucle de retour/virtuel) : ${auto.rejected.join(', ')}`);
    }
  }

  return new Promise((resolve, reject) => {
    console.log('[audio-capture] Démarrage de la capture audio...');
    console.log('[audio-capture] Configuration:', {
      sampleRate: config.sampleRate,
      channels: config.channels,
      segmentDuration: config.segmentDuration + 'ms',
      overlapDuration: config.overlapDuration + 'ms',
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
  // Auto-détection micro — exposées pour list-audio-devices.js, l'assistant
  // de setup Electron (main.js), et les tests.
  listDevices,
  pickBestDevice,
  autoDetectDevice,
};
