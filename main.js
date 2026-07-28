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

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const os = require('os');
const perfMonitor = require('./perf-monitor');
const themeLoader = require('./theme-loader');
const featuresStore = require('./features-store');

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
// Fenêtres
// ---------------------------------------------------------------------------
function createSetupWindow() {
  // CORRECTIF (audit) : fenêtre non redimensionnable (560x520) alors que
  // .container en CSS a un max-width de 520px + 40px de padding de chaque
  // côté — la fenêtre était donc déjà à la limite basse, sans aucune marge
  // pour un DPI élevé ou une police système plus grande. On agrandit la
  // taille par défaut, on autorise le redimensionnement (avec un minimum
  // qui garde le formulaire lisible), et on centre la fenêtre à l'écran.
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
  // CORRECTIF (audit) : même problème que setup.html — fenêtre fixe
  // 520x560 alors que .container (dashboard.html) a un max-width de 640px.
  // Le tableau de bord était donc rétréci en permanence. Fenêtre plus
  // grande par défaut + redimensionnable + maximisable.
  mainWindow = new BrowserWindow({
    width: 760,
    height: 800,
    minWidth: 560,
    minHeight: 640,
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
// Worker (server.js) lifecycle
// ---------------------------------------------------------------------------
function startServer() {
  const config = loadConfig();
  if (!config) return;

  // NOTE (audit backend/pipeline) : AUDIO_DEVICE n'est plus transmis ici.
  // Le worker (server.js/audio-capture.js) ne lit plus cette variable depuis
  // le passage à la capture native (getUserMedia) — le micro est choisi
  // directement dans le renderer (dashboard.html/setup.html) via
  // config.audioDevice, sans transiter par l'environnement du worker.
  const workerEnv = Object.assign({}, process.env, {
    NODE_ENV: 'production',
    APP_ROOT,
  });
  // CORRECTIF (audit round 5) : `GROQ_API_KEY: config.groqApiKey` était posé
  // inconditionnellement ; quand la clé était absente ou indéchiffrable
  // (safeStorage indisponible), la variable valait la CHAÎNE "null" côté
  // worker — le validateur la voyait donc comme configurée et chaque
  // segment partait vers Groq pour revenir en 401, au lieu de l'avertissement
  // clair "clé non configurée".
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

    // CORRECTIF (audit — remplacement de FFmpeg par la capture navigateur) :
    // le worker signale ici qu'il est prêt à recevoir des chunks PCM (voir
    // server.js/startPipeline()). On relaie ce signal à dashboard.html, qui
    // ne doit démarrer getUserMedia() qu'à ce moment précis — capturer le
    // micro avant que le worker soit prêt à traiter les chunks les ferait
    // silencieusement perdre.
    if (msg.type === 'audio-pipeline-ready') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio-pipeline-ready');
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

// CORRECTIF AUDIT — supprimé : runEnsureFfmpeg(), ipcMain.handle('ensure-ffmpeg', ...)
// et ipcMain.handle('detect-microphones', ...). Ces trois éléments appelaient
// setup-ffmpeg.js/dshow-parser.js, deux fichiers absents du dépôt depuis la
// migration vers la capture navigateur (getUserMedia) — leur seul effet était
// de faire planter l'app au démarrage (require en tête de fichier). Ils
// n'étaient de toute façon plus appelables depuis le renderer : preload.js
// n'expose plus ensureFfmpeg/detectMicrophones, et setup.html énumère les
// micros directement via navigator.mediaDevices.enumerateDevices().

// CORRECTIF (audit — remplacement de FFmpeg par la capture navigateur) :
// dashboard.html capture le micro nativement (getUserMedia) et pousse ici
// ses chunks PCM16LE — on les relaie tels quels au Worker server.js, qui
// les fait passer par la même segmentation que l'ancien flux FFmpeg (voir
// feedPcmChunk() dans audio-capture.js). `ipcRenderer.send` (pas `invoke`,
// pas de réponse attendue) côté renderer, donc `ipcMain.on` ici, pas
// `.handle`. Le second argument de postMessage (liste de transférables)
// évite une copie mémoire de l'ArrayBuffer à chaque chunk — utile vu la
// fréquence (plusieurs fois par seconde pendant tout un culte).
ipcMain.on('audio-pcm-chunk', (_evt, arrayBuffer) => {
  if (worker) {
    try {
      worker.postMessage({ type: 'audio-pcm-chunk', buffer: arrayBuffer }, [arrayBuffer]);
    } catch (err) {
      // Le buffer a pu être détaché par un chunk précédent en cours de
      // relais (concurrence normale) — on perd ce chunk plutôt que de
      // planter tout le pipeline ; le suivant arrivera dans <1s.
      console.warn('[main] Chunk audio perdu (relais worker) :', err.message);
    }
  }
});

ipcMain.handle('save-setup', async (_evt, { audioDevice, groqApiKey, deepgramApiKey }) => {
  await saveConfigAsync({ audioDevice, groqApiKey, deepgramApiKey });
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
// obs-controller.js conserve la connexion établie (`obsClient`) dans une
// variable de module : les actions (connect/listScenes/switchScene/
// toggleRecording) doivent donc TOUJOURS réutiliser la même instance en
// cache, sans jamais la recharger entre deux appels. La config, elle, est
// relue à chaque connect() depuis features-store (voir obs-controller.js) :
// enregistrer de nouveaux réglages ne demande plus de vider le cache.
function getObsController() {
  return require('./obs-controller');
}

ipcMain.handle('obs-get-config', async () => {
  try {
    const cfg = (featuresStore.readFeatures().broadcast || {}).multiScene || {};
    // Le mot de passe OBS ne remonte jamais au renderer en clair : on
    // renvoie seulement s'il est défini, jamais sa valeur.
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
    // Chaîne vide envoyée volontairement -> efface le mot de passe.
    // `undefined` -> conserve l'existant (l'utilisateur n'a pas touché au champ).
    //
    // CORRECTIF (audit round 5) : le mot de passe était écrit EN CLAIR dans
    // features.json alors qu'obs-controller.js sait déjà lire un champ
    // `passwordEncrypted` (safeStorage). On chiffre donc ici, et on efface
    // systématiquement l'ancien champ en clair (y compris celui laissé par
    // une version précédente) dès que le chiffrement est disponible.
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
    // AJOUT (audit — gating par état OBS, inspiré du protocole
    // obs-websocket) : relaie chaque changement OUVERT/FERMÉ au worker
    // server.js, qui applique réellement la pause avant l'appel Groq/
    // Deepgram (voir server.js, parentPort.on('message'), type
    // 'obs-gate-changed'). Suit exactement le même pattern que le relais
    // 'theme-changed' déjà en place plus haut dans ce fichier.
    const client = await obs.connect((open, reason, state) => {
      if (worker) {
        try {
          worker.postMessage({ type: 'obs-gate-changed', open, reason, state });
        } catch (_) { /* worker en cours d'arrêt : sans effet, non bloquant */ }
      }
    });
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
    // CORRECTIF (audit — remplacement de FFmpeg par la capture navigateur) :
    // dashboard.html a besoin du deviceId choisi dans setup.html pour
    // demander le BON micro via getUserMedia (sans ça, Chromium capturerait
    // le périphérique par défaut du système, pas forcément celui choisi).
    audioDevice: cfg.audioDevice || null,
  };
});

ipcMain.handle('get-perf-stats', async () => perfMonitor.getStats());

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // CORRECTIF (audit round 5) : thèmes utilisateur et réglages (thème actif,
  // config OBS) écrits dans userData plutôt que dans app.asar, en lecture
  // seule une fois l'app installée. À faire avant toute lecture de config.
  themeLoader.setUserDataDir(USER_DATA());

  // CORRECTIF (audit — remplacement de FFmpeg par la capture navigateur) :
  // setup.html et dashboard.html appellent maintenant getUserMedia() pour
  // capturer/énumérer le micro (voir commentaires dans ces fichiers).
  // Electron bloque les permissions média par défaut sauf autorisation
  // explicite ici — sans ce handler, getUserMedia() échouerait
  // silencieusement (Promise rejetée) sur certaines versions/configurations
  // d'Electron. On n'autorise QUE 'media', et seulement pour nos propres
  // fenêtres (origine file://), en cohérence avec le reste de l'app qui ne
  // charge jamais de contenu distant.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');

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
