/**
 * ============================================================================
 *  whisper-wrapper.js — Module structuré pour Whisper Speech-to-Text
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.2.0 (minimal patch — required to make the GPU toggle work)
 *    1. Default model bumped to ggml-tiny.en.bin (~75MB, user choice) to
 *       match the installer default. Overridable with WHISPER_MODEL env.
 *    2. New WHISPER_GPU=1 env var (set by main.js when the dashboard
 *       toggle is on) : when truthy, we DON'T pass '-ng' (force CPU) so
 *       whisper-server.exe picks up an available GPU. Manual toggle only
 *       — no runtime auto-detection, per user's choice.
 *
 *  Everything else in this module is unchanged from the pre-v0.2.0 audit
 *  file : callbacks, HTTP inference, startup timeout with process reap,
 *  stopRequested flag to distinguish planned vs. crash exits, etc.
 * ============================================================================
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// v0.2.0 : tiny.en shipped by default (user choice: ~75MB installer, fast).
const MODEL_FILE = process.env.WHISPER_MODEL || 'ggml-tiny.en.bin';
// v0.2.0 : manual GPU toggle. If set (dashboard toggle), whisper-server.exe
// is allowed to use the GPU (we omit '-ng'). Default = CPU-only.
const USE_GPU = process.env.WHISPER_GPU === '1' ||
                String(process.env.WHISPER_GPU || '').toLowerCase() === 'true';

const CONFIG = {
  whisperServerPath: path.join(__dirname, 'whisper', 'whisper-server.exe'),
  modelPath: path.join(__dirname, 'whisper', 'models', MODEL_FILE),
  host: '127.0.0.1',
  port: 8080,
  language: 'fr',
  threads: 4,
  vadEnabled: false,
  vadThreshold: 0.5,
  vadMinSpeechDuration: 250,
  vadMinSilenceDuration: 1000,
  useGpu: USE_GPU,
};

const STATE = {
  process: null,
  isRunning: false,
  stopRequested: false,
  callbacks: { onTranscript: null, onError: null, onReady: null },
};

function startServer(options = {}) {
  return new Promise((resolve, reject) => {
    if (STATE.isRunning) {
      console.warn('[whisper-wrapper] Serveur déjà en cours d\'exécution');
      resolve();
      return;
    }

    const config = { ...CONFIG, ...options };

    if (!fs.existsSync(config.whisperServerPath)) {
      reject(new Error(`whisper-server.exe non trouvé: ${config.whisperServerPath}`));
      return;
    }
    if (!fs.existsSync(config.modelPath)) {
      reject(new Error(`Modèle Whisper non trouvé: ${config.modelPath}`));
      return;
    }

    console.log('[whisper-wrapper] Démarrage de whisper-server.exe' + (config.useGpu ? ' (GPU activé)' : ' (CPU uniquement)'));

    let startupTimeout = null;

    const args = [
      '-m', config.modelPath,
      '-l', config.language,
      '-t', config.threads.toString(),
      '--host', config.host,
      '--port', config.port.toString(),
      '--no-timestamps',
      '-bs', '1',
      '-bo', '1',
      '-ac', '512',
      '-fa',
    ];
    // v0.2.0 : force CPU only when GPU toggle is OFF. Was '-ng' unconditional.
    if (!config.useGpu) args.push('-ng');

    if (config.vadEnabled && config.vadModelPath) {
      args.push('--vad');
      args.push('-vm', config.vadModelPath);
      args.push('-vt', config.vadThreshold.toString());
      args.push('-vspd', config.vadMinSpeechDuration.toString());
      args.push('-vsd', config.vadMinSilenceDuration.toString());
    }

    STATE.process = spawn(config.whisperServerPath, args, {
      cwd: path.join(__dirname, 'whisper'),
    });

    STATE.process.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[whisper-server]', output.trim());
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
      if (error.toLowerCase().includes('error') && !error.includes('whisper_init')) {
        console.error('[whisper-server ERROR]', error.trim());
        if (STATE.callbacks.onError) STATE.callbacks.onError(error);
      } else {
        console.log('[whisper-server]', error.trim());
      }
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

    STATE.process.kill('SIGTERM');
    setTimeout(() => { if (STATE.process) STATE.process.kill('SIGKILL'); }, 5000);
  });
}

async function transcribeFile(audioFilePath) {
  if (!STATE.isRunning) throw new Error('Serveur Whisper non démarré');
  if (!fs.existsSync(audioFilePath)) throw new Error(`Fichier audio non trouvé: ${audioFilePath}`);

  const formData = require('form-data');
  const form = new formData();
  form.append('file', fs.createReadStream(audioFilePath));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: CONFIG.host, port: CONFIG.port, path: '/inference',
      method: 'POST', headers: form.getHeaders(),
    });
    form.pipe(req);
    req.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (STATE.callbacks.onTranscript) STATE.callbacks.onTranscript(result);
          resolve(result);
        } catch (e) { reject(new Error('Réponse JSON invalide du serveur Whisper')); }
      });
    });
    req.on('error', reject);
  });
}

async function transcribeBuffer(audioBuffer) {
  if (!STATE.isRunning) throw new Error('Serveur Whisper non démarré');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: CONFIG.host, port: CONFIG.port, path: '/inference',
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'Content-Length': audioBuffer.length },
    });
    req.write(audioBuffer);
    req.end();
    req.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (STATE.callbacks.onTranscript) STATE.callbacks.onTranscript(result);
          resolve(result);
        } catch (e) { reject(new Error('Réponse JSON invalide du serveur Whisper')); }
      });
    });
    req.on('error', reject);
  });
}

function on(callbacks) { STATE.callbacks = { ...STATE.callbacks, ...callbacks }; }
function isRunning() { return STATE.isRunning; }
function getConfig() { return { ...CONFIG }; }

module.exports = { startServer, stopServer, transcribeFile, transcribeBuffer, on, isRunning, getConfig };
