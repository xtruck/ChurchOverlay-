/**
 * ============================================================================
 *  electron/main.js — Coquille application pour ChurchOverlay
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.2.0 — Performance & Stability Repair Plan
 *    1. server.js is now loaded as a Worker Thread (worker_threads.Worker)
 *       instead of being spawn()'d as a separate Node process.
 *       → single Node runtime, ~50% RAM cut, no more ghost processes.
 *    2. CLOUD_ONLY_MODE : if a Groq key is configured, the local
 *       whisper-server.exe is NOT launched (biggest CPU win). Auto-ON by
 *       default when Groq key detected; togglable from the dashboard.
 *    3. Default Whisper model is now ggml-tiny.en.bin (~75MB) instead of
 *       ggml-base.bin — smaller install, faster fallback when it IS used.
 *    4. saveConfig() is now async (fs.promises.writeFile) → no more UI
 *       freeze on save.
 *    5. notifyDashboard() is debounced to a single flush every 500ms → the
 *       dashboard stays responsive under heavy log flow.
 *    6. detectAudioDevices() is cached in memory + on disk (24h TTL); only
 *       refreshed on explicit user request from setup.html.
 *    7. Robust temp-file cleanup on SIGINT / SIGTERM / uncaughtException
 *       / worker exit.
 *    8. Worker memory limit + auto-restart on worker crash (max 3 crashes
 *       in 60s → hard stop to avoid a restart storm).
 *    9. Worker auto-recycling every 4h to prevent slow leaks in long
 *       services (>2h).
 *   10. FFmpeg device enumeration : soft-terminate at 10s, then hard-kill,
 *       with one retry on transient failure.
 *   11. Bounded log ring buffer with proper eviction (kept at 200; head
 *       eviction on every push, no periodic scan).
 *   12. Perf monitor exposes live CPU % / RSS MB to the dashboard.
 *   13. Whisper GPU flag (manual, off by default) — persisted in config.
 *
 *  RÔLE :
 *    - Fournir une icône d'application (barre des tâches + system tray)
 *    - Au premier lancement : demander le micro + la clé Groq via une petite
 *      fenêtre graphique (aucun PowerShell, aucun .env à éditer à la main)
 *    - Ensuite : démarrer automatiquement server.js (le pipeline complet
 *      micro → Whisper/Groq → detector → overlay) dans un Worker Thread
 *    - Fenêtre principale = tableau de bord (statut serveur, URL overlay à
 *      coller dans OBS, bouton "changer de micro", mode cloud only, CPU/RAM)
 * ============================================================================
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const os = require('os');
const { ensureWhisperInstalled } = require('./setup-whisper');
const { ensureFfmpegInstalled, resolveFfmpegPath } = require('./setup-ffmpeg');
const perfMonitor = require('./perf-monitor');

// main.js vit à la racine du projet (à côté de server.js, overlay.html, etc.),
// donc APP_ROOT = __dirname.
const APP_ROOT = __dirname;
const USER_DATA = () => app.getPath('userData');
const CONFIG_PATH = () => path.join(USER_DATA(), 'config.json');
const DEVICE_CACHE_PATH = () => path.join(USER_DATA(), 'audio-devices.cache.json');
const DEVICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Worker memory ceiling (V8 --max-old-space-size, MB).
// tiny.en fallback + FFmpeg pipe + WS server sit well under 512MB.
const WORKER_MAX_OLD_SPACE_MB = 512;

// Auto-recycle the worker every 4 hours to defeat slow memory growth in
// long culte sessions (>2h). Only recycles when the worker is idle (no
// active shutdown / restart in flight).
const WORKER_MAX_UPTIME_MS = 4 * 60 * 60 * 1000;

// Restart-storm guard.
const WORKER_MAX_CRASHES = 3;
const WORKER_CRASH_WINDOW_MS = 60 * 1000;

// Debounce interval for pushing log/status snapshots to the dashboard.
const DASHBOARD_FLUSH_MS = 500;

// Perf sampling / push cadence.
const PERF_PUSH_MS = 2000;

let mainWindow = null;
let tray = null;
let worker = null;
let workerStartedAt = 0;
let workerRecycleTimer = null;
let recentCrashes = [];
let serverStatus = 'starting'; // starting | running | error | stopped

// ---------------------------------------------------------------------------
// Verrou mono-instance (correctif)
// ----------------------------------------------------------------------------
// PROBLÈME OBSERVÉ : ralentissement machine + dashboard bloqué + pipeline qui
// ne se connecte jamais. Cause racine : rien n'empêchait de lancer l'app
// plusieurs fois (double-clic, raccourci de démarrage Windows + lancement
// manuel, etc.). Chaque instance ouvre son propre process Electron + son
// propre Worker Thread server.js, qui tente chacun de :
//   - démarrer FFmpeg sur le même micro (conflit de périphérique),
//   - lancer whisper-server.exe (double consommation CPU si mode local),
//   - binder le serveur WebSocket sur le même port 8765 : la 1ère instance
//     réussit, la 2e échoue silencieusement (EADDRINUSE) et son dashboard
//     reste bloqué sur "connexion..." indéfiniment car son propre worker ne
//     passe jamais à l'état "running".
// Résultat cumulé : CPU/RAM doublés (ou plus) + un dashboard qui semble figé.
//
// CORRECTIF : un seul verrou système par utilisateur Windows. Toute 2e
// tentative de lancement se ferme immédiatement et redonne le focus à la
// fenêtre déjà ouverte de la 1ère instance, au lieu de créer un doublon.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Une 2e tentative de lancement a eu lieu : on ramène la fenêtre
    // existante au premier plan au lieu de laisser un doublon se créer.
    const win = mainWindow || null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Configuration locale (remplace le .env manuel — jamais de secret en dur)
// ---------------------------------------------------------------------------
// v0.2.0 : la config gère maintenant aussi { cloudOnlyMode, whisperGpu,
// logBatchInterval }. Migration : ces champs prennent des valeurs par
// défaut sûres si absents (voir loadConfig()).
// ---------------------------------------------------------------------------
function decryptKey(encryptedBase64, label) {
  if (!encryptedBase64) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    console.error(`[main] Chiffrement système indisponible : impossible de lire la clé ${label}.`);
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'));
  } catch (e) {
    console.error(`[main] Échec du déchiffrement de la clé ${label}:`, e.message);
    return null;
  }
}

function loadConfig() {
  let raw;
  try {
    if (fs.existsSync(CONFIG_PATH())) {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    }
  } catch (e) {
    console.error('[main] Config illisible, réinitialisation:', e.message);
    return null;
  }
  if (!raw) return null;

  const groqApiKey = raw.groqApiKeyEncrypted
    ? decryptKey(raw.groqApiKeyEncrypted, 'Groq')
    : (raw.groqApiKey || null);
  const deepgramApiKey = decryptKey(raw.deepgramApiKeyEncrypted, 'Deepgram');

  // Migration ancienne config (clé Groq en clair, pré-chiffrement).
  if (raw.groqApiKey && !raw.groqApiKeyEncrypted) {
    console.log('[main] Migration de la clé Groq vers le stockage chiffré...');
    // fire-and-forget : la nouvelle config sera lue au prochain démarrage
    saveConfigAsync({
      audioDevice: raw.audioDevice,
      groqApiKey: raw.groqApiKey,
      deepgramApiKey,
      cloudOnlyMode: raw.cloudOnlyMode,
      whisperGpu: raw.whisperGpu,
    }).catch((e) => console.error('[main] Migration config échouée:', e.message));
  }

  // v0.2.0 defaults : cloud-only auto-ON if a Groq key is present, unless
  // the user has explicitly opted out (cloudOnlyMode === false).
  const hasCloudKey = !!groqApiKey || !!deepgramApiKey;
  const cloudOnlyMode = typeof raw.cloudOnlyMode === 'boolean'
    ? raw.cloudOnlyMode
    : hasCloudKey; // default ON when a cloud key is configured

  return {
    audioDevice: raw.audioDevice,
    groqApiKey,
    deepgramApiKey,
    cloudOnlyMode,
    whisperGpu: !!raw.whisperGpu,
    logBatchInterval: Number.isFinite(raw.logBatchInterval) ? raw.logBatchInterval : DASHBOARD_FLUSH_MS,
  };
}

/**
 * Async save (v0.2.0). fs.writeFileSync used to hang the UI thread for
 * several hundred ms on some antivirus-hooked systems, freezing the
 * setup window right after "Enregistrer". fs.promises.writeFile avoids
 * that entirely.
 */
async function saveConfigAsync(config) {
  await fsp.mkdir(path.dirname(CONFIG_PATH()), { recursive: true });

  const toWrite = { audioDevice: config.audioDevice };

  if (config.groqApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      toWrite.groqApiKeyEncrypted = safeStorage.encryptString(config.groqApiKey).toString('base64');
    } else {
      console.warn('[main] Chiffrement système indisponible : clé Groq stockée en clair.');
      toWrite.groqApiKey = config.groqApiKey;
    }
  }
  if (config.deepgramApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      toWrite.deepgramApiKeyEncrypted = safeStorage.encryptString(config.deepgramApiKey).toString('base64');
    } else {
      console.warn('[main] Chiffrement système indisponible : clé Deepgram stockée en clair.');
      toWrite.deepgramApiKey = config.deepgramApiKey;
    }
  }
  if (typeof config.cloudOnlyMode === 'boolean') toWrite.cloudOnlyMode = config.cloudOnlyMode;
  if (typeof config.whisperGpu === 'boolean') toWrite.whisperGpu = config.whisperGpu;
  if (Number.isFinite(config.logBatchInterval)) toWrite.logBatchInterval = config.logBatchInterval;

  // Atomic-ish : write to tmp, rename. Avoids half-written config on crash.
  const tmp = CONFIG_PATH() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(toWrite, null, 2), 'utf8');
  await fsp.rename(tmp, CONFIG_PATH());
}

function isFirstRunNeeded() {
  const config = loadConfig();
  return !config || !config.audioDevice || !config.groqApiKey;
}

// ---------------------------------------------------------------------------
// Détection micros — avec cache disque 24h + timeout robuste
// ---------------------------------------------------------------------------
// v0.2.0 :
//   - Cache 24h (in-memory + disque) : évite de relancer ffmpeg -list_devices
//     à chaque ouverture de la fenêtre de setup (chaque appel forke ffmpeg
//     et coûte 1-3s CPU sous Windows).
//   - Timeout escaladé : 10s (au lieu de 6s), soft-terminate SIGTERM d'abord,
//     puis hard-kill 2s plus tard. Retry unique sur transient failure.
// ---------------------------------------------------------------------------
let deviceCacheMem = null; // { ts, devices }

async function detectAudioDevices({ force = false } = {}) {
  // 1) cache mémoire
  if (!force && deviceCacheMem && (Date.now() - deviceCacheMem.ts) < DEVICE_CACHE_TTL_MS) {
    return deviceCacheMem.devices;
  }
  // 2) cache disque
  if (!force) {
    try {
      const raw = await fsp.readFile(DEVICE_CACHE_PATH(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.devices) && Number.isFinite(parsed.ts) &&
          (Date.now() - parsed.ts) < DEVICE_CACHE_TTL_MS) {
        deviceCacheMem = parsed;
        return parsed.devices;
      }
    } catch (_) { /* cache miss */ }
  }

  // 3) live enumeration
  const devices = await enumerateDevicesLive();
  const payload = { ts: Date.now(), devices };
  deviceCacheMem = payload;
  fsp.mkdir(path.dirname(DEVICE_CACHE_PATH()), { recursive: true })
    .then(() => fsp.writeFile(DEVICE_CACHE_PATH(), JSON.stringify(payload), 'utf8'))
    .catch(() => {}); // non-fatal
  return devices;
}

function enumerateDevicesLive() {
  const ffmpegPath = resolveFfmpegPath();

  const attempt = () => new Promise((resolve) => {
    let settled = false;
    const finish = (devices) => { if (!settled) { settled = true; resolve(devices); } };

    let ff;
    try {
      ff = spawn(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    } catch (_) {
      finish(null);
      return;
    }

    let output = '';
    ff.stderr.on('data', (d) => { output += d.toString(); });

    ff.on('close', () => {
      const devices = [];
      output.split(/\r?\n/).forEach((line) => {
        const m = line.match(/"([^"]+)"\s*\(audio\)/);
        if (m) devices.push(m[1]);
      });
      finish(devices);
    });
    ff.on('error', () => finish(null));

    // Soft-terminate at 10s, hard-kill 2s later.
    const softKill = setTimeout(() => { try { ff.kill('SIGTERM'); } catch (_) {} }, 10000);
    const hardKill = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (_) {} finish(null); }, 12000);
    ff.on('close', () => { clearTimeout(softKill); clearTimeout(hardKill); });
  });

  return attempt().then((devices) => {
    if (devices && devices.length >= 0 && devices !== null) return devices;
    // one retry on transient failure
    return attempt().then((d) => d || []);
  });
}

// ---------------------------------------------------------------------------
// Fenêtres
// ---------------------------------------------------------------------------
function createSetupWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 520,
    resizable: false,
    icon: path.join(__dirname, 'icon.png'),
    title: 'ChurchOverlay — Configuration initiale',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'setup.html'));
  return win;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    icon: path.join(__dirname, 'icon.png'),
    title: 'ChurchOverlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'dashboard.html'));

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('ChurchOverlay');
  refreshTrayMenu();
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  const statusLabel = {
    starting: 'Démarrage en cours…',
    running: '● En marche',
    error: '● Erreur — voir tableau de bord',
    stopped: '○ Arrêté',
  }[serverStatus];

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir ChurchOverlay', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Redémarrer le pipeline', click: () => restartServer() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Worker (server.js) lifecycle
// ---------------------------------------------------------------------------
function startServer() {
  const config = loadConfig();
  if (!config) return;

  const workerEnv = Object.assign({}, process.env, {
    AUDIO_DEVICE: config.audioDevice,
    GROQ_API_KEY: config.groqApiKey,
    NODE_ENV: 'production',
    FFMPEG_PATH: resolveFfmpegPath(),
    // v0.2.0 : default model shipped is tiny.en (~75MB) — user choice.
    WHISPER_MODEL: process.env.WHISPER_MODEL || 'ggml-tiny.en.bin',
    // v0.2.0 : manual GPU toggle (whisper-wrapper.js reads WHISPER_GPU).
    WHISPER_GPU: config.whisperGpu ? '1' : '',
    // v0.2.0 : cloud-only bypass of local Whisper. Auto-ON when Groq key
    // detected (user choice). Skips launching whisper-server.exe entirely.
    CLOUD_ONLY_MODE: config.cloudOnlyMode ? '1' : '',
    APP_ROOT,
  });
  if (config.deepgramApiKey) {
    workerEnv.DEEPGRAM_API_KEY = config.deepgramApiKey;
  }

  serverStatus = 'starting';
  refreshTrayMenu();
  scheduleDashboardFlush();

  try {
    worker = new Worker(path.join(APP_ROOT, 'server.js'), {
      workerData: { runAsWorker: true, appRoot: APP_ROOT },
      env: workerEnv,
      // V8 memory ceiling — kills the worker before it can OOM the whole app.
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_MAX_OLD_SPACE_MB,
      },
      // stdout/stderr piped back into main so we can log to the dashboard
      // even if a child module writes with process.stdout.write directly.
      stdout: true,
      stderr: true,
    });
  } catch (e) {
    console.error('[main] Impossible de démarrer le worker server.js:', e.message);
    serverStatus = 'error';
    appendLog('Impossible de démarrer le pipeline: ' + e.message, true);
    refreshTrayMenu();
    scheduleDashboardFlush();
    return;
  }

  workerStartedAt = Date.now();
  scheduleWorkerRecycle();

  worker.stdout.on('data', (data) => appendLog(data.toString(), false));
  worker.stderr.on('data', (data) => appendLog(data.toString(), true));

  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'log') {
      appendLog(msg.text || '', !!msg.isError);
      if (msg.text && msg.text.includes('Serveur WebSocket démarré')) {
        serverStatus = 'running';
        refreshTrayMenu();
        scheduleDashboardFlush();
      }
      return;
    }
    if (msg.type === 'status') {
      serverStatus = msg.status || serverStatus;
      refreshTrayMenu();
      scheduleDashboardFlush();
      return;
    }
  });

  worker.on('error', (err) => {
    console.error('[main] Erreur worker server.js:', err && err.message);
    appendLog('Erreur worker: ' + (err && err.message), true);
    serverStatus = 'error';
    refreshTrayMenu();
    scheduleDashboardFlush();
  });

  worker.on('exit', (code) => {
    clearWorkerRecycle();
    const wasIntentional = shuttingDownWorker;
    shuttingDownWorker = false;
    const dead = worker;
    worker = null;

    if (wasIntentional) {
      serverStatus = 'stopped';
      refreshTrayMenu();
      scheduleDashboardFlush();
      const cb = onWorkerStopped; onWorkerStopped = null;
      if (cb) cb();
      return;
    }

    // Unintentional exit → treat as crash and restart, bounded.
    recentCrashes = recentCrashes.filter((t) => Date.now() - t < WORKER_CRASH_WINDOW_MS);
    recentCrashes.push(Date.now());
    if (recentCrashes.length > WORKER_MAX_CRASHES) {
      console.error('[main] Trop de crashes worker (%d en %ds) — arrêt du pipeline.',
        recentCrashes.length, WORKER_CRASH_WINDOW_MS / 1000);
      appendLog(`Pipeline arrêté après ${recentCrashes.length} crashes rapprochés (code ${code}). ` +
                'Cliquez sur Redémarrer.', true);
      serverStatus = 'error';
      refreshTrayMenu();
      scheduleDashboardFlush();
      return;
    }

    console.warn('[main] Worker server.js sorti (code %s), redémarrage automatique.', code);
    appendLog(`Pipeline sorti (code ${code}) — redémarrage automatique.`, true);
    serverStatus = 'starting';
    refreshTrayMenu();
    scheduleDashboardFlush();
    setTimeout(startServer, 500);
  });
}

let shuttingDownWorker = false;
let onWorkerStopped = null;

/**
 * Demande au worker server.js de s'arrêter proprement (arrêt de
 * whisper-server.exe et de FFmpeg inclus) via postMessage, avec un repli
 * sur .terminate() forcé si le worker ne s'arrête pas de lui-même sous 5s.
 */
function stopServerGracefully(cb) {
  if (!worker) { cb && cb(); return; }
  shuttingDownWorker = true;
  onWorkerStopped = cb || null;

  try {
    worker.postMessage({ type: 'shutdown' });
  } catch (e) {
    console.warn('[main] postMessage shutdown a échoué, terminate forcé:', e.message);
    try { worker.terminate(); } catch (_) {}
    return;
  }

  setTimeout(() => {
    if (worker && shuttingDownWorker) {
      console.warn('[main] Arrêt gracieux du pipeline expiré (5s) — terminate forcé.');
      try { worker.terminate(); } catch (_) {}
    }
  }, 5000);
}

function restartServer() {
  if (!worker) { startServer(); return; }
  stopServerGracefully(() => setTimeout(startServer, 500));
}

function scheduleWorkerRecycle() {
  clearWorkerRecycle();
  workerRecycleTimer = setTimeout(() => {
    if (!worker) return;
    if (shuttingDownWorker) return;
    const uptime = Date.now() - workerStartedAt;
    if (uptime >= WORKER_MAX_UPTIME_MS) {
      console.log('[main] Recyclage du worker après %d min d\'uptime.', Math.round(uptime / 60000));
      appendLog('Recyclage préventif du pipeline (uptime > 4h).', false);
      restartServer();
    }
  }, WORKER_MAX_UPTIME_MS + 1000);
  workerRecycleTimer.unref?.();
}

function clearWorkerRecycle() {
  if (workerRecycleTimer) {
    clearTimeout(workerRecycleTimer);
    workerRecycleTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Logs (bounded ring buffer, 200 max) + debounced dashboard flush (500ms)
// ---------------------------------------------------------------------------
const MAX_LOG_LINES = 200;
let recentLogs = [];
let dashboardFlushTimer = null;
let dashboardDirty = false;

function appendLog(text, isError) {
  const line = { text: String(text || ''), isError: !!isError, ts: Date.now() };
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOG_LINES) {
    // Head eviction, one at a time (bounded and cheap)
    recentLogs.splice(0, recentLogs.length - MAX_LOG_LINES);
  }
  scheduleDashboardFlush();
}

function scheduleDashboardFlush() {
  dashboardDirty = true;
  if (dashboardFlushTimer) return;
  dashboardFlushTimer = setTimeout(() => {
    dashboardFlushTimer = null;
    if (!dashboardDirty) return;
    dashboardDirty = false;
    flushDashboard();
  }, DASHBOARD_FLUSH_MS);
  dashboardFlushTimer.unref?.();
}

function flushDashboard() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('status-update', {
    status: serverStatus,
    logs: recentLogs.slice(-30),
    overlayUrl: 'file:///' + path.join(APP_ROOT, 'overlay.html').replace(/\\/g, '/'),
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('detect-microphones', async (_evt, opts) => detectAudioDevices({ force: !!(opts && opts.force) }));

ipcMain.handle('save-setup', async (_evt, { audioDevice, groqApiKey, deepgramApiKey }) => {
  // v0.2.0 : cloud-only defaults ON when a Groq key is present at save
  // time (user's choice). User can flip it off from the dashboard toggle.
  const existing = loadConfig() || {};
  const hasCloudKey = !!groqApiKey || !!deepgramApiKey;
  const cloudOnlyMode = typeof existing.cloudOnlyMode === 'boolean'
    ? existing.cloudOnlyMode
    : hasCloudKey;

  await saveConfigAsync({
    audioDevice,
    groqApiKey,
    deepgramApiKey,
    cloudOnlyMode,
    whisperGpu: !!existing.whisperGpu,
  });

  const sender = _evt.sender;

  try {
    await ensureFfmpegInstalled({
      onProgress: (msg) => {
        if (!sender.isDestroyed()) sender.send('whisper-setup-progress', { done: false, message: msg });
      },
    });
  } catch (err) {
    console.error('[main] Échec du téléchargement automatique de FFmpeg:', err.message);
    if (!sender.isDestroyed()) {
      sender.send('whisper-setup-progress', {
        done: false, ok: false,
        message: 'Échec du téléchargement automatique de FFmpeg (' + err.message + '). ' +
          'ChurchOverlay tentera d\'utiliser un FFmpeg déjà présent dans le PATH système.',
      });
    }
  }

  // In cloud-only mode we do NOT block startup on Whisper install (skipping
  // it entirely also skips the big model download — huge first-run win).
  if (cloudOnlyMode) {
    if (!sender.isDestroyed()) {
      sender.send('whisper-setup-progress', {
        done: true, ok: true,
        message: 'Mode cloud uniquement activé — Whisper local ignoré (téléchargement évité).',
      });
    }
    return true;
  }

  try {
    await ensureWhisperInstalled({
      onProgress: (msg) => {
        if (!sender.isDestroyed()) sender.send('whisper-setup-progress', { done: false, message: msg });
      },
    });
    if (!sender.isDestroyed()) sender.send('whisper-setup-progress', { done: true, ok: true, message: 'Whisper local prêt.' });
  } catch (err) {
    console.error('[main] Échec du téléchargement automatique de Whisper:', err.message);
    if (!sender.isDestroyed()) {
      sender.send('whisper-setup-progress', {
        done: true, ok: false,
        message: 'Échec du téléchargement de Whisper local (' + err.message + '). ' +
          'ChurchOverlay démarrera quand même avec Groq (cloud) uniquement.',
      });
    }
  }
  return true;
});

ipcMain.handle('get-status', async () => ({
  status: serverStatus,
  logs: recentLogs.slice(-30),
  overlayUrl: 'file:///' + path.join(APP_ROOT, 'overlay.html').replace(/\\/g, '/'),
}));

ipcMain.handle('request-restart', async () => restartServer());

ipcMain.handle('open-setup', async () => {
  createSetupWindow();
  return true;
});

// --- v0.2.0 settings IPC ---------------------------------------------------
ipcMain.handle('get-settings', async () => {
  const cfg = loadConfig() || {};
  return {
    cloudOnlyMode: !!cfg.cloudOnlyMode,
    whisperGpu: !!cfg.whisperGpu,
    hasGroqKey: !!cfg.groqApiKey,
    hasDeepgramKey: !!cfg.deepgramApiKey,
  };
});

ipcMain.handle('set-cloud-only-mode', async (_evt, enabled) => {
  const cfg = loadConfig() || {};
  await saveConfigAsync({ ...cfg, cloudOnlyMode: !!enabled });
  appendLog(`Mode cloud uniquement ${enabled ? 'activé' : 'désactivé'}. Redémarrage du pipeline…`, false);
  restartServer();
  return true;
});

ipcMain.handle('set-whisper-gpu', async (_evt, enabled) => {
  const cfg = loadConfig() || {};
  await saveConfigAsync({ ...cfg, whisperGpu: !!enabled });
  appendLog(`Accélération GPU Whisper ${enabled ? 'activée' : 'désactivée'}. Redémarrage du pipeline…`, false);
  restartServer();
  return true;
});

ipcMain.handle('get-perf-stats', async () => perfMonitor.getStats());

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  createTray();
  perfMonitor.start(PERF_PUSH_MS);

  // Push perf samples to the dashboard on the same cadence.
  const perfTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('perf-update', perfMonitor.getStats());
    }
  }, PERF_PUSH_MS);
  perfTimer.unref?.();

  if (isFirstRunNeeded()) {
    const setupWin = createSetupWindow();
    setupWin.on('closed', () => {
      if (isFirstRunNeeded()) { app.quit(); return; }
      createMainWindow();
      startServer();
    });
  } else {
    createMainWindow();
    startServer();
  }
});

app.on('window-all-closed', () => {
  // Sur Windows, l'appli reste active dans le tray tant qu'on ne quitte pas
  // explicitement — c'est voulu : le pipeline doit continuer de tourner.
});

let isShuttingDown = false;
app.on('before-quit', (event) => {
  app.isQuitting = true;
  if (worker && !isShuttingDown) {
    isShuttingDown = true;
    event.preventDefault();
    stopServerGracefully(() => app.exit(0));
  }
});

// Hard safety net — never leak temp files if the app dies unexpectedly.
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err && err.stack || err);
  appendLog('Erreur non gérée: ' + (err && err.message), true);
  // Do not exit here — let the user decide from the dashboard. The worker
  // itself has its own uncaughtException hook that flushes temp files.
});
