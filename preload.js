/**
 * ============================================================================
 *  electron/preload.js — Pont sécurisé renderer <-> main
 * ----------------------------------------------------------------------------
 *  CORRECTIF (audit) — pont audio manquant
 *    dashboard.html appelait déjà window.churchOverlay.sendAudioChunk() et
 *    .onAudioPipelineReady(), mais rien ici ne les exposait : la capture
 *    micro native (déjà câblée côté main.js/server.js/audio-capture.js)
 *    était donc muette en silence (TypeError avalée par onaudioprocess).
 *    Ajoutés ci-dessous. detectMicrophones() retiré : mort depuis que
 *    setup.html énumère lui-même via navigator.mediaDevices.
 *
 *  CHANGELOG v0.5.0 — Remplacement de FFmpeg par la capture audio native
 *    - ensureFfmpeg / onFfmpegStartupProgress / onFfmpegSetupProgress
 *      supprimés : plus de binaire externe à télécharger, la capture micro
 *      passe directement par dashboard.html/setup.html (getUserMedia).
 *
 *  CHANGELOG v0.3.0 — Suppression complète de Whisper local
 *    - setCloudOnlyMode / setWhisperGpu supprimés (plus de toggle : la
 *      transcription est désormais toujours 100% cloud, Groq -> Deepgram).
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
  // CHANGELOG v0.5.0 : ensureFfmpeg()/detectMicrophones() retirés — plus de
  // binaire externe, et plus de scan IPC des micros : setup.html énumère
  // directement via navigator.mediaDevices.enumerateDevices() (le même accès
  // micro que dashboard.html utilise pour la capture réelle), donc pas besoin
  // de faire l'aller-retour par le process principal.
  saveSetup: (audioDevice, groqApiKey, deepgramApiKey) =>
    ipcRenderer.invoke('save-setup', { audioDevice, groqApiKey, deepgramApiKey }),

  // Retrait explicite d'une clé (bouton dédié) — distinct d'un champ vide
  // lors d'un saveSetup(), qui préserve désormais la clé déjà enregistrée.
  clearApiKey: (provider) => ipcRenderer.invoke('clear-api-key', { provider }),

  // --- Tableau de bord (dashboard.html) ------------------------------------
  getStatus: () => ipcRenderer.invoke('get-status'),
  requestRestart: () => ipcRenderer.invoke('request-restart'),
  openSetup: () => ipcRenderer.invoke('open-setup'),

  // --- v0.2.0 : réglages runtime exposés au dashboard ---------------------
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getPerfStats: () => ipcRenderer.invoke('get-perf-stats'),

  // --- CORRECTIF (audit) — capture micro native ---------------------------
  // dashboard.html capture le micro lui-même (getUserMedia) et pousse ses
  // chunks PCM16LE ici. main.js les relaie tels quels au Worker server.js
  // via ipcMain.on('audio-pcm-chunk', ...) — ce canal existait déjà côté
  // main.js, mais rien ne l'exposait ici : dashboard.html appelait
  // window.churchOverlay.sendAudioChunk() qui n'existait pas (TypeError dès
  // le premier chunk), et la capture ne démarrait jamais. Corrigé.
  sendAudioChunk: (buffer) => ipcRenderer.send('audio-pcm-chunk', buffer),
  // Signal envoyé par main.js quand le Worker (server.js) a confirmé que le
  // pipeline audio est prêt à recevoir des chunks (voir audio-pipeline-ready
  // dans server.js/main.js) — démarrer la capture avant perdrait les tout
  // premiers instants sans que rien ne les traite.
  onAudioPipelineReady: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('audio-pipeline-ready', listener);
    return () => ipcRenderer.removeListener('audio-pipeline-ready', listener);
  },

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
