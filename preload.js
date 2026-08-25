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

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

  // AJOUT (carte réseau — "Réseau / caméra téléphone (QR)") : WS_HOST,
  // jusqu'ici uniquement modifiable en éditant .env à la main.
  saveNetworkSettings: (wsHost) => ipcRenderer.invoke('save-network-settings', { wsHost }),

  // AJOUT (bascule streaming Deepgram visible) : ASR_PROVIDER n'était
  // modifiable qu'en éditant une variable d'environnement cachée.
  setAsrProvider: (provider) => ipcRenderer.invoke('set-asr-provider', { provider }),

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
  obsToggleStreaming: () => ipcRenderer.invoke('obs-toggle-streaming'),

  // --- AJOUT (pont ProPresenter — recommandation "ProPresenter Remote/API") :
  // même structure que le bloc OBS ci-dessus. Entièrement optionnel — n'agit
  // que si activé (features.broadcast.propresenter.enabled).
  getProPresenterConfig: () => ipcRenderer.invoke('propresenter-get-config'),
  setProPresenterConfig: (cfg) => ipcRenderer.invoke('propresenter-set-config', cfg),
  proPresenterConnect: () => ipcRenderer.invoke('propresenter-connect'),
  proPresenterSendMessage: (text) => ipcRenderer.invoke('propresenter-send-message', { text }),

  // --- AJOUT (Planning Center Services — recommandation "sync ordre du culte") -
  // Lecture seule, même structure que les blocs ci-dessus.
  getPlanningCenterConfig: () => ipcRenderer.invoke('pco-get-config'),
  setPlanningCenterConfig: (cfg) => ipcRenderer.invoke('pco-set-config', cfg),
  fetchPlanningCenterPlan: () => ipcRenderer.invoke('pco-fetch-plan-items'),

  // --- AJOUT (audit — plusieurs façons d'afficher l'overlay, gratuit/léger) :
  // fenêtre plein écran indépendante d'OBS, sur l'écran choisi (voir
  // createDisplayWindow dans main.js). Pour les églises qui projettent
  // directement sans passer par un logiciel de diffusion.
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  // CORRECTIF (stage display / diaporama d'annonces) : `mode` optionnel
  // ('overlay' par défaut côté main.js) pour choisir la page chargée dans
  // la fenêtre plein écran — overlay.html / stage-display.html /
  // announcement-loop.html.
  openDisplayWindow: (displayId, mode) =>
    ipcRenderer.invoke('open-display-window', { displayId, mode }),
  closeDisplayWindow: (mode) => ipcRenderer.invoke('close-display-window', { mode }),

  // --- AJOUT (médiathèque — déclenchement vocal de photos/vidéos) ---------
  // Seul accès natif nécessaire : le sélecteur de fichier (dialog n'existe
  // que côté main.js). L'ajout/liste/suppression/déclenchement passent tous
  // par le WebSocket existant (voir server.js), pas par IPC — cohérent avec
  // le reste de l'app (main.js = accès OS, server.js = logique applicative).
  pickMediaFile: () => ipcRenderer.invoke('pick-media-file'),
  // AJOUT (chantier 4.6 — extraits vidéo) : mêmes raisons que pickMediaFile
  // ci-dessus (sélecteur de fichier natif, uniquement disponible côté main).
  pickSourceVideoFile: () => ipcRenderer.invoke('pick-source-video-file'),
  pickClipOutputDir: () => ipcRenderer.invoke('pick-clip-output-dir'),
  // AJOUT (Partie 7.1.1 — import PowerPoint) : mêmes raisons que pickMediaFile.
  pickPptxFile: () => ipcRenderer.invoke('pick-pptx-file'),
  // AJOUT (Partie 7.1.2 — export du service portable) : mêmes raisons.
  pickExportZipPath: () => ipcRenderer.invoke('pick-export-zip-path'),
  pickImportZipPath: () => ipcRenderer.invoke('pick-import-zip-path'),
  // AJOUT (glisser-déposer médiathèque) : File.path a été retiré d'Electron
  // (depuis la v32) pour raisons de sécurité — webUtils.getPathForFile() est
  // son remplacement officiel, disponible uniquement dans le script de
  // préchargement (pas d'IPC nécessaire ici, contrairement à pickMediaFile
  // ci-dessus qui doit, lui, ouvrir une vraie fenêtre de dialogue côté
  // process principal). Permet de réutiliser EXACTEMENT le même chemin
  // serveur (mediaLibrary.addItem(), voir media-library.js) que le
  // sélecteur natif, sans dupliquer la logique de copie de fichier.
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
