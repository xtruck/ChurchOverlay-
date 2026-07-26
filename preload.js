/**
 * ============================================================================
 *  electron/preload.js — Pont sécurisé renderer <-> main
 * ----------------------------------------------------------------------------
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
  // CORRECTIF (audit) : installe FFmpeg automatiquement dès l'ouverture de
  // l'assistant, AVANT le premier scan de micros (voir main.js/runEnsureFfmpeg)
  // — sur un poste sans FFmpeg système, l'ancien flux bloquait le bouton
  // "Enregistrer" indéfiniment car FFmpeg n'était installé qu'après lui.
  ensureFfmpeg: () => ipcRenderer.invoke('ensure-ffmpeg'),
  // CORRECTIF : le paramètre force n'était jamais transmis, donc le bouton
  // "Actualiser" de l'assistant de configuration relisait toujours le cache
  // disque (jusqu'à 24h) au lieu de relancer un vrai scan FFmpeg.
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

  // --- Progression de l'installation automatique de FFmpeg au chargement --
  // (avant le premier scan de micros — voir ensureFfmpeg ci-dessus). Canal
  // distinct de onFfmpegSetupProgress pour ne pas déclencher la fermeture
  // automatique de la fenêtre prévue après un save-setup réussi.
  onFfmpegStartupProgress: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('ffmpeg-startup-progress', listener);
    return () => ipcRenderer.removeListener('ffmpeg-startup-progress', listener);
  },

  // --- Progression du téléchargement automatique de FFmpeg (setup.html) --
  onFfmpegSetupProgress: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('ffmpeg-setup-progress', listener);
    return () => ipcRenderer.removeListener('ffmpeg-setup-progress', listener);
  },

  // --- CORRECTIF (audit) : alertes pipeline visibles (dashboard.html) -----
  // { code, severity: 'error'|'warning', message, timestamp } ou
  // { clear: true } pour effacer la bannière (ex: après un redémarrage OK).
  onPipelineAlert: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('pipeline-alert', listener);
    return () => ipcRenderer.removeListener('pipeline-alert', listener);
  },
});
