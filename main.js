/**
 * ============================================================================
 *  electron/main.js — Coquille application pour ChurchOverlay
 * ----------------------------------------------------------------------------
 *  Rôle :
 *    - Fournir une icône d'application (barre des tâches + system tray)
 *    - Au premier lancement : demander le micro + la clé Groq via une petite
 *      fenêtre graphique (aucun PowerShell, aucun .env à éditer à la main)
 *    - Ensuite : démarrer automatiquement server.js (le pipeline complet
 *      micro → Whisper/Groq → detector → overlay) en processus enfant
 *    - Fenêtre principale = tableau de bord (statut serveur, URL overlay à
 *      coller dans OBS, bouton "changer de micro")
 * ============================================================================
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ensureWhisperInstalled } = require('./setup-whisper');
const { ensureFfmpegInstalled, resolveFfmpegPath } = require('./setup-ffmpeg');

// main.js vit à la racine du projet (à côté de server.js, overlay.html, etc.),
// donc APP_ROOT = __dirname. Un ancien `path.join(__dirname, '..')` pointait
// hors du dossier de l'app : server.js n'y était jamais trouvé (spawn ENOENT)
// et l'URL overlay générée pour OBS était fausse.
const APP_ROOT = __dirname;
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverStatus = 'starting'; // starting | running | error | stopped

// ---------------------------------------------------------------------------
// Configuration locale (remplace le .env manuel — jamais de secret en dur)
// ----------------------------------------------------------------------------
// CORRECTIF SÉCURITÉ : la clé Groq était écrite en clair dans config.json.
// Elle est désormais chiffrée via safeStorage d'Electron (DPAPI sur Windows,
// Keychain sur macOS, libsecret sur Linux) avant écriture sur disque. Le
// champ stocké devient groqApiKeyEncrypted (base64) ; groqApiKey n'est
// jamais persisté en clair. Migration automatique des anciennes configs.
// ---------------------------------------------------------------------------
// CORRECTIF (Deepgram) : même principe que la clé Groq ci-dessus — la clé
// Deepgram (optionnelle, 2e fournisseur cloud) est chiffrée via safeStorage
// avant écriture sur disque. deepgramApiKey n'est jamais persisté en clair,
// et son absence n'empêche pas l'app de démarrer (Groq seul suffit).
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
  let config;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[main] Config illisible, réinitialisation:', e.message);
    return null;
  }
  if (!config) return null;

  // Migration ancienne config (clé Groq stockée en clair, pré-chiffrement)
  if (config.groqApiKey && !config.groqApiKeyEncrypted) {
    console.log('[main] Migration de la clé Groq vers le stockage chiffré...');
    const plainKey = config.groqApiKey;
    saveConfig({
      audioDevice: config.audioDevice,
      groqApiKey: plainKey,
      deepgramApiKey: decryptKey(config.deepgramApiKeyEncrypted, 'Deepgram'),
    });
    return { audioDevice: config.audioDevice, groqApiKey: plainKey, deepgramApiKey: null };
  }

  const groqApiKey = config.groqApiKeyEncrypted
    ? decryptKey(config.groqApiKeyEncrypted, 'Groq')
    : (config.groqApiKey || null);
  const deepgramApiKey = decryptKey(config.deepgramApiKeyEncrypted, 'Deepgram');

  return { audioDevice: config.audioDevice, groqApiKey, deepgramApiKey };
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

  const toWrite = { audioDevice: config.audioDevice };
  if (config.groqApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      toWrite.groqApiKeyEncrypted = safeStorage.encryptString(config.groqApiKey).toString('base64');
    } else {
      console.warn('[main] Chiffrement système indisponible : clé Groq stockée en clair.');
      toWrite.groqApiKey = config.groqApiKey;
    }
  }
  // Deepgram est optionnel : on ne stocke rien si le champ est vide, pour
  // que isConfigured() côté deepgram-wrapper.js reste "non configuré".
  if (config.deepgramApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      toWrite.deepgramApiKeyEncrypted = safeStorage.encryptString(config.deepgramApiKey).toString('base64');
    } else {
      console.warn('[main] Chiffrement système indisponible : clé Deepgram stockée en clair.');
      toWrite.deepgramApiKey = config.deepgramApiKey;
    }
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), 'utf8');
}

function isFirstRunNeeded() {
  const config = loadConfig();
  return !config || !config.audioDevice || !config.groqApiKey;
}

// ---------------------------------------------------------------------------
// Détection automatique des micros (réutilise la logique de list-audio-devices.js)
// ---------------------------------------------------------------------------
function detectAudioDevices() {
  return new Promise((resolve) => {
    const ffmpegPath = resolveFfmpegPath();
    let settled = false;
    const finish = (devices) => {
      if (settled) return;
      settled = true;
      resolve(devices);
    };

    let ff;
    try {
      ff = spawn(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    } catch (e) {
      finish([]);
      return;
    }

    let output = '';
    ff.stderr.on('data', (d) => { output += d.toString(); });
    ff.on('close', () => {
      const lines = output.split(/\r?\n/);
      const devices = [];
      lines.forEach((line) => {
        const match = line.match(/"([^"]+)"\s*\(audio\)/);
        if (match) devices.push(match[1]);
      });
      finish(devices);
    });
    ff.on('error', () => finish([]));
    setTimeout(() => { try { ff.kill(); } catch (_) {} finish([]); }, 6000);
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
    width: 480,
    height: 420,
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
    // Réduit dans le tray au lieu de fermer, pour ne pas couper le pipeline
    // en pleine réunion si l'utilisateur clique sur la croix par réflexe.
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
    { label: 'Ouvrir ChurchOverlay', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Redémarrer le pipeline', click: () => restartServer() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Gestion du pipeline (server.js) — remplace start-server.bat
// ---------------------------------------------------------------------------
function startServer() {
  const config = loadConfig();
  if (!config) return;

  const env = Object.assign({}, process.env, {
    AUDIO_DEVICE: config.audioDevice,
    GROQ_API_KEY: config.groqApiKey,
    NODE_ENV: 'production',
    // CORRECTIF : server.js et audio-capture.js lisent FFMPEG_PATH depuis
    // leur propre process.env, qui n'a jamais connu du binaire installé par
    // ensureFfmpegInstalled() dans ffmpeg/ — seul main.js (via
    // resolveFfmpegPath()) sait où il se trouve. Sans cette ligne, le
    // process enfant retombait sur 'ffmpeg' nu et échouait (ENOENT) sur un
    // poste sans FFmpeg dans le PATH système.
    FFMPEG_PATH: resolveFfmpegPath(),
  });
  // Deepgram est optionnel : on ne définit la variable que si une clé est
  // configurée, pour que deepgram.isConfigured() reste false sinon (course
  // à 2 niveaux Groq → local, comme avant l'ajout de Deepgram).
  if (config.deepgramApiKey) {
    env.DEEPGRAM_API_KEY = config.deepgramApiKey;
  }

  serverStatus = 'starting';
  refreshTrayMenu();
  notifyDashboard();

  serverProcess = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    cwd: APP_ROOT,
    env,
    windowsHide: true, // pas de console noire qui s'affiche
    // CORRECTIF AUDIT : canal IPC ajouté ('ipc' en 4e position) pour pouvoir
    // demander un arrêt gracieux via .send() plutôt que .kill(). Sous
    // Windows, .kill() ne délivre pas un vrai signal : le process est tué
    // brutalement (TerminateProcess), donc le handler SIGTERM de server.js
    // ne s'exécute JAMAIS et whisper-server.exe / FFmpeg restent orphelins
    // en tâche de fond. Voir stopServerGracefully() ci-dessous.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString();
    if (text.includes('Serveur WebSocket démarré')) {
      serverStatus = 'running';
      refreshTrayMenu();
      notifyDashboard();
    }
    appendLog(text);
  });

  serverProcess.stderr.on('data', (data) => appendLog(data.toString(), true));

  serverProcess.on('exit', (code) => {
    serverStatus = code === 0 ? 'stopped' : 'error';
    refreshTrayMenu();
    notifyDashboard();
  });
}

/**
 * Demande à server.js de s'arrêter proprement (arrêt de whisper-server.exe
 * et de FFmpeg inclus) via le canal IPC, avec un repli sur .kill() forcé si
 * le process ne s'arrête pas de lui-même sous 5 secondes (crash, blocage).
 *
 * CORRECTIF AUDIT : avant ce changement, restartServer() et before-quit
 * appelaient directement serverProcess.kill(). Sous Windows, cela termine
 * le process server.js sans lui laisser la moindre chance d'exécuter son
 * handler SIGTERM/SIGINT — qui est le seul endroit où whisper-server.exe et
 * FFmpeg sont arrêtés. Résultat en production : à chaque redémarrage du
 * pipeline ou fermeture de l'appli, whisper-server.exe restait en tâche de
 * fond, gardait le port 8080 occupé, et le whisper-server.exe suivant ne
 * pouvait plus démarrer dessus (ou un nouveau processus s'accumulait à
 * chaque fois, orphelin, jusqu'au redémarrage de la machine).
 *
 * @param {import('child_process').ChildProcess|null} proc
 * @param {() => void} onDone - appelé une fois le process terminé (propre ou forcé)
 */
function stopServerGracefully(proc, onDone) {
  if (!proc) {
    onDone();
    return;
  }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };

  proc.once('exit', finish);

  try {
    proc.send({ type: 'shutdown' });
  } catch (e) {
    // Canal IPC indisponible (process déjà mort, ou pas encore prêt à
    // recevoir des messages) : on retombe sur l'arrêt forcé direct.
    console.warn('[main] Impossible d\'envoyer le message d\'arrêt IPC, arrêt forcé:', e.message);
    try { proc.kill(); } catch (e2) {}
    return;
  }

  // Filet de sécurité : si server.js ne s'est pas arrêté de lui-même
  // (crash, blocage dans le nettoyage), on force après 5 secondes plutôt
  // que de laisser le pipeline bloqué indéfiniment.
  setTimeout(() => {
    if (!done) {
      console.warn('[main] Arrêt gracieux du pipeline expiré (5s) — arrêt forcé. whisper-server.exe/FFmpeg risquent de rester orphelins.');
      try { proc.kill(); } catch (e) {}
    }
  }, 5000);
}

function restartServer() {
  const oldProcess = serverProcess;
  serverProcess = null;
  if (oldProcess) {
    oldProcess.removeAllListeners('exit');
  }
  stopServerGracefully(oldProcess, () => setTimeout(startServer, 500));
}

let recentLogs = [];
function appendLog(text, isError) {
  recentLogs.push({ text, isError: !!isError, ts: Date.now() });
  if (recentLogs.length > 200) recentLogs.shift();
  notifyDashboard();
}

function notifyDashboard() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', {
      status: serverStatus,
      logs: recentLogs.slice(-30),
      overlayUrl: 'file:///' + path.join(APP_ROOT, 'overlay.html').replace(/\\/g, '/'),
    });
  }
}

// ---------------------------------------------------------------------------
// IPC (communication avec les fenêtres de config / dashboard)
// ---------------------------------------------------------------------------
ipcMain.handle('detect-microphones', async () => detectAudioDevices());

ipcMain.handle('save-setup', async (_evt, { audioDevice, groqApiKey, deepgramApiKey }) => {
  saveConfig({ audioDevice, groqApiKey, deepgramApiKey });

  // CORRECTIF AUDIT : avant ce changement, rien ne lançait jamais
  // setup-whisper.js pour l'app packagée (Electron) — seul `npm run
  // setup-whisper` en ligne de commande l'exécutait. Résultat : sur le poste
  // d'un volontaire non-technique, whisper-server.exe et le modèle
  // n'étaient jamais téléchargés, donc le fallback local (censé garantir
  // que l'overlay n'est jamais vide si Groq/internet tombe pendant un
  // culte) était silencieusement indisponible. On le fait maintenant ici,
  // avec la fenêtre de setup encore ouverte pour montrer la progression.
  const sender = _evt.sender;

  // Même raisonnement que pour Whisper ci-dessous : sans cet appel, un poste
  // non-technique n'a jamais ffmpeg.exe installé automatiquement, et
  // detectAudioDevices()/server.js échouent silencieusement (spawn ENOENT)
  // tant que personne n'exécute `npm run setup-ffmpeg` à la main.
  try {
    await ensureFfmpegInstalled({
      onProgress: (msg) => {
        if (!sender.isDestroyed()) {
          sender.send('whisper-setup-progress', { done: false, message: msg });
        }
      },
    });
  } catch (err) {
    console.error('[main] Échec du téléchargement automatique de FFmpeg:', err.message);
    // Non bloquant, comme pour Whisper : si un FFmpeg système existe déjà
    // dans le PATH, resolveFfmpegPath() y retombera au démarrage du
    // pipeline. On informe simplement que l'installation auto a échoué.
    if (!sender.isDestroyed()) {
      sender.send('whisper-setup-progress', {
        done: false,
        ok: false,
        message: 'Échec du téléchargement automatique de FFmpeg (' + err.message + '). ' +
          'ChurchOverlay tentera d\'utiliser un FFmpeg déjà présent dans le PATH système.',
      });
    }
  }

  try {
    await ensureWhisperInstalled({
      onProgress: (msg) => {
        if (!sender.isDestroyed()) {
          sender.send('whisper-setup-progress', { done: false, message: msg });
        }
      },
    });
    if (!sender.isDestroyed()) {
      sender.send('whisper-setup-progress', { done: true, ok: true, message: 'Whisper local prêt.' });
    }
  } catch (err) {
    console.error('[main] Échec du téléchargement automatique de Whisper:', err.message);
    // On ne bloque pas le démarrage : Groq (cloud) peut suffire tant que la
    // connexion internet est disponible pendant le culte. L'utilisateur
    // pourra relancer `npm run setup-whisper` plus tard pour le fallback
    // local, ou réessayer depuis le tableau de bord.
    if (!sender.isDestroyed()) {
      sender.send('whisper-setup-progress', {
        done: true,
        ok: false,
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
  const win = createSetupWindow();
  return true;
});

// ---------------------------------------------------------------------------
// Cycle de vie de l'application
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  createTray();

  if (isFirstRunNeeded()) {
    const setupWin = createSetupWindow();
    setupWin.on('closed', () => {
      if (isFirstRunNeeded()) {
        // L'utilisateur a fermé sans configurer : on quitte proprement
        app.quit();
        return;
      }
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
  if (serverProcess && !isShuttingDown) {
    isShuttingDown = true;
    // On retarde la fermeture réelle de l'app le temps de laisser
    // server.js arrêter proprement whisper-server.exe et FFmpeg (même
    // logique que restartServer(), voir stopServerGracefully()).
    event.preventDefault();
    const proc = serverProcess;
    serverProcess = null;
    stopServerGracefully(proc, () => app.exit(0));
  }
});
