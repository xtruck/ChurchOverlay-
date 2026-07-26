/**
 * ============================================================================
 *  electron/preload.js — Pont sécurisé renderer <-> main
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.5.0 — Remplacement de FFmpeg par la capture audio native
 *    - ensureFfmpeg / onFfmpegStartupProgress / onFfmpegSetupProgress
 *      supprimés : plus de binaire externe à télécharger, la capture micro
 *      passe par une fenêtre Electron cachée (getUserMedia), voir
 *      audio-capture.js et capture.html pour le détail.
 *
 *  CHANGELOG v0.3.0 — Suppression complète de Whisper local
 *    - setCloudOnlyMode / setWhisperGpu supprimés (plus de toggle : la
 *      transcription est désormais toujours 100% cloud, Groq -> Deepgram).
 *    - onWhisperSetupProgress renommé onFfmpegSetupProgress (seul FFmpeg
 *      est encore téléchargé automatiquement au premier lancement).
 *
 *  CHANGELOG v0.2.0
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
  // CHANGELOG v0.5.0 : ensureFfmpeg() retiré — plus de binaire externe à
  // installer avant de pouvoir scanner les micros (capture native
  // navigateur, prête dès le chargement de la fenêtre de capture cachée).
  detectMicrophones: (force) => ipcRenderer.invoke('detect-microphones', { force: !!force }),
  saveSetup: (audioDevice, groqApiKey, deepgramApiKey) =>
    ipcRenderer.invoke('save-setup', { audioDevice, groqApiKey, deepgramApiKey }),

  // --- Tableau de bord (dashboard.html) ------------------------------------
  getStatus: () => ipcRenderer.invoke('get-status'),
  requestRestart: () => ipcRenderer.invoke('request-restart'),
  openSetup: () => ipcRenderer.invoke('open-setup'),

  // --- v0.2.0 : réglages runtime exposés au dashboard ---------------------
  getSettings: () => ipcRenderer.invoke('get-settings'),
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

  // --- Alertes pipeline visibles (dashboard.html) --------------------------
  // { code, severity: 'error'|'warning', message, timestamp } ou
  // { clear: true } pour effacer la bannière (ex: après un redémarrage OK).
  onPipelineAlert: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('pipeline-alert', listener);
    return () => ipcRenderer.removeListener('pipeline-alert', listener);
  },

  // --- Thèmes de l'overlay (theme-loader.js) -------------------------------
  // Ajouté à l'audit : theme-loader.js existait déjà et était entièrement
  // testé, mais n'était branché à aucune fenêtre — impossible de changer de
  // thème depuis l'app. Le changement est appliqué en direct sur
  // overlay.html (voir server.js) sans avoir à redémarrer le pipeline.
  listThemes: () => ipcRenderer.invoke('list-themes'),
  getActiveTheme: () => ipcRenderer.invoke('get-active-theme'),
  setActiveTheme: (themeId) => ipcRenderer.invoke('set-active-theme', { themeId }),

  // --- Contrôle OBS multi-scènes (obs-controller.js) -----------------------
  // Ajouté à l'audit, même constat que pour les thèmes : module prêt et
  // testable, jamais exposé. Entièrement optionnel — n'agit que si activé.
  getObsConfig: () => ipcRenderer.invoke('obs-get-config'),
  setObsConfig: (cfg) => ipcRenderer.invoke('obs-set-config', cfg),
  obsConnect: () => ipcRenderer.invoke('obs-connect'),
  obsListScenes: () => ipcRenderer.invoke('obs-list-scenes'),
  obsSwitchScene: (sceneName) => ipcRenderer.invoke('obs-switch-scene', { sceneName }),
  obsToggleRecording: () => ipcRenderer.invoke('obs-toggle-recording'),
});
