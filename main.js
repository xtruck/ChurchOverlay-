/**
 * ============================================================================
 * electron/main.js — Coquille application pour ChurchOverlay
 * ----------------------------------------------------------------------------
 * v1.0.1 — FIXED: auto-updater is optional (won't crash if not installed)
 * ============================================================================
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { Worker } = require('worker_threads');
const os = require('os');
const perfMonitor = require('./perf-monitor');
const themeLoader = require('./theme-loader');
const featuresStore = require('./features-store');

// NEW: Auto-updater (optional — won't crash if not installed)
let autoUpdaterModule = null;
try {
  autoUpdaterModule = require('./auto-updater');
  console.log('[main] Auto-updater loaded');
} catch (e) {
  console.warn('[main] Auto-updater not available:', e.message);
}

const APP_ROOT = __dirname;
const USER_DATA = () => app.getPath('userData');
const CONFIG_PATH = () => path.join(USER_DATA(), 'config.json');

const WORKER_MAX_OLD_SPACE_MB = 512;
const WORKER_MAX_UPTIME_MS = 4 * 60 * 60 * 1000;
const WORKER_MAX_CRASHES = 3;
const WORKER_CRASH_WINDOW_MS = 60 * 1000;
const DASHBOARD_FLUSH_MS = 500;
const PERF_PUSH_MS = 2000;

let mainWindow = null;
let tray = null;
let worker = null;
let workerStartedAt = 0;
let workerRecycleTimer = null;
let recentCrashes = [];
let serverStatus = 'starting';

// ---------------------------------------------------------------------------
// Single instance lock
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow || null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Configuration
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

  if (raw.groqApiKey && !raw.groqApiKeyEncrypted) {
    console.log('[main] Migration de la clé Groq vers le stockage chiffré...');
    saveConfigAsync({
      audioDevice: raw.audioDevice,
      groqApiKey: raw.groqApiKey,
      deepgramApiKey,
    }).catch((e) => console.error('[main] Migration config échouée:', e.message));
  }

  return {
    audioDevice: raw.audioDevice,
    groqApiKey,
    deepgramApiKey,
    logBatchInterval: Number.isFinite(raw.logBatchInterval) ? raw.logBatchInterval : DASHBOARD_FLUSH_MS,
  };
}

function readRawConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH())) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) || {};
    }
  } catch (e) {
    console.error('[main] Config illisible pendant la fusion, ignorée:', e.message);
  }
  return {};
}

async function writeRawConfig(raw) {
  await fsp.mkdir(path.dirname(CONFIG_PATH()), { recursive: true });
  const tmp = CONFIG_PATH() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(raw, null, 2), 'utf8');
  await fsp.rename(tmp, CONFIG_PATH());
}

async function saveConfigAsync(config) {
  // CORRECTIF (dashboard settings) : cette fonction écrivait auparavant un
  // fichier config.json entièrement neuf à chaque appel. Depuis que les
  // clés API peuvent être modifiées une par une depuis le tableau de bord
  // (au lieu du seul écran de setup initial qui envoyait toujours les deux
  // champs), un champ laissé vide par l'utilisateur (« je ne veux changer
  // que Deepgram ») effaçait silencieusement la clé Groq déjà enregistrée.
  // On repart donc de la config existante et on ne touche que les champs
  // explicitement fournis (chaîne non vide) ; le retrait volontaire d'une
  // clé passe par l'IPC dédié 'clear-api-key' (voir plus bas).
  const existingRaw = readRawConfig();
  const toWrite = {
    audioDevice: config.audioDevice !== undefined && config.audioDevice !== null
      ? config.audioDevice
      : existingRaw.audioDevice,
  };

  if (config.groqApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      toWrite.groqApiKeyEncrypted = safeStorage.encryptString(config.groqApiKey).toString('base64');
    } else {
      console.warn('[main] Chiffrement système indisponible : clé Groq stockée en clair.');
      toWrite.groqApiKey = config.groqApiKey;
    }
  } else {
    if (existingRaw.groqApiKeyEncrypted) toWrite.groqApiKeyEncrypted = existingRaw.groqApiKeyEncrypted;
    if (existingRaw.groqApiKey) toWrite.groqApiKey = existingRaw.groqApiKey;
  }

  if (config.deepgramApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      toWrite.deepgramApiKeyEncrypted = safeStorage.encryptString(config.deepgramApiKey).toString('base64');
    } else {
      console.warn('[main] Chiffrement système indisponible : clé Deepgram stockée en clair.');
      toWrite.deepgramApiKey = config.deepgramApiKey;
    }
  } else {
    if (existingRaw.deepgramApiKeyEncrypted) toWrite.deepgramApiKeyEncrypted = existingRaw.deepgramApiKeyEncrypted;
    if (existingRaw.deepgramApiKey) toWrite.deepgramApiKey = existingRaw.deepgramApiKey;
  }

  toWrite.logBatchInterval = Number.isFinite(config.logBatchInterval)
    ? config.logBatchInterval
    : existingRaw.logBatchInterval;
  if (!Number.isFinite(toWrite.logBatchInterval)) delete toWrite.logBatchInterval;

  await writeRawConfig(toWrite);
}

function isFirstRunNeeded() {
  const config = loadConfig();
  return !config || !config.audioDevice || !config.groqApiKey;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSetupWindow() {
  const win = new BrowserWindow({
    width: 680,
    height: 720,
    minWidth: 520,
    minHeight: 600,
    resizable: true,
    center: true,
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
    width: 900,
    height: 900,
    minWidth: 600,
    minHeight: 700,
    resizable: true,
    center: true,
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
// Worker lifecycle
// ---------------------------------------------------------------------------
function startServer() {
  const config = loadConfig();
  if (!config) return;

  const workerEnv = Object.assign({}, process.env, {
    NODE_ENV: 'production',
    APP_ROOT,
  });
  if (config.groqApiKey) {
    workerEnv.GROQ_API_KEY = config.groqApiKey;
  } else {
    delete workerEnv.GROQ_API_KEY;
  }
  if (config.deepgramApiKey) {
    workerEnv.DEEPGRAM_API_KEY = config.deepgramApiKey;
  }

  serverStatus = 'starting';
  refreshTrayMenu();
  scheduleDashboardFlush();

  try {
    worker = new Worker(path.join(APP_ROOT, 'server.js'), {
      workerData: { runAsWorker: true, appRoot: APP_ROOT, userDataDir: USER_DATA() },
      env: workerEnv,
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_MAX_OLD_SPACE_MB,
      },
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

    if (msg.type === 'status') {
      serverStatus = msg.status || serverStatus;
      refreshTrayMenu();
      scheduleDashboardFlush();
      if (msg.status === 'running' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pipeline-alert', { clear: true });
      }
      return;
    }

    if (msg.type === 'audio-pipeline-ready') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio-pipeline-ready');
      }
      return;
    }

    if (msg.type === 'alert') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pipeline-alert', {
          code: msg.code,
          severity: msg.severity || 'warning',
          message: msg.message || '',
          timestamp: msg.timestamp || Date.now(),
        });
      }
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
// Logs
// ---------------------------------------------------------------------------
const MAX_LOG_LINES = 200;
let recentLogs = [];
let dashboardFlushTimer = null;
let dashboardDirty = false;

function appendLog(text, isError) {
  const line = { text: String(text || ''), isError: !!isError, ts: Date.now() };
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOG_LINES) {
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
ipcMain.on('audio-pcm-chunk', (_evt, arrayBuffer) => {
  if (worker) {
    try {
      worker.postMessage({ type: 'audio-pcm-chunk', buffer: arrayBuffer }, [arrayBuffer]);
    } catch (err) {
      console.warn('[main] Chunk audio perdu (relais worker) :', err.message);
    }
  }
});

ipcMain.handle('save-setup', async (_evt, { audioDevice, groqApiKey, deepgramApiKey }) => {
  await saveConfigAsync({ audioDevice, groqApiKey, deepgramApiKey });
  // Démarre ou redémarre le pipeline avec la config à jour — que ce soit le
  // tout premier enregistrement (aucun worker actif) ou une mise à jour des
  // clés depuis le tableau de bord en cours de session (ex: rotation d'une
  // clé). Auparavant seul l'écran de setup initial déclenchait startServer().
  if (worker) {
    restartServer();
  } else if (!isFirstRunNeeded()) {
    startServer();
  }
  return true;
});

// Retrait explicite d'une clé API (bouton « Retirer la clé » du tableau de
// bord) — distinct d'un champ simplement laissé vide lors d'un
// enregistrement, qui doit préserver la clé existante (voir saveConfigAsync).
ipcMain.handle('clear-api-key', async (_evt, { provider }) => {
  const raw = readRawConfig();
  if (provider === 'groq') {
    delete raw.groqApiKey;
    delete raw.groqApiKeyEncrypted;
  } else if (provider === 'deepgram') {
    delete raw.deepgramApiKey;
    delete raw.deepgramApiKeyEncrypted;
  } else {
    throw new Error('Fournisseur de clé API inconnu : ' + provider);
  }
  await writeRawConfig(raw);
  if (provider === 'groq' && worker) {
    // Sans clé Groq le pipeline ne peut plus transcrire : on l'arrête plutôt
    // que de le laisser tourner en boucle d'erreurs.
    stopServerGracefully();
    serverStatus = 'stopped';
    refreshTrayMenu();
  }
  return true;
});

ipcMain.handle('get-status', async () => ({
  status: serverStatus,
  logs: recentLogs.slice(-30),
  overlayUrl: 'file:///' + path.join(APP_ROOT, 'overlay.html').replace(/\\/g, '/'),
}));

ipcMain.handle('request-restart', async () => restartServer());

ipcMain.handle('list-themes', async () => {
  try {
    return { ok: true, themes: themeLoader.listThemes() };
  } catch (e) {
    return { ok: false, error: e.message, themes: [] };
  }
});

ipcMain.handle('get-active-theme', async () => {
  try {
    return { ok: true, theme: themeLoader.getActiveTheme() };
  } catch (e) {
    return { ok: false, error: e.message, theme: null };
  }
});

ipcMain.handle('set-active-theme', async (_evt, { themeId }) => {
  try {
    const theme = themeLoader.setActiveTheme(themeId);
    if (worker) {
      try {
        worker.postMessage({ type: 'theme-changed', css: themeLoader.themeToCss(theme) });
      } catch (_) {}
    }
    return { ok: true, theme };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function getObsController() {
  return require('./obs-controller');
}

ipcMain.handle('obs-get-config', async () => {
  try {
    const cfg = (featuresStore.readFeatures().broadcast || {}).multiScene || {};
    return {
      ok: true,
      enabled: !!cfg.enabled,
      obsWebsocketUrl: cfg.obsWebsocketUrl || 'ws://localhost:4455',
      hasPassword: !!(cfg.passwordEncrypted || cfg.password),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('obs-set-config', async (_evt, { enabled, obsWebsocketUrl, password }) => {
  try {
    const features = featuresStore.readFeatures();
    features.broadcast = features.broadcast || {};
    const multiScene = features.broadcast.multiScene || {};
    features.broadcast.multiScene = multiScene;
    if (typeof enabled === 'boolean') multiScene.enabled = enabled;
    if (typeof obsWebsocketUrl === 'string' && obsWebsocketUrl.trim()) {
      multiScene.obsWebsocketUrl = obsWebsocketUrl.trim();
    }
    if (typeof password === 'string') {
      delete multiScene.password;
      delete multiScene.passwordEncrypted;
      if (password) {
        if (safeStorage.isEncryptionAvailable()) {
          multiScene.passwordEncrypted = safeStorage.encryptString(password).toString('base64');
        } else {
          console.warn('[main] Chiffrement système indisponible : mot de passe OBS stocké en clair.');
          multiScene.password = password;
        }
      }
    }
    featuresStore.writeFeatures(features);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('obs-connect', async () => {
  try {
    const obs = getObsController();
    const client = await obs.connect((open, reason, state) => {
      if (worker) {
        try {
          worker.postMessage({ type: 'obs-gate-changed', open, reason, state });
        } catch (_) {}
      }
    });
    return client
      ? { ok: true, connected: true }
      : { ok: false, connected: false, error: 'Connexion impossible — vérifiez qu\'OBS tourne.' };
  } catch (e) {
    return { ok: false, connected: false, error: e.message };
  }
});

ipcMain.handle('obs-list-scenes', async () => {
  try {
    const obs = getObsController();
    return { ok: true, scenes: await obs.listScenes() };
  } catch (e) {
    return { ok: false, error: e.message, scenes: [] };
  }
});

ipcMain.handle('obs-switch-scene', async (_evt, { sceneName }) => {
  try {
    const obs = getObsController();
    return await obs.switchScene(sceneName);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('obs-toggle-recording', async () => {
  try {
    const obs = getObsController();
    return await obs.toggleRecording();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('open-setup', async () => {
  createSetupWindow();
  return true;
});

ipcMain.handle('get-settings', async () => {
  const cfg = loadConfig() || {};
  return {
    hasGroqKey: !!cfg.groqApiKey,
    hasDeepgramKey: !!cfg.deepgramApiKey,
    audioDevice: cfg.audioDevice || null,
    needsSetup: isFirstRunNeeded(),
  };
});

ipcMain.handle('get-perf-stats', async () => perfMonitor.getStats());

// ---------------------------------------------------------------------------
// Auto-updater (optional — won't crash if not installed)
// ---------------------------------------------------------------------------
let autoUpdaterInitialized = false;
function initAutoUpdater() {
  if (autoUpdaterInitialized) return;
  if (!autoUpdaterModule || !autoUpdaterModule.initAutoUpdater) return;
  autoUpdaterInitialized = true;
  try {
    autoUpdaterModule.initAutoUpdater(mainWindow, {
      SILENT_INSTALL: false,
      SHOW_NOTIFICATION: true,
      ALLOW_PRERELEASE: false,
    });
  } catch (e) {
    console.warn('[main] Auto-updater init failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  themeLoader.setUserDataDir(USER_DATA());

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');

  createTray();
  perfMonitor.start(PERF_PUSH_MS);

  const perfTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('perf-update', perfMonitor.getStats());
    }
  }, PERF_PUSH_MS);
  perfTimer.unref?.();

  // CORRECTIF (config API sur le tableau de bord) : la fenêtre de setup
  // séparée (setup.html) n'est plus ouverte automatiquement au premier
  // lancement. Le tableau de bord se charge toujours en premier ; s'il
  // manque un micro ou une clé Groq, son panneau « Paramètres » s'ouvre
  // de lui-même (voir dashboard.html → initApiSettingsPanel) et
  // 'save-setup' démarre le pipeline dès l'enregistrement. La fonction
  // createSetupWindow()/l'IPC 'open-setup' restent disponibles pour un
  // usage manuel éventuel mais ne sont plus appelés au démarrage.
  createMainWindow();
  initAutoUpdater();
  if (!isFirstRunNeeded()) {
    startServer();
  } else {
    appendLog('Configuration requise : microphone et/ou clé API Groq manquants. Ouvrez Paramètres dans le tableau de bord.', false);
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray
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

process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err && err.stack || err);
  appendLog('Erreur non gérée: ' + (err && err.message), true);
});
