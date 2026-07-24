/**
 * ============================================================================
 *  whisper-wrapper.js — Module structuré pour Whisper Speech-to-Text
 * ----------------------------------------------------------------------------
 *  Gère le processus whisper-server.exe et fournit une API propre pour:
 *    - Lancer/arrêter le serveur Whisper
 *    - Envoyer de l'audio pour transcription
 *    - Recevoir les transcriptions en temps réel
 *
 *  ARCHITECTURE:
 *    whisper-server.exe (HTTP) ← whisper-wrapper.js ← server.js → overlay.html
 *
 *  CONFIGURATION:
 *    - Port: 8080 (défaut whisper-server)
 *    - Modèle: ggml-tiny.bin (le plus rapide)
 *    - Langue: français (auto-détection possible)
 * ============================================================================
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Configuration
// Modèle par défaut : base (meilleure précision que tiny, toujours utilisable
// en CPU). Pour revenir à tiny (plus rapide, moins précis) sans modifier ce
// fichier : $env:WHISPER_MODEL = 'ggml-tiny.bin' avant `npm start`.
const MODEL_FILE = process.env.WHISPER_MODEL || 'ggml-base.bin';
const CONFIG = {
  whisperServerPath: path.join(__dirname, 'whisper', 'whisper-server.exe'),
  modelPath: path.join(__dirname, 'whisper', 'models', MODEL_FILE),
  host: '127.0.0.1',
  port: 8080,
  language: 'fr', // 'auto' pour détection automatique
  threads: 4, // Ajuster selon CPU (testez 2, 4, 6, 8)
  vadEnabled: false, // Désactivé - pas de modèle VAD disponible
  vadThreshold: 0.5, // Seuil détection voix
  vadMinSpeechDuration: 250, // ms minimum parole
  vadMinSilenceDuration: 1000, // ms minimum silence pour split
};

// État du module
const STATE = {
  process: null,
  isRunning: false,
  // CORRECTIF AUDIT : distingue un arrêt demandé volontairement (stopServer())
  // d'un arrêt inattendu (crash de whisper-server.exe pendant le service),
  // pour pouvoir alerter uniquement dans le second cas.
  stopRequested: false,
  callbacks: {
    onTranscript: null,
    onError: null,
    onReady: null,
  },
};

/**
 * Lance le serveur whisper-server.exe
 * @param {Object} options - Options de configuration (surcharge CONFIG)
 * @returns {Promise<void>}
 */
function startServer(options = {}) {
  return new Promise((resolve, reject) => {
    if (STATE.isRunning) {
      console.warn('[whisper-wrapper] Serveur déjà en cours d\'exécution');
      resolve();
      return;
    }

    const config = { ...CONFIG, ...options };

    // Vérifier que l'exécutable existe
    if (!fs.existsSync(config.whisperServerPath)) {
      reject(new Error(`whisper-server.exe non trouvé: ${config.whisperServerPath}`));
      return;
    }

    // Vérifier que le modèle existe
    if (!fs.existsSync(config.modelPath)) {
      reject(new Error(`Modèle Whisper non trouvé: ${config.modelPath}`));
      return;
    }

    console.log('[whisper-wrapper] Démarrage de whisper-server.exe...');

    // Référence au timeout de démarrage, annulé dès que le serveur est prêt
    // (voir plus bas) pour pouvoir aussi le tuer proprement s'il expire.
    let startupTimeout = null;

    // Construire les arguments optimisés pour la vitesse
    const args = [
      '-m', config.modelPath,
      '-l', config.language,
      '-t', config.threads.toString(),
      '--host', config.host,
      '--port', config.port.toString(),
      '-ng',                // Force CPU uniquement (pas de GPU)
      '--no-timestamps',    // Désactive les timestamps — gain de vitesse énorme
      '-bs', '1',           // Beam size 1 = décodage glouton (plus rapide)
      '-bo', '1',           // best-of 1
      '-ac', '512',         // Fenêtre audio réduite (mémoire réduite, plus rapide)
      '-fa',                // Active Flash Attention (plus rapide sur CPU moderne)
    ];

    // Activer VAD si configuré ET si un modèle VAD est présent
    if (config.vadEnabled && config.vadModelPath) {
      args.push('--vad');
      args.push('-vm', config.vadModelPath);
      args.push('-vt', config.vadThreshold.toString());
      args.push('-vspd', config.vadMinSpeechDuration.toString());
      args.push('-vsd', config.vadMinSilenceDuration.toString());
    }

    // Lancer le processus
    STATE.process = spawn(config.whisperServerPath, args, {
      cwd: path.join(__dirname, 'whisper'),
    });

    STATE.process.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[whisper-server]', output.trim());

      // Détecter quand le serveur est prêt
      if (output.includes('server started') || output.includes('listening')) {
        if (!STATE.isRunning) {
          STATE.isRunning = true;
          clearTimeout(startupTimeout);
          console.log(`[whisper-wrapper] Serveur prêt sur http://${config.host}:${config.port}`);
          if (STATE.callbacks.onReady) STATE.callbacks.onReady();
          resolve();
        }
      }
    });

    STATE.process.stderr.on('data', (data) => {
      const error = data.toString();
      // Whisper-server écrit sur stderr même pour des logs normaux
      // On ne traite comme erreur que si c'est vraiment une erreur
      if (error.toLowerCase().includes('error') && !error.includes('whisper_init')) {
        console.error('[whisper-server ERROR]', error.trim());
        if (STATE.callbacks.onError) STATE.callbacks.onError(error);
      } else {
        console.log('[whisper-server]', error.trim());
      }

      // Détecter quand le serveur est prêt (certains messages vont sur stderr)
      if (error.includes('server started') || error.includes('listening') || 
          error.includes('compute buffer (decode)')) {
        if (!STATE.isRunning) {
          STATE.isRunning = true;
          clearTimeout(startupTimeout);
          console.log(`[whisper-wrapper] Serveur prêt sur http://${config.host}:${config.port}`);
          if (STATE.callbacks.onReady) STATE.callbacks.onReady();
          resolve();
        }
      }
    });

    STATE.process.on('close', (code) => {
      console.log(`[whisper-wrapper] Processus terminé avec code ${code}`);
      const wasRunning = STATE.isRunning;
      STATE.isRunning = false;
      STATE.process = null;

      // CORRECTIF AUDIT : si le processus s'arrête alors qu'il tournait et
      // qu'on n'a pas nous-même demandé l'arrêt (stopServer()), c'est un
      // crash en cours de service — avant ce correctif, ce cas passait
      // inaperçu (juste ce console.log, invisible dans l'app packagée).
      // On prévient maintenant server.js via onError pour qu'il puisse
      // alerter l'opérateur, au lieu de perdre le fallback local en silence.
      if (wasRunning && !STATE.stopRequested) {
        const crashErr = new Error(`whisper-server.exe s'est arrêté de façon inattendue (code ${code})`);
        console.error('[whisper-wrapper]', crashErr.message);
        if (STATE.callbacks.onError) STATE.callbacks.onError(crashErr);
      }
      STATE.stopRequested = false;
    });

    STATE.process.on('error', (err) => {
      console.error('[whisper-wrapper] Erreur processus:', err.message);
      clearTimeout(startupTimeout);
      reject(err);
    });

    // Timeout de démarrage (30 secondes)
    // CORRECTIF AUDIT : avant ce changement, ce timeout rejetait la promesse
    // sans jamais tuer whisper-server.exe déjà lancé (STATE.process restait
    // actif et non réinitialisé). Le processus continuait de tourner en
    // arrière-plan, potentiellement en gardant le port 8080 occupé pour
    // toute tentative de redémarrage suivante.
    startupTimeout = setTimeout(() => {
      if (!STATE.isRunning) {
        console.error('[whisper-wrapper] Timeout de démarrage (30s) — arrêt du processus orphelin.');
        if (STATE.process) {
          STATE.process.kill('SIGKILL');
          STATE.process = null;
        }
        reject(new Error('Timeout: whisper-server.exe n\'a pas démarré dans les 30 secondes'));
      }
    }, 30000);
  });
}

/**
 * Arrête le serveur whisper-server.exe
 * @returns {Promise<void>}
 */
function stopServer() {
  return new Promise((resolve) => {
    if (!STATE.process) {
      console.warn('[whisper-wrapper] Aucun processus à arrêter');
      resolve();
      return;
    }

    console.log('[whisper-wrapper] Arrêt du serveur Whisper...');
    STATE.stopRequested = true;

    STATE.process.on('close', () => {
      STATE.isRunning = false;
      STATE.process = null;
      console.log('[whisper-wrapper] Serveur arrêté');
      resolve();
    });

    // Tuer le processus proprement
    STATE.process.kill('SIGTERM');

    // Force kill après 5 secondes
    setTimeout(() => {
      if (STATE.process) {
        STATE.process.kill('SIGKILL');
      }
    }, 5000);
  });
}

/**
 * Envoie un fichier audio pour transcription
 * @param {string} audioFilePath - Chemin vers le fichier audio (WAV, MP3, FLAC, OGG)
 * @returns {Promise<Object>} Résultat de transcription
 */
async function transcribeFile(audioFilePath) {
  if (!STATE.isRunning) {
    throw new Error('Serveur Whisper non démarré');
  }

  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Fichier audio non trouvé: ${audioFilePath}`);
  }

  const formData = require('form-data');
  const form = new formData();
  // CORRECTION : le champ doit être 'file' et non 'audio'
  form.append('file', fs.createReadStream(audioFilePath));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: '/inference',
      method: 'POST',
      headers: form.getHeaders(),
    });

    form.pipe(req);
    // Surtout ne pas appeler req.end() après form.pipe(), cela cause "write after end"

    req.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (STATE.callbacks.onTranscript) {
            STATE.callbacks.onTranscript(result);
          }
          resolve(result);
        } catch (e) {
          reject(new Error('Réponse JSON invalide du serveur Whisper'));
        }
      });
    });

    req.on('error', reject);
  });
}

/**
 * Envoie des données audio brutes (buffer) pour transcription
 * @param {Buffer} audioBuffer - Données audio (WAV format recommandé)
 * @returns {Promise<Object>} Résultat de transcription
 */
async function transcribeBuffer(audioBuffer) {
  if (!STATE.isRunning) {
    throw new Error('Serveur Whisper non démarré');
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: '/inference',
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': audioBuffer.length,
      },
    });

    req.write(audioBuffer);
    req.end();

    req.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (STATE.callbacks.onTranscript) {
            STATE.callbacks.onTranscript(result);
          }
          resolve(result);
        } catch (e) {
          reject(new Error('Réponse JSON invalide du serveur Whisper'));
        }
      });
    });

    req.on('error', reject);
  });
}

/**
 * Enregistre les callbacks d'événements
 * @param {Object} callbacks - { onTranscript, onError, onReady }
 */
function on(callbacks) {
  STATE.callbacks = { ...STATE.callbacks, ...callbacks };
}

/**
 * Vérifie si le serveur est en cours d'exécution
 * @returns {boolean}
 */
function isRunning() {
  return STATE.isRunning;
}

/**
 * Retourne la configuration actuelle
 * @returns {Object}
 */
function getConfig() {
  return { ...CONFIG };
}

module.exports = {
  startServer,
  stopServer,
  transcribeFile,
  transcribeBuffer,
  on,
  isRunning,
  getConfig,
};
