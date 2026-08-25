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
  dialog,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
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
    wsHost: raw.wsHost || null,
    // AJOUT (bascule streaming Deepgram visible dans le tableau de bord) :
    // 'deepgram' n'est retenu que si la valeur brute le dit explicitement —
    // toute autre valeur (absente, corrompue, ancien format) retombe sur
    // 'auto', le comportement historique inchangé (Groq par segments).
    asrProvider: raw.asrProvider === 'deepgram' ? 'deepgram' : 'auto',
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

  // CORRECTIF (carte réseau — wsHost/jetons WS silencieusement effacés) :
  // cette fonction reconstruit toWrite depuis zéro à partir des seuls champs
  // qu'elle connaît explicitement (voir commentaire en tête de fonction).
  // Sans ceci, enregistrer une clé API depuis ce même panneau de réglages
  // effacerait wsHost (voir save-network-settings) ET les jetons WS déjà
  // persistés par ensureWsToken() — régénérés au prochain démarrage, ce qui
  // invaliderait tout lien overlay/OBS déjà collé avec l'ancien jeton.
  if (existingRaw.wsHost) toWrite.wsHost = existingRaw.wsHost;
  if (existingRaw.wsAuthTokenEncrypted)
    toWrite.wsAuthTokenEncrypted = existingRaw.wsAuthTokenEncrypted;
  if (existingRaw.wsAuthToken) toWrite.wsAuthToken = existingRaw.wsAuthToken;
  if (existingRaw.wsViewerTokenEncrypted)
    toWrite.wsViewerTokenEncrypted = existingRaw.wsViewerTokenEncrypted;
  if (existingRaw.wsViewerToken) toWrite.wsViewerToken = existingRaw.wsViewerToken;

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
// CORRECTIF (stage display / diaporama d'annonces) : une seule variable
// `displayWindow` ne pouvait porter qu'UNE fenêtre à la fois — impossible
// d'avoir le vidéoprojecteur (overlay.html) et l'écran scène (stage-
// display.html) ouverts simultanément sur deux écrans différents, alors que
// c'est exactement le scénario visé par ces deux fonctionnalités. Remplacée
// par une petite table {mode: BrowserWindow|null}, une fenêtre indépendante
// par mode. displayWindow(s) au singulier restait le nom de la fonctionnalité
// d'origine (multi-écrans) ; ce n'est que son STOCKAGE qui change.
const DISPLAY_MODES = {
  overlay: { file: 'overlay.html', title: 'ChurchOverlay — Affichage direct' },
  stage: { file: 'stage-display.html', title: 'ChurchOverlay — Écran scène' },
  announcements: { file: 'announcement-loop.html', title: 'ChurchOverlay — Diaporama annonces' },
};
const displayWindows = { overlay: null, stage: null, announcements: null };

function listDisplays() {
  return screen.getAllDisplays().map((d, index) => ({
    id: d.id,
    label: `Écran ${index + 1}${d.id === screen.getPrimaryDisplay().id ? ' (principal)' : ''} — ${d.bounds.width}×${d.bounds.height}`,
    bounds: d.bounds,
  }));
}

function createDisplayWindow(displayId, mode = 'overlay') {
  const modeConfig = DISPLAY_MODES[mode] || DISPLAY_MODES.overlay;
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => d.id === displayId) || screen.getPrimaryDisplay();

  if (displayWindows[mode] && !displayWindows[mode].isDestroyed()) {
    displayWindows[mode].close();
    displayWindows[mode] = null;
  }

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'icon.png'),
    title: modeConfig.title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Même jeton WS que mainWindow (voir createMainWindow) — chaque page en
  // file:// lit ce token via getWsUrl()/window.location.search, exactement
  // comme dashboard.html/overlay.html.
  win.loadFile(path.join(__dirname, modeConfig.file), {
    query: process.env.WS_AUTH_TOKEN ? { token: process.env.WS_AUTH_TOKEN } : {},
  });
  win.on('closed', () => {
    displayWindows[mode] = null;
  });
  displayWindows[mode] = win;
  return { opened: true, mode };
}

function closeDisplayWindow(mode = 'overlay') {
  const win = displayWindows[mode];
  if (win && !win.isDestroyed()) {
    win.close();
  }
  displayWindows[mode] = null;
  return { closed: true, mode };
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
  // AJOUT (carte réseau — QR caméra téléphone) : jusqu'ici WS_HOST ne pouvait
  // venir que de .env, à éditer manuellement. Même pattern que les clés
  // Groq/Deepgram ci-dessus — server.js garde son garde-fou existant (refus
  // de bind non-local sans WS_AUTH_TOKEN, voir server.js) inchangé, il ne se
  // déclenche simplement plus pour un opérateur normal puisque le jeton est
  // désormais toujours présent (ensureWsToken(), déjà appelé au démarrage).
  if (config.wsHost) {
    workerEnv.WS_HOST = config.wsHost;
  }
  // AJOUT (bascule streaming Deepgram visible) : n'active ASR_PROVIDER=deepgram
  // que si une clé Deepgram est AUSSI configurée — asr-engine.js échoue déjà
  // proprement dans ce cas (voir son message d'erreur explicite), mais mieux
  // vaut ne jamais démarrer le pipeline dans un état voué à l'échec plutôt
  // que de compter sur ce garde-fou en aval. Toute autre valeur (dont
  // 'auto') retombe sur le comportement historique (pas de ASR_PROVIDER
  // forcé, asr-engine.js résout 'auto').
  if (config.asrProvider === 'deepgram' && config.deepgramApiKey) {
    workerEnv.ASR_PROVIDER = 'deepgram';
  } else {
    delete workerEnv.ASR_PROVIDER;
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

    // AJOUT (pont ProPresenter — envoi automatique des versets détectés) :
    // ignoré silencieusement si non activé/non connecté — pas d'erreur ni
    // de log parasite pour l'immense majorité des installations qui
    // n'utilisent pas ProPresenter (features.broadcast.propresenter.enabled
    // reste false par défaut).
    if (msg.type === 'verse-shown') {
      try {
        const cfg = (featuresStore.readFeatures().broadcast || {}).propresenter || {};
        if (cfg.enabled && cfg.autoSendVerses) {
          const pp = getProPresenterController();
          if (pp.isConnected()) {
            pp.sendStageMessage(`${msg.verse.reference}\n${msg.verse.text}`);
          }
        }
      } catch (_e) {
        /* best effort — jamais bloquant pour le pipeline principal */
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

// AJOUT (habillage caméra — logo/titre par-dessus la source caméra dans
// OBS). Même construction que getOverlayUrl() ci-dessus (même jeton
// WS_VIEWER_TOKEN en lecture seule), juste une page différente —
// branding-overlay.html est une Source Navigateur OBS SÉPARÉE, à empiler
// au-dessus de la source caméra dans la scène.
function getBrandingOverlayUrl() {
  const base = 'file:///' + path.join(APP_ROOT, 'branding-overlay.html').replace(/\\/g, '/');
  const token = (process.env.WS_VIEWER_TOKEN || '').trim();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  params.set('port', String(SERVER_PORT));
  return `${base}?${params.toString()}`;
}
const recentLogs = [];
let dashboardFlushTimer = null;
let dashboardDirty = false;

// CORRECTIF (test réel — impossible de voir les logs du worker, ex.
// "[audio-capture] VAD : Silero actif") : worker.stdout/stderr sont
// interceptés par Node (Worker créé avec stdout:true/stderr:true, voir
// plus haut) et n'atteignent donc PLUS automatiquement le terminal —
// avant ce correctif, cette fonction se contentait de les stocker dans
// recentLogs, envoyé par IPC au tableau de bord... qui ne les affiche
// nulle part (aucun composant ne lit payload.logs). Résultat : ces
// journaux (essentiels pour diagnostiquer VAD/ASR en conditions réelles)
// n'étaient visibles NULLE PART, ni dans le terminal, ni dans DevTools,
// ni dans l'appli — confirmé lors d'un test réel avec micro humain. On
// les réémet donc aussi vers la console du process principal, qui elle
// reste bien connectée au terminal quand l'app tourne via `npm start`.
function appendLog(text, isError) {
  const line = { text: String(text || ''), isError: !!isError, ts: Date.now() };
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOG_LINES) {
    recentLogs.splice(0, recentLogs.length - MAX_LOG_LINES);
  }
  const trimmed = line.text.replace(/\n+$/, '');
  if (trimmed) {
    if (isError) console.error(trimmed);
    else console.log(trimmed);
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
    brandingOverlayUrl: getBrandingOverlayUrl(),
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

// AJOUT (carte réseau — "Réseau / caméra téléphone (QR)") : jusqu'ici
// WS_HOST n'avait aucun chemin de persistance en dehors d'une édition
// manuelle de .env — voir startServer() ci-dessus pour comment ce champ
// atteint le worker. WS_AUTH_TOKEN/WS_VIEWER_TOKEN ne sont PAS gérés ici :
// ensureWsToken() les génère et les persiste déjà automatiquement à chaque
// démarrage, rien à ajouter côté UI hormis en afficher le statut (voir
// getNetworkStatus côté server.js).
ipcMain.handle('save-network-settings', async (_evt, { wsHost }) => {
  const trimmed = typeof wsHost === 'string' ? wsHost.trim() : '';
  if (!trimmed) {
    throw new Error('Adresse réseau vide.');
  }
  const raw = readRawConfig();
  raw.wsHost = trimmed;
  await writeRawConfig(raw);
  // Même garde que save-setup ci-dessus : ne démarre pas le pipeline tout
  // seul si le micro/la clé Groq ne sont pas encore configurés.
  if (worker) {
    restartServer();
  } else if (!isFirstRunNeeded()) {
    startServer();
  }
  return true;
});

// AJOUT (bascule streaming Deepgram visible dans le tableau de bord) : même
// discipline que save-network-settings ci-dessus (persiste dans config.json,
// redémarre le pipeline si déjà lancé). Refuse explicitement 'deepgram' sans
// clé Deepgram déjà enregistrée plutôt que de démarrer le pipeline dans un
// état voué à l'échec (asr-engine.js échouerait de toute façon, mais avec un
// message moins clair pour l'opérateur que ce refus immédiat).
ipcMain.handle('set-asr-provider', async (_evt, { provider }) => {
  const wanted = provider === 'deepgram' ? 'deepgram' : 'auto';
  const raw = readRawConfig();
  if (wanted === 'deepgram' && !decryptKey(raw.deepgramApiKeyEncrypted, 'Deepgram')) {
    throw new Error(
      'Aucune clé API Deepgram enregistrée — enregistrez-en une avant d’activer ce mode.'
    );
  }
  raw.asrProvider = wanted;
  await writeRawConfig(raw);
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
  brandingOverlayUrl: getBrandingOverlayUrl(),
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

// AJOUT (Partie 3.1 — StreamStart/StreamStop) : même structure que
// obs-toggle-recording ci-dessus.
ipcMain.handle('obs-toggle-streaming', async () => {
  try {
    const obs = getObsController();
    return await obs.toggleStreaming();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// --- AJOUT (pont ProPresenter — recommandation "ProPresenter Remote/API") --
// Même structure que le bloc OBS ci-dessus, dormant tant que
// features.broadcast.propresenter.enabled reste à false (défaut).
function getProPresenterController() {
  return require('./propresenter-controller');
}

ipcMain.handle('propresenter-get-config', async () => {
  try {
    const cfg = (featuresStore.readFeatures().broadcast || {}).propresenter || {};
    return {
      ok: true,
      enabled: !!cfg.enabled,
      host: cfg.host || 'localhost',
      port: cfg.port || 50001,
      hasPassword: !!(cfg.passwordEncrypted || cfg.password),
      autoSendVerses: !!cfg.autoSendVerses,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle(
  'propresenter-set-config',
  async (_evt, { enabled, host, port, password, autoSendVerses }) => {
    try {
      const features = featuresStore.readFeatures();
      features.broadcast = features.broadcast || {};
      const pp = features.broadcast.propresenter || {};
      features.broadcast.propresenter = pp;
      if (typeof enabled === 'boolean') pp.enabled = enabled;
      if (typeof host === 'string' && host.trim()) pp.host = host.trim();
      if (typeof port === 'number' && port > 0) pp.port = port;
      if (typeof autoSendVerses === 'boolean') pp.autoSendVerses = autoSendVerses;
      if (typeof password === 'string') {
        delete pp.password;
        delete pp.passwordEncrypted;
        if (password) {
          if (safeStorage.isEncryptionAvailable()) {
            pp.passwordEncrypted = safeStorage.encryptString(password).toString('base64');
          } else {
            console.warn(
              '[main] Chiffrement système indisponible : mot de passe ProPresenter stocké en clair.'
            );
            pp.password = password;
          }
        }
      }
      featuresStore.writeFeatures(features);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
);

ipcMain.handle('propresenter-connect', async () => {
  try {
    const pp = getProPresenterController();
    return await pp.connect();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('propresenter-send-message', async (_evt, { text }) => {
  try {
    const pp = getProPresenterController();
    return pp.sendStageMessage(text);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// --- AJOUT (Planning Center Services — recommandation "sync ordre du culte") -
// Même structure que les blocs OBS/ProPresenter ci-dessus. Lecture seule
// (voir planning-center-wrapper.js) — pas d'écriture vers le compte
// Planning Center de l'opérateur.
function getPlanningCenterWrapper() {
  return require('./planning-center-wrapper');
}

ipcMain.handle('pco-get-config', async () => {
  try {
    const cfg = (featuresStore.readFeatures().broadcast || {}).planningCenter || {};
    return {
      ok: true,
      enabled: !!cfg.enabled,
      appId: cfg.appId || '',
      hasSecret: !!(cfg.secretEncrypted || cfg.secret),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pco-set-config', async (_evt, { enabled, appId, secret }) => {
  try {
    const features = featuresStore.readFeatures();
    features.broadcast = features.broadcast || {};
    const pco = features.broadcast.planningCenter || {};
    features.broadcast.planningCenter = pco;
    if (typeof enabled === 'boolean') pco.enabled = enabled;
    if (typeof appId === 'string') pco.appId = appId.trim();
    if (typeof secret === 'string') {
      delete pco.secret;
      delete pco.secretEncrypted;
      if (secret) {
        if (safeStorage.isEncryptionAvailable()) {
          pco.secretEncrypted = safeStorage.encryptString(secret).toString('base64');
        } else {
          console.warn(
            '[main] Chiffrement système indisponible : secret Planning Center stocké en clair.'
          );
          pco.secret = secret;
        }
      }
    }
    featuresStore.writeFeatures(features);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pco-fetch-plan-items', async () => {
  try {
    const pco = getPlanningCenterWrapper();
    return await pco.getUpcomingPlanItems();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-setup', async () => {
  createSetupWindow();
  return true;
});

// AJOUT (carte réseau) : adresse IPv4 locale suggérée pour le champ WS_HOST
// — même logique que getLanIpAddress() dans server.js (dupliquée plutôt que
// partagée : main.js et le worker server.js ne partagent pas de module
// utilitaire aujourd'hui).
function getLanIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

ipcMain.handle('get-settings', async () => {
  const cfg = loadConfig() || {};
  return {
    hasGroqKey: !!cfg.groqApiKey,
    hasDeepgramKey: !!cfg.deepgramApiKey,
    audioDevice: cfg.audioDevice || null,
    needsSetup: isFirstRunNeeded(),
    wsHost: cfg.wsHost || null,
    suggestedLanIp: getLanIpAddress(),
    asrProvider: cfg.asrProvider || 'auto',
  };
});

ipcMain.handle('get-perf-stats', async () => perfMonitor.getStats());

// --- AJOUT (audit — plusieurs façons d'afficher l'overlay) ------------------
// CORRECTIF (stage display / diaporama d'annonces) : `mode` ajouté,
// rétrocompatible ('overlay' par défaut si omis — comportement inchangé
// pour tout appelant existant).
ipcMain.handle('list-displays', async () => listDisplays());
ipcMain.handle('open-display-window', async (_evt, { displayId, mode }) =>
  createDisplayWindow(displayId, mode)
);
ipcMain.handle('close-display-window', async (_evt, { mode } = {}) => closeDisplayWindow(mode));

// --- AJOUT (médiathèque — déclenchement vocal de photos/vidéos) ------------
// Seul point d'accès natif nécessaire côté main.js : le choix du fichier
// (dialog.showOpenDialog n'existe que dans le processus principal). La copie
// du fichier, l'indexation et la mise en correspondance des phrases
// déclencheuses vivent dans media-library.js, chargé par server.js (le
// worker) aux côtés de sermon-archive.js/session-store.js — pas ici, pour
// garder main.js limité à l'accès OS et laisser la logique applicative dans
// le worker, comme pour le reste de l'app.
ipcMain.handle('pick-media-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir une photo ou une vidéo',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images et vidéos',
        extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mov'],
      },
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
      { name: 'Vidéos', extensions: ['mp4', 'webm', 'mov'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// --- AJOUT (chantier 4.6 — extraits vidéo autour des temps forts) ----------
// Deux sélecteurs natifs distincts : la vidéo SOURCE (l'enregistrement
// complet du culte, choisi une fois par export) et le dossier de
// DESTINATION des extraits — même raisonnement que pick-media-file
// ci-dessus (dialog.showOpenDialog n'existe que côté process principal),
// la découpe elle-même (clip-exporter.js) vit dans le worker server.js.
ipcMain.handle('pick-source-video-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choisir l'enregistrement vidéo du culte",
    properties: ['openFile'],
    filters: [{ name: 'Vidéos', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('pick-clip-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier de destination des extraits',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

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
// NOTE (audit CPU, mise à jour lors de l'audit perf suivant) :
// app.disableHardwareAcceleration() a été retiré ici. L'intention d'origine
// ("l'app n'affiche que du texte/CSS, pas de rendu 3D") ne correspond pas à
// dashboard.html/overlay.html : backdrop-filter: blur()/saturate() (~21
// panneaux dans dashboard.html), un halo conic-gradient, un dégradé plein
// écran, le visualiseur audio en canvas/requestAnimationFrame, et un rendu
// de particules d'ambiance également en canvas (overlay.html). Sans
// accélération matérielle, Chromium doit calculer tout ça en logiciel
// (SwiftShader) sur le CPU à chaque frame — c'est la cause la plus probable
// des ralentissements/CPU élevé signalés, précisément à cause de ces effets
// de flou qui sont eux beaucoup plus coûteux sans GPU. Laisser Electron
// utiliser l'accélération matérielle par défaut.
// (La liste des 7 animations CSS en boucle infinie citée dans une version
// précédente de cette note — halo-spin/mote-rise/sacred-breathe/filigree-
// glow — ne reflétait déjà plus dashboard.html : ces effets avaient été
// retirés sur demande explicite. Seuls offlineAttention/pulse-ring/mic-pulse
// restent, et sont conditionnels à un état — pas des animations "toujours
// actives". Le raisonnement GPU ci-dessus reste valable pour les
// backdrop-filter et les rendus canvas, qui eux tournent en continu.)

// ---------------------------------------------------------------------------
// AJOUT (raccourcis clavier globaux — recommandation "hotkeys" façon OBS)
// ---------------------------------------------------------------------------
// Combinaisons à 4 modificateurs (Ctrl/Cmd+Alt+Shift+lettre) : quasiment
// jamais utilisées par d'autres logiciels, donc pas de réglage de
// remappage nécessaire pour un premier jet. Fonctionnent même quand
// ChurchOverlay n'a pas le focus (globalShortcut, contrairement à un
// raccourci lié à une fenêtre) — utile en plein culte, quand l'opérateur a
// autre chose au premier plan (OBS, une présentation...).
//
// Le déclenchement passe par worker.postMessage() (même canal que
// audio-pcm-chunk/theme-changed déjà utilisés ci-dessous), PAS par une
// connexion WebSocket depuis le process principal : server.js tourne déjà
// dans un Worker séparé et sait déjà router ce type de message (voir
// parentPort.on('message', ...) dans server.js).
const GLOBAL_HOTKEYS = [
  {
    accelerator: 'CommandOrControl+Alt+Shift+C',
    action: 'emergencyClear',
    label: 'Effacement d’urgence (masque tout immédiatement)',
  },
  {
    accelerator: 'CommandOrControl+Alt+Shift+H',
    action: 'hideVerse',
    label: 'Masquer le verset affiché',
  },
  {
    accelerator: 'CommandOrControl+Alt+Shift+M',
    action: 'hideMedia',
    label: 'Masquer la photo/vidéo affichée',
  },
  // AJOUT (studio de scènes — parité avec le raccourci média ci-dessus) :
  // une scène composée (fond + texte + logo) est une couche distincte du
  // média (#scene-layer vs #media-layer côté overlay.html) — sans ce
  // raccourci, la masquer sans quitter d'autres logiciels (OBS, une
  // présentation...) au premier plan n'était possible que via
  // emergencyClear (Ctrl+Alt+Shift+C), qui masque aussi le verset affiché.
  {
    accelerator: 'CommandOrControl+Alt+Shift+S',
    action: 'hideScene',
    label: 'Masquer la scène affichée',
  },
];

function registerGlobalHotkeys() {
  for (const { accelerator, action } of GLOBAL_HOTKEYS) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (!worker) return; // pipeline pas encore démarré : rien à déclencher
        worker.postMessage({ type: 'hotkey-action', action });
      });
      if (!ok) {
        console.warn(`[main] Raccourci "${accelerator}" déjà pris par une autre application.`);
      }
    } catch (e) {
      console.warn(`[main] Échec d'enregistrement du raccourci "${accelerator}":`, e.message);
    }
  }
}

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
  registerGlobalHotkeys();
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
  globalShortcut.unregisterAll();
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
