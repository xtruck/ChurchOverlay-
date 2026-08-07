/**
 * ============================================================================
 * electron/main.js — Coquille application pour ChurchOverlay
 * ----------------------------------------------------------------------------
 * v1.0.1 — FIXED: auto-updater is optional (won't crash if not installed)
 * ============================================================================
 */

'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { Worker } = require('worker_threads');
const crypto = require('crypto');
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

// ---------------------------------------------------------------------------
// Chargement de .env — MANQUANT jusqu'ici dans l'app packagée
// ---------------------------------------------------------------------------
// CORRECTIF CRITIQUE (transcription qui ne démarre jamais malgré des clés
// API renouvelées, visualiseur audio qui ne bouge pas) : server.js et
// config-validator.js lisent bien process.env.MIC_SILENCE_THRESHOLD,
// process.env.PORT, etc., mais RIEN dans main.js ne chargeait jamais le
// fichier .env dans process.env avant de démarrer le worker server.js —
// seul `npm run server-only` (mode développement, via le flag Node
// --env-file-if-exists) le faisait. L'app Electron réelle (ce fichier)
// démarrait donc TOUJOURS avec les seules variables d'environnement déjà
// présentes dans le process (celles de l'OS, quasiment jamais celles d'un
// .env de projet) — chaque réglage placé dans .env (MIC_SILENCE_THRESHOLD,
// PORT personnalisé, WS_HOST...) était donc silencieusement ignoré par
// l'app réelle, alors qu'il fonctionnait bien dans les tests (qui
// utilisaient tous --env-file-if-exists).
//
// Un .env ne doit JAMAIS être inclus dans l'installateur packagé (il
// contiendrait des clés en clair, livrées à quiconque installe l'app) —
// on cherche donc ce fichier dans le dossier de données utilisateur
// (USER_DATA(), ex. %APPDATA%\ChurchOverlay sous Windows — accessible et
// modifiable même pour l'app installée), avec un repli sur APP_ROOT
// (utile en mode développement, où .env vit à côté de main.js). Logique
// de chargement extraite dans dotenv-loader.js (testable sans Electron).
const { loadDotEnvInto } = require('./dotenv-loader');
loadDotEnvInto(
  process.env,
  [path.join(USER_DATA(), '.env'), path.join(APP_ROOT, '.env')],
  (loadedPath) => console.log(`[main] .env chargé depuis ${loadedPath}`)
);

// CORRECTIF (bug "overlay hors ligne par défaut") : un correctif précédent
// avait déjà identifié que dashboard.html/overlay.html ne pouvaient pas
// déduire le port depuis window.location.host (chargés en file://) et
// avait tenté d'harmoniser ça avec server.js — mais avait fixé la valeur
// par défaut à 3000, alors que le VRAI défaut de server.js (voir
// config-validator.js > ENV_SCHEMA.PORT, couvert par
// test-config-validator.js) est 8765. Résultat : quand PORT n'est pas
// défini (cas par défaut), server.js écoutait sur 8765 mais main.js
// transmettait 3000 à overlay.html — qui ne pouvait donc jamais se
// connecter. Corrigé en harmonisant sur 8765, la valeur réellement
// utilisée par server.js.
function resolveServerPort() {
  const raw = (process.env.PORT || '').trim();
  if (!raw) return 8765;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8765;
}
const SERVER_PORT = resolveServerPort();
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
// CORRECTIF (audit round 7) : le worker retentait automatiquement à chaque
// sortie (toutes les ~500ms) sans distinguer la cause. Pour un port déjà
// occupé (EADDRINUSE — l'app précédente n'a pas complètement fermé, ou un
// `node server.js` manuel tourne encore), retenter est inutile : le port ne
// se libère pas tout seul en 500ms, donc les 3 tentatives échouaient
// systématiquement en ~1,5s, épuisant le budget de crashes et affichant un
// message générique ("après 4 crashes") au lieu de la vraie cause pourtant
// déjà connue du worker. On mémorise la dernière alerte reçue pour réagir
// spécifiquement à ce cas dans le handler 'exit' ci-dessous.
let lastAlertCode = null;
let lastAlertMessage = '';
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

// ---------------------------------------------------------------------------
// WS_AUTH_TOKEN — généré et persisté automatiquement pour l'app packagée
// ---------------------------------------------------------------------------
// AMÉLIORATION (audit) : jusqu'ici WS_AUTH_TOKEN n'existait que si un
// utilisateur avancé le définissait lui-même via une vraie variable
// d'environnement — dans l'app packagée (`npm start` / l'exe installé),
// ce n'était donc quasiment jamais le cas, et server.js se contentait
// d'un avertissement en log. Concrètement, le serveur WebSocket tournait
// sans authentification par défaut : tant que WS_HOST=127.0.0.1 (le
// défaut), le risque reste faible, mais un opérateur qui change WS_HOST
// pour exposer le pipeline sur le réseau de l'église (cas documenté dans
// le README) se retrouvait protégé uniquement par une case à cocher
// qu'il faut lire et remplir soi-même.
//
// On génère désormais un jeton aléatoire (32 octets, encodage base64url)
// au premier démarrage de l'app installée, on le persiste chiffré dans
// config.json (même mécanisme que les clés Groq/Deepgram via safeStorage),
// et on l'injecte dans process.env.WS_AUTH_TOKEN avant que quoi que ce
// soit d'autre (fenêtre principale, worker server.js, URL overlay pour
// OBS) ne soit créé. Tout le reste du code (server.js, dashboard.html,
// overlay.html, getOverlayUrl()) lisait déjà process.env.WS_AUTH_TOKEN /
// le paramètre ?token= — aucun de ces fichiers n'a besoin de changer.
//
// Un utilisateur avancé qui définit lui-même WS_AUTH_TOKEN dans son
// environnement (mode `server-only`, ou lancement Electron depuis un
// script) garde la main : on ne touche jamais à une valeur déjà présente.
// SECURITY (backend audit): originally generated only WS_AUTH_TOKEN, which
// server.js treated as a single shared operator+viewer credential — role
// was assigned by request path, not by which token a client held, so any
// holder of the one token (including the OBS overlay URL, meant to be
// read-only) got full operator control. Generalized to also mint an
// independent WS_VIEWER_TOKEN so the overlay can hold a strictly
// read-only credential.
function ensureWsToken(envVar, encryptedField, plaintextField) {
  const existing = (process.env[envVar] || '').trim();
  if (existing) {
    return existing; // valeur explicite fournie par l'utilisateur : on ne l'écrase pas
  }

  const existingRaw = readRawConfig();
  let token = null;

  if (existingRaw[encryptedField] && safeStorage.isEncryptionAvailable()) {
    try {
      token = safeStorage.decryptString(Buffer.from(existingRaw[encryptedField], 'base64'));
    } catch (e) {
      console.error(`[main] Échec du déchiffrement de ${envVar}, régénération:`, e.message);
    }
  } else if (existingRaw[plaintextField]) {
    // Ancien format non chiffré (chiffrement indisponible lors de la génération) : réutilisé tel quel.
    token = existingRaw[plaintextField];
  }

  if (!token || token.length < 16) {
    token = crypto.randomBytes(32).toString('base64url');
    const toWrite = Object.assign({}, readRawConfig());
    delete toWrite[plaintextField];
    if (safeStorage.isEncryptionAvailable()) {
      toWrite[encryptedField] = safeStorage.encryptString(token).toString('base64');
    } else {
      console.warn(`[main] Chiffrement système indisponible : ${envVar} stocké en clair.`);
      toWrite[plaintextField] = token;
    }
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
      fs.writeFileSync(CONFIG_PATH(), JSON.stringify(toWrite, null, 2), 'utf8');
    } catch (e) {
      console.error(
        `[main] Impossible de persister ${envVar} généré (nouveau jeton à chaque démarrage):`,
        e.message
      );
    }
  }

  process.env[envVar] = token;
  return token;
}

function ensureWsAuthToken() {
  ensureWsToken('WS_AUTH_TOKEN', 'wsAuthTokenEncrypted', 'wsAuthToken');
  ensureWsToken('WS_VIEWER_TOKEN', 'wsViewerTokenEncrypted', 'wsViewerToken');
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
    : raw.groqApiKey || null;
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
    logBatchInterval: Number.isFinite(raw.logBatchInterval)
      ? raw.logBatchInterval
      : DASHBOARD_FLUSH_MS,
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
    audioDevice:
      config.audioDevice !== undefined && config.audioDevice !== null
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
    if (existingRaw.groqApiKeyEncrypted)
      toWrite.groqApiKeyEncrypted = existingRaw.groqApiKeyEncrypted;
    if (existingRaw.groqApiKey) toWrite.groqApiKey = existingRaw.groqApiKey;
  }

  if (config.deepgramApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      toWrite.deepgramApiKeyEncrypted = safeStorage
        .encryptString(config.deepgramApiKey)
        .toString('base64');
    } else {
      console.warn('[main] Chiffrement système indisponible : clé Deepgram stockée en clair.');
      toWrite.deepgramApiKey = config.deepgramApiKey;
    }
  } else {
    if (existingRaw.deepgramApiKeyEncrypted)
      toWrite.deepgramApiKeyEncrypted = existingRaw.deepgramApiKeyEncrypted;
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
  // CORRECTIF (bug "app tout le temps déconnectée") : server.js exige un
  // ?token=WS_AUTH_TOKEN sur chaque connexion WebSocket dès que la variable
  // est définie, mais dashboard.html est chargé ici en file:// sans aucune
  // query string — le token n'atteignait donc jamais le renderer, chaque
  // connexion était rejetée (1008) et retentait en boucle. On le passe
  // désormais explicitement via l'option `query` de loadFile ; dashboard.html
  // le relit dans getWsUrl() via window.location.search.
  mainWindow.loadFile(path.join(__dirname, 'dashboard.html'), {
    query: {
      ...(process.env.WS_AUTH_TOKEN ? { token: process.env.WS_AUTH_TOKEN } : {}),
      port: String(SERVER_PORT),
    },
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ---------------------------------------------------------------------------
// AJOUT (audit — plusieurs façons d'afficher l'overlay, gratuit/léger) :
// jusqu'ici overlay.html n'existait que comme Browser Source à coller dans
// OBS. Certaines églises n'utilisent pas OBS du tout et projettent
// directement sur un vidéoprojecteur — cette fenêtre charge le MÊME
// overlay.html, en plein écran sur l'écran choisi, sans passer par OBS.
// Aucune nouvelle dépendance : uniquement le module `screen` déjà fourni par
// Electron.
// ---------------------------------------------------------------------------
let displayWindow = null;

function listDisplays() {
  return screen.getAllDisplays().map((d, index) => ({
    id: d.id,
    label: `Écran ${index + 1}${d.id === screen.getPrimaryDisplay().id ? ' (principal)' : ''} — ${d.bounds.width}×${d.bounds.height}`,
    bounds: d.bounds,
  }));
}

function createDisplayWindow(displayId) {
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => d.id === displayId) || screen.getPrimaryDisplay();

  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.close();
    displayWindow = null;
  }

  displayWindow = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'icon.png'),
    title: 'ChurchOverlay — Affichage direct',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  displayWindow.setMenuBarVisibility(false);
  // Même jeton WS que mainWindow (voir createMainWindow) — overlay.html en
  // file:// lit ce token via getWsUrl()/window.location.search, exactement
  // comme dashboard.html.
  displayWindow.loadFile(path.join(__dirname, 'overlay.html'), {
    query: process.env.WS_AUTH_TOKEN ? { token: process.env.WS_AUTH_TOKEN } : {},
  });
  displayWindow.on('closed', () => {
    displayWindow = null;
  });
  return { opened: true };
}

function closeDisplayWindow() {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.close();
  }
  displayWindow = null;
  return { closed: true };
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('ChurchOverlay');
  refreshTrayMenu();
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
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
    {
      label: 'Ouvrir ChurchOverlay',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { label: 'Redémarrer le pipeline', click: () => restartServer() },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------
function startServer() {
  const config = loadConfig();
  if (!config) return;

  // CORRECTIF (audit round 7) : lastAlertCode ne doit refléter que la
  // tentative de démarrage en cours — sans ce reset, une ancienne alerte
  // 'server-listen-error' (port occupé) pouvait survivre à un redémarrage
  // réussi puis faire croire, à tort, qu'un crash sans rapport plus tard
  // était encore un problème de port.
  lastAlertCode = null;
  lastAlertMessage = '';

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
        lastAlertCode = null;
        lastAlertMessage = '';
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
      lastAlertCode = msg.code || null;
      lastAlertMessage = msg.message || '';
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
    worker = null;

    if (wasIntentional) {
      serverStatus = 'stopped';
      refreshTrayMenu();
      scheduleDashboardFlush();
      const cb = onWorkerStopped;
      onWorkerStopped = null;
      if (cb) cb();
      return;
    }

    recentCrashes = recentCrashes.filter((t) => Date.now() - t < WORKER_CRASH_WINDOW_MS);
    recentCrashes.push(Date.now());

    // CORRECTIF (audit round 7) : EADDRINUSE ne se résout pas en 500ms — le
    // port ne se libère pas tout seul. Retenter automatiquement ne fait que
    // gaspiller le budget de crashes pour rien et retarde un message clair
    // de plusieurs secondes. On coupe court immédiatement, avec le message
    // déjà précis envoyé par server.js (voir alert 'server-listen-error').
    if (lastAlertCode === 'server-listen-error') {
      console.error('[main] Port déjà utilisé — pas de nouvelle tentative automatique.');
      appendLog(
        lastAlertMessage || 'Le port du serveur est déjà utilisé par une autre application.',
        true
      );
      serverStatus = 'error';
      refreshTrayMenu();
      scheduleDashboardFlush();
      return;
    }

    if (recentCrashes.length > WORKER_MAX_CRASHES) {
      console.error(
        '[main] Trop de crashes worker (%d en %ds) — arrêt du pipeline.',
        recentCrashes.length,
        WORKER_CRASH_WINDOW_MS / 1000
      );
      appendLog(
        `Pipeline arrêté après ${recentCrashes.length} crashes rapprochés (code ${code}). ` +
          'Cliquez sur Redémarrer.',
        true
      );
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
  if (!worker) {
    cb && cb();
    return;
  }
  shuttingDownWorker = true;
  onWorkerStopped = cb || null;

  try {
    worker.postMessage({ type: 'shutdown' });
  } catch (e) {
    console.warn('[main] postMessage shutdown a échoué, terminate forcé:', e.message);
    try {
      worker.terminate();
    } catch (_) {}
    return;
  }

  setTimeout(() => {
    if (worker && shuttingDownWorker) {
      console.warn('[main] Arrêt gracieux du pipeline expiré (5s) — terminate forcé.');
      try {
        worker.terminate();
      } catch (_) {}
    }
  }, 5000);
}

function restartServer() {
  if (!worker) {
    startServer();
    return;
  }
  stopServerGracefully(() => setTimeout(startServer, 500));
}

function scheduleWorkerRecycle() {
  clearWorkerRecycle();
  workerRecycleTimer = setTimeout(() => {
    if (!worker) return;
    if (shuttingDownWorker) return;
    const uptime = Date.now() - workerStartedAt;
    if (uptime >= WORKER_MAX_UPTIME_MS) {
      console.log("[main] Recyclage du worker après %d min d'uptime.", Math.round(uptime / 60000));
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

// CORRECTIF (bug "overlay/OBS tout le temps hors ligne" quand WS_AUTH_TOKEN
// est défini) : dashboard.html et setup.html reçoivent désormais le token
// via l'option `query` de loadFile (voir createMainWindow), mais l'URL
// overlayUrl envoyée au tableau de bord — celle que l'utilisateur copie
// dans OBS comme Browser Source — était générée sans ?token=.... overlay.html
// (getWsUrl) relit pourtant le token depuis window.location.search : sans
// lui, chaque connexion WebSocket de l'overlay est rejetée (code 1008) et
// retente indéfiniment, donc le verset ne s'affiche jamais dans OBS même
// si le tableau de bord se montre "Serveur En Ligne". Centralise la
// construction de l'URL ici pour que le token soit toujours ajouté.
//
// SECURITY (backend audit): this URL is the one meant to be pasted into
// OBS as a Browser Source and is inherently more exposed than the
// dashboard (visible in OBS scene/source settings, sharable by accident
// when someone exports/shares an OBS scene collection). It now carries
// WS_VIEWER_TOKEN, a credential that only grants read-only overlay access
// server-side, instead of the operator token — so leaking this URL no
// longer hands out full control of the live pipeline.
function getOverlayUrl() {
  const base = 'file:///' + path.join(APP_ROOT, 'overlay.html').replace(/\\/g, '/');
  const token = (process.env.WS_VIEWER_TOKEN || '').trim();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  params.set('port', String(SERVER_PORT));
  return `${base}?${params.toString()}`;
}
const recentLogs = [];
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
    overlayUrl: getOverlayUrl(),
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
  overlayUrl: getOverlayUrl(),
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
          console.warn(
            '[main] Chiffrement système indisponible : mot de passe OBS stocké en clair.'
          );
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
      : { ok: false, connected: false, error: "Connexion impossible — vérifiez qu'OBS tourne." };
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

// --- AJOUT (audit — plusieurs façons d'afficher l'overlay) ------------------
ipcMain.handle('list-displays', async () => listDisplays());
ipcMain.handle('open-display-window', async (_evt, { displayId }) => createDisplayWindow(displayId));
ipcMain.handle('close-display-window', async () => closeDisplayWindow());

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
// NOTE (audit CPU) : app.disableHardwareAcceleration() a été retiré ici.
// L'intention d'origine ("l'app n'affiche que du texte/CSS, pas de rendu
// 3D") ne correspond plus à dashboard.html : il contient 21 panneaux avec
// backdrop-filter: blur()/saturate(), un halo conic-gradient, un dégradé
// plein écran et 7 animations CSS en boucle infinie (halo-spin, mote-rise,
// sacred-breathe, filigree-glow, mic-pulse, pulse-ring, offlineAttention),
// plus le visualiseur audio en canvas/requestAnimationFrame. Sans
// accélération matérielle, Chromium doit calculer tout ça en logiciel
// (SwiftShader) sur le CPU à chaque frame — c'est la cause la plus probable
// des ralentissements/CPU élevé signalés, précisément à cause de ces effets
// de flou qui sont eux beaucoup plus coûteux sans GPU. Laisser Electron
// utiliser l'accélération matérielle par défaut.

app.whenReady().then(async () => {
  ensureWsAuthToken();
  themeLoader.setUserDataDir(USER_DATA());

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === 'media'
  );

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
    appendLog(
      'Configuration requise : microphone et/ou clé API Groq manquants. Ouvrez Paramètres dans le tableau de bord.',
      false
    );
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
  console.error('[main] Uncaught exception:', (err && err.stack) || err);
  appendLog('Erreur non gérée: ' + (err && err.message), true);
});
