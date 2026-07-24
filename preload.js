/**
 * ============================================================================
 *  electron/preload.js — Pont sécurisé renderer <-> main
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.2.0
 *    + setCloudOnlyMode(enabled)   — dashboard toggle "Mode cloud uniquement"
 *    + setWhisperGpu(enabled)      — dashboard toggle "Accélération GPU"
 *    + getPerfStats()              — CPU % / RSS MB polling for dashboard
 *    + getSettings()               — read persisted flags on dashboard load
 *    + onPerfUpdate(cb)            — pushed CPU/RAM samples (2s interval)
 *
 *  contextIsolation étant activé (et nodeIntegration désactivé) dans main.js,
 *  les fenêtres (setup.html, dashboard.html) n'ont accès à rien de Node ni
 *  d'Electron par défaut. Ce script expose uniquement les quelques fonctions
 *  nécessaires sous window.churchOverlay, via contextBridge — donc aucune
 *  fenêtre ne peut exécuter du code arbitraire côté système.
 * ============================================================================
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('churchOverlay', {
  // --- Écran de configuration initiale (setup.html) -----------------------
  detectMicrophones: () => ipcRenderer.invoke('detect-microphones'),
  saveSetup: (audioDevice, groqApiKey, deepgramApiKey) =>
    ipcRenderer.invoke('save-setup', { audioDevice, groqApiKey, deepgramApiKey }),

  // --- Tableau de bord (dashboard.html) ------------------------------------
  getStatus: () => ipcRenderer.invoke('get-status'),
  requestRestart: () => ipcRenderer.invoke('request-restart'),
  openSetup: () => ipcRenderer.invoke('open-setup'),

  // --- v0.2.0 : réglages runtime exposés au dashboard ---------------------
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setCloudOnlyMode: (enabled) => ipcRenderer.invoke('set-cloud-only-mode', !!enabled),
  setWhisperGpu: (enabled) => ipcRenderer.invoke('set-whisper-gpu', !!enabled),
  getPerfStats: () => ipcRenderer.invoke('get-perf-stats'),

  // --- Mises à jour poussées depuis main.js (notifyDashboard) -------------
  onStatusUpdate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('status-update', listener);
    // Retourne une fonction de nettoyage, utile si la fenêtre recharge.
    return () => ipcRenderer.removeListener('status-update', listener);
  },

  // --- v0.2.0 : push CPU % / RSS MB toutes les 2s ------------------------
  onPerfUpdate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('perf-update', listener);
    return () => ipcRenderer.removeListener('perf-update', listener);
  },

  // --- Progression du téléchargement automatique de Whisper (setup.html) --
  onWhisperSetupProgress: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('whisper-setup-progress', listener);
    return () => ipcRenderer.removeListener('whisper-setup-progress', listener);
  },
});
