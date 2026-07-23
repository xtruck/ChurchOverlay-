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

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[main] Config illisible, réinitialisation:', e.message);
  }
  return null;
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
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
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
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
  });

  serverStatus = 'starting';
  refreshTrayMenu();
  notifyDashboard();

  serverProcess = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    cwd: APP_ROOT,
    env,
    windowsHide: true, // pas de console noire qui s'affiche
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

function restartServer() {
  if (serverProcess) {
    serverProcess.removeAllListeners('exit');
    serverProcess.kill();
  }
  setTimeout(startServer, 500);
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

ipcMain.handle('save-setup', async (_evt, { audioDevice, groqApiKey }) => {
  saveConfig({ audioDevice, groqApiKey });
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

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) {
    serverProcess.kill();
  }
});
