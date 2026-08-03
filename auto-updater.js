/**
 * ============================================================================
 * auto-updater.js — Automatic Update System for ChurchOverlay
 * ============================================================================
 * Checks for updates on startup and installs them silently.
 *
 * Uses electron-updater with GitHub Releases as the update source.
 *
 * Setup required:
 *   1. Set up GitHub Releases with .exe and latest.yml
 *   2. Add GH_TOKEN to build environment
 *   3. Publish with: npm run dist -- --publish always
 *
 * Integration: Require in main.js, call initAutoUpdater() after app ready.
 * ============================================================================
 */

'use strict';

const { autoUpdater } = require('electron-updater');
const { dialog, BrowserWindow } = require('electron');
const path = require('path');

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------
const CONFIG = {
  // Check interval (ms) — 0 = only on startup
  CHECK_INTERVAL: 0,
  // Allow pre-release updates?
  ALLOW_PRERELEASE: false,
  // Silent mode: install without asking (recommended for church computers)
  SILENT_INSTALL: false,
  // Show notification on update available?
  SHOW_NOTIFICATION: true,
  // Update server URL (defaults to GitHub Releases from package.json)
  // UPDATE_URL: 'https://your-update-server.com',
};

let updateWindow = null;
let mainWindow = null;

// -----------------------------------------------------------------------
// Initialize auto-updater
// -----------------------------------------------------------------------
function initAutoUpdater(mainWin, options = {}) {
  mainWindow = mainWin;
  const config = { ...CONFIG, ...options };

  // Configure auto-updater
  autoUpdater.autoDownload = config.SILENT_INSTALL;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = config.ALLOW_PRERELEASE;

  if (config.UPDATE_URL) {
    autoUpdater.setFeedURL(config.UPDATE_URL);
  }

  // --- Event Handlers ---

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
    sendToWindow('update-checking');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] Update available:', info.version);
    sendToWindow('update-available', info);

    if (config.SHOW_NOTIFICATION) {
      showUpdateNotification(info);
    }

    if (config.SILENT_INSTALL) {
      console.log('[updater] Downloading update silently...');
      autoUpdater.downloadUpdate();
    } else {
      showUpdateDialog(info);
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] No updates available. Current:', info.version);
    sendToWindow('update-not-available', info);
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
    sendToWindow('update-error', { message: err.message });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    console.log(`[updater] Download progress: ${percent}%`);
    sendToWindow('update-progress', { percent, speed: progress.bytesPerSecond });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] Update downloaded:', info.version);
    sendToWindow('update-downloaded', info);

    if (config.SILENT_INSTALL) {
      // Install on next quit
      console.log('[updater] Will install on next app quit');
    } else {
      showInstallDialog(info);
    }
  });

  // Check on startup
  checkForUpdates();

  // Periodic checks
  if (config.CHECK_INTERVAL > 0) {
    setInterval(checkForUpdates, config.CHECK_INTERVAL);
  }
}

// -----------------------------------------------------------------------
// Check for updates
// -----------------------------------------------------------------------
function checkForUpdates() {
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('[updater] Failed to check for updates:', err.message);
  }
}

// -----------------------------------------------------------------------
// Manual update check (for menu item)
// -----------------------------------------------------------------------
function checkForUpdatesManual() {
  checkForUpdates();
}

// -----------------------------------------------------------------------
// Download update manually
// -----------------------------------------------------------------------
function downloadUpdate() {
  autoUpdater.downloadUpdate();
}

// -----------------------------------------------------------------------
// Install update now
// -----------------------------------------------------------------------
function installUpdateNow() {
  autoUpdater.quitAndInstall(true, true);
}

// -----------------------------------------------------------------------
// UI Helpers
// -----------------------------------------------------------------------
function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-' + channel, data);
  }
}

function showUpdateNotification(info) {
  // Send to renderer for in-app notification
  sendToWindow('update-available', {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes,
  });
}

function showUpdateDialog(info) {
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: 'Mise à jour disponible',
    message: `ChurchOverlay ${info.version} est disponible`,
    detail: `Version actuelle: ${autoUpdater.currentVersion}\n\nNouveautés:\n${info.releaseNotes || 'Corrections et améliorations'}`,
    buttons: ['Télécharger maintenant', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result === 0) {
    autoUpdater.downloadUpdate();
  }
}

function showInstallDialog(info) {
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: 'Mise à jour prête',
    message: `ChurchOverlay ${info.version} est téléchargée`,
    detail: "L'application doit redémarrer pour installer la mise à jour.",
    buttons: ['Redémarrer maintenant', 'Redémarrer plus tard'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result === 0) {
    autoUpdater.quitAndInstall(true, true);
  }
}

// -----------------------------------------------------------------------
// Get current version info
// -----------------------------------------------------------------------
function getVersionInfo() {
  return {
    current: autoUpdater.currentVersion,
    updateAvailable: false, // Set by event handler
  };
}

module.exports = {
  initAutoUpdater,
  checkForUpdatesManual,
  downloadUpdate,
  installUpdateNow,
  getVersionInfo,
};
