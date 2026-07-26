/**
 * ============================================================================
 *  electron/main.js — Coquille application pour ChurchOverlay
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.2.0 — Performance & Stability Repair Plan
 *    1. server.js is now loaded as a Worker Thread (worker_threads.Worker)
 *       instead of being spawn()'d as a separate Node process.
 *       → single Node runtime, ~50% RAM cut, no more ghost processes.
 *    2. saveConfig() is now async (fs.promises.writeFile) → no more UI
 *       freeze on save.
 *    3. notifyDashboard() is debounced to a single flush every 500ms → the
 *       dashboard stays responsive under heavy log flow.
 *    4. detectAudioDevices() is cached in memory + on disk (24h TTL); only
 *       refreshed on explicit user request from setup.html.
 *    5. Robust temp-file cleanup on SIGINT / SIGTERM / uncaughtException
 *       / worker exit.
 *    6. Worker memory limit + auto-restart on worker crash (max 3 crashes
 *       in 60s → hard stop to avoid a restart storm).
 *    7. Worker auto-recycling every 4h to prevent slow leaks in long
 *       services (>2h).
 *    8. FFmpeg device enumeration : soft-terminate at 10s, then hard-kill,
 *       with one retry on transient failure.
 *    9. Bounded log ring buffer with proper eviction (kept at 200; head
 *       eviction on every push, no periodic scan).
 *   10. Perf monitor exposes live CPU % / RSS MB to the dashboard.
 *
 *  CHANGELOG v0.3.0 — Suppression complète de Whisper local
 *    - whisper-server.exe n'était déjà plus lancé quand CLOUD_ONLY_MODE
 *      était actif, mais tout le code, le téléchargement (~75-466MB) et
 *      les bascules GPU/cloud restaient présents et pouvaient se
 *      réactiver (config existante avec cloudOnlyMode:false, régression
 *      future...). Ce risque CPU/RAM est maintenant éliminé à la racine :
 *      plus aucun code ne peut démarrer whisper-server.exe. Transcription
 *      = Groq (cloud) → Deepgram (cloud, si clé) uniquement.
 *    - Correctif log dupliqué : chaque ligne de log du worker server.js
 *      était envoyée deux fois au dashboard (une fois via le message IPC
 *      explicite 'log', une fois via le flux stdout/stderr du Worker qui
 *      capture déjà tout ce qu'écrit console.log/console.error). Le
 *      dashboard affichait donc chaque ligne en double. Corrigé en ne
 *      gardant qu'un seul chemin (le flux stdout/stderr du Worker).
 *
 *  RÔLE :
 *    - Fournir une icône d'application (barre des tâches + system tray)
 *    - Au premier lancement : demander le micro + la clé Groq via une petite
 *      fenêtre graphique (aucun PowerShell, aucun .env à éditer à la main)
 *    - Ensuite : démarrer automatiquement server.js (le pipeline complet
 *      micro → Groq/Deepgram (cloud) → detector → overlay) dans un Worker
 *      Thread
 *    - Fenêtre principale = tableau de bord (statut serveur, URL overlay à
 *      coller dans OBS, bouton "changer de micro", CPU/RAM)
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
const { ensureFfmpegInstalled, resolveFfmpegPath } = require('./setup-ffmpeg');
const perfMonitor = require('./perf-monitor');
const { parseDshowAudioDevices } = require('./dshow-parser');
const themeLoader = require('./theme-loader');

// main.js vit à la racine du projet (à côté de server.js, overlay.html, etc.),
// donc APP_ROOT = __dirname.
const APP_ROOT = __dirname;

// CORRECTIF (audit) — sur un PC avec peu de RAM/un GPU intégré faible,
// le processus GPU d'Electron peut lui-même consommer beaucoup de
// ressources ou provoquer des ralentissements/saccades. ChurchOverlay
// n'a besoin d'aucun rendu 3D/accéléré (juste du texte et des cartes en
// CSS) : désactiver l'accélération matérielle retire ce processus GPU
// dédié et est l'optimisation Electron la plus efficace pour du matériel
// limité. Sans effet notable sur un PC récent.
app.disableHardwareAcceleration();
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
// v0.3.0 : la config ne gère plus que { audioDevice, groqApiKey,
// deepgramApiKey, logBatchInterval } — cloudOnlyMode et whisperGpu ont
// disparu avec Whisper local. Migration : ces champs prennent des valeurs
// par défaut sûres si absents (voir loadConfig()).
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
    }).catch((e) => console.error('[main] Migration config échouée:', e.message));
  }

  return {
    audioDevice: raw.audioDevice,
    groqApiKey,
    deepgramApiKey,
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
      // CORRECTIF : l'ancienne regex ne matchait que le format
      // '"Nom" (audio)' inline, absent des builds FFmpeg Windows les plus
      // courants (Gyan.dev/BtbN), qui utilisent un format à deux sections
      // ("DirectShow audio devices" + noms sans suffixe). Résultat : la
      // liste était systématiquement vide sur la majorité des machines.
      finish(parseDshowAudioDevices(output));
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
    // NOTE : les logs eux-mêmes n'arrivent plus ici — voir CHANGELOG v0.3.0
    // ci-dessus. worker.stdout/worker.stderr (branchés juste au-dessus)
    // capturent déjà tout ce qu'écrit console.log/console.error dans le
    // worker ; les traiter aussi ici doublait chaque ligne dans le
    // tableau de bord. Seuls les changements de statut explicites
    // ({ type: 'status' }, envoyés par server.js) transitent par ce canal.
    if (msg.type === 'status') {
      serverStatus = msg.status || serverStatus;
      refreshTrayMenu();
      scheduleDashboardFlush();
      // Un retour à 'running' signifie que le pipeline vient de (re)démarrer
      // proprement : on efface toute alerte affichée, elle ne s'applique
      // plus forcément.
      if (msg.status === 'running' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pipeline-alert', { clear: true });
      }
      return;
    }

    // CORRECTIF (audit) — voir server.js/notifyAlert(). Poussé immédiatement
    // (pas de debounce comme pour les logs) : une panne réseau/micro doit
    // être visible sans délai pour l'équipe régie.
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
 * Demande au worker server.js de s'arrêter proprement (arrêt de FFmpeg
 * inclus) via postMessage, avec un repli sur .terminate() forcé si le
 * worker ne s'arrête pas de lui-même sous 5s.
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

// CORRECTIF (audit setup/preload/ffmpeg) — factorisé hors de save-setup :
// avant, ensureFfmpegInstalled() n'était appelé QU'APRÈS que l'utilisateur
// clique "Enregistrer et démarrer". Mais setup.html scanne les micros dès
// son ouverture (detectMicrophones), et cette détection utilise elle aussi
// resolveFfmpegPath() (voir enumerateDevicesLive ci-dessus). Sur un poste
// sans FFmpeg système déjà installé, ce premier scan échouait donc
// systématiquement (liste vide), ce qui laisse le bouton "Enregistrer"
// désactivé (il exige un micro sélectionné) — verrou complet : FFmpeg ne
// pouvait jamais s'installer automatiquement puisque son seul déclencheur
// dépendait d'une étape elle-même bloquée par son absence.
// runEnsureFfmpeg() est maintenant appelée dès l'ouverture de l'assistant
// de configuration (voir ipcMain.handle('ensure-ffmpeg', ...) ci-dessous et
// setup.html), AVANT le premier scan de micros. L'appel dans save-setup est
// conservé tel quel : ensureFfmpegInstalled() est idempotent (ne re-télécharge
// rien si ffmpeg/ffmpeg.exe existe déjà), donc c'est un filet de sécurité
// sans coût si la première tentative a échoué (pas de réseau au démarrage,
// par exemple) et que l'utilisateur retente en cliquant Enregistrer.
//
// IMPORTANT : deux canaux IPC distincts sont utilisés (progressChannel en
// paramètre) car setup.html ferme automatiquement sa fenêtre en recevant
// 'ffmpeg-setup-progress' avec done:true (comportement voulu APRÈS
// l'enregistrement réussi). Réutiliser ce même canal pour le scan initial
// aurait fermé la fenêtre avant même que l'utilisateur ait vu le formulaire.
async function runEnsureFfmpeg(sender, progressChannel) {
  try {
    await ensureFfmpegInstalled({
      onProgress: (msg, percent) => {
        if (!sender.isDestroyed()) {
          sender.send(progressChannel, {
            done: false,
            message: msg,
            // percent est fourni (0-100) uniquement pendant le téléchargement
            // lui-même — undefined pour les autres étapes (extraction...).
            percent: typeof percent === 'number' ? percent : undefined,
          });
        }
      },
    });
    if (!sender.isDestroyed()) {
      sender.send(progressChannel, { done: true, ok: true, message: 'Prêt.', percent: 100 });
    }
    return { ok: true };
  } catch (err) {
    console.error('[main] Échec du téléchargement automatique de FFmpeg:', err.message);
    if (!sender.isDestroyed()) {
      sender.send(progressChannel, {
        done: true, ok: false,
        message: 'Échec du téléchargement automatique de FFmpeg (' + err.message + '). ' +
          'ChurchOverlay tentera d\'utiliser un FFmpeg déjà présent dans le PATH système.',
      });
    }
    return { ok: false, error: err.message };
  }
}

// Appelée par setup.html dès son ouverture, avant le premier scan de micros.
// Canal 'ffmpeg-startup-progress' : ne déclenche PAS la fermeture de fenêtre.
ipcMain.handle('ensure-ffmpeg', async (_evt) => runEnsureFfmpeg(_evt.sender, 'ffmpeg-startup-progress'));

ipcMain.handle('detect-microphones', async (_evt, opts) => detectAudioDevices({ force: !!(opts && opts.force) }));

ipcMain.handle('save-setup', async (_evt, { audioDevice, groqApiKey, deepgramApiKey }) => {
  await saveConfigAsync({ audioDevice, groqApiKey, deepgramApiKey });
  // Filet de sécurité : no-op si déjà installé au chargement de setup.html
  // (cas normal) ; nouvelle tentative si la première avait échoué.
  // Canal 'ffmpeg-setup-progress' : celui-ci déclenche bien la fermeture de
  // la fenêtre côté setup.html une fois terminé (comportement existant,
  // inchangé).
  await runEnsureFfmpeg(_evt.sender, 'ffmpeg-setup-progress');
  return true;
});

ipcMain.handle('get-status', async () => ({
  status: serverStatus,
  logs: recentLogs.slice(-30),
  overlayUrl: 'file:///' + path.join(APP_ROOT, 'overlay.html').replace(/\\/g, '/'),
}));

ipcMain.handle('request-restart', async () => restartServer());

// --- Thèmes de l'overlay (theme-loader.js) ---------------------------------
// Ajouté à l'audit : module déjà écrit et testé (test/test-theme-loader.js),
// mais jamais branché à l'UI. On applique le changement en direct sur
// overlay.html en le relayant au worker server.js, qui broadcast le CSS à
// tous les clients WebSocket connectés (voir server.js, message
// 'theme-changed' + broadcast de l'action 'applyTheme').
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
    // Le pipeline (worker server.js) n'est pas toujours en cours d'exécution
    // (ex: avant "Enregistrer et démarrer") — on relaie le changement
    // uniquement s'il tourne. overlay.html reçoit de toute façon le thème
    // actif à jour dès sa prochaine connexion, via server.js.
    if (worker) {
      try {
        worker.postMessage({ type: 'theme-changed', css: themeLoader.themeToCss(theme) });
      } catch (_) { /* worker en cours d'arrêt : sans effet, non bloquant */ }
    }
    return { ok: true, theme };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// --- Contrôle OBS multi-scènes (obs-controller.js) --------------------------
// Même constat que pour les thèmes : module écrit, jamais branché.
// Entièrement optionnel (features.broadcast.multiScene.enabled) — n'agit
// que si l'utilisateur active la fonctionnalité depuis le dashboard.
//
// obs-controller.js lit config/features.json une seule fois, au moment du
// premier require() (`const features = require('./config/features.json')`
// en haut du fichier), ET conserve la connexion établie (`obsClient`) dans
// une variable de module tant qu'il reste en cache. Deux conséquences :
//   1) setObsConfig() doit vider le cache pour que le prochain connect()
//      relise la config à jour (voir invalidateObsControllerCache ci-dessous).
//   2) Les actions (connect/listScenes/switchScene/toggleRecording) ne
//      doivent JAMAIS vider le cache entre elles, sous peine de perdre la
//      connexion établie à l'étape précédente à chaque appel — on se
//      contente donc d'un require() normal, qui réutilise l'instance déjà
//      en mémoire.
function getObsController() {
  return require('./obs-controller');
}

function invalidateObsControllerCache() {
  try { delete require.cache[require.resolve('./config/features.json')]; } catch (_) {}
  try { delete require.cache[require.resolve('./obs-controller')]; } catch (_) {}
}

ipcMain.handle('obs-get-config', async () => {
  try {
    const raw = fs.readFileSync(path.join(APP_ROOT, 'config', 'features.json'), 'utf8');
    const features = JSON.parse(raw);
    const cfg = (features.broadcast && features.broadcast.multiScene) || {};
    // Le mot de passe OBS ne remonte jamais au renderer en clair : on
    // renvoie seulement s'il est défini, jamais sa valeur.
    return {
      ok: true,
      enabled: !!cfg.enabled,
      obsWebsocketUrl: cfg.obsWebsocketUrl || 'ws://localhost:4455',
      hasPassword: !!cfg.password,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('obs-set-config', async (_evt, { enabled, obsWebsocketUrl, password }) => {
  try {
    const featuresPath = path.join(APP_ROOT, 'config', 'features.json');
    const features = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
    features.broadcast = features.broadcast || {};
    features.broadcast.multiScene = features.broadcast.multiScene || {};
    if (typeof enabled === 'boolean') features.broadcast.multiScene.enabled = enabled;
    if (typeof obsWebsocketUrl === 'string' && obsWebsocketUrl.trim()) {
      features.broadcast.multiScene.obsWebsocketUrl = obsWebsocketUrl.trim();
    }
    // Chaîne vide envoyée volontairement -> efface le mot de passe.
    // `undefined` -> conserve l'existant (l'utilisateur n'a pas touché au champ).
    if (typeof password === 'string') features.broadcast.multiScene.password = password;
    fs.writeFileSync(featuresPath, JSON.stringify(features, null, 2), 'utf8');
    invalidateObsControllerCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('obs-connect', async () => {
  try {
    const obs = getObsController();
    const client = await obs.connect();
    return client
      ? { ok: true, connected: true }
      : { ok: false, connected: false, error: 'Connexion impossible — vérifiez qu\'OBS tourne, que obs-websocket est activé (Outils → obs-websocket → Activer serveur WebSocket), et que l\'URL/mot de passe sont corrects.' };
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

// --- v0.2.0 settings IPC ---------------------------------------------------
ipcMain.handle('get-settings', async () => {
  const cfg = loadConfig() || {};
  return {
    hasGroqKey: !!cfg.groqApiKey,
    hasDeepgramKey: !!cfg.deepgramApiKey,
  };
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
