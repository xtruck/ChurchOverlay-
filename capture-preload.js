/**
 * ============================================================================
 *  capture-preload.js — Pont sécurisé pour la fenêtre de capture cachée
 * ----------------------------------------------------------------------------
 *  Utilisé UNIQUEMENT par capture.html, chargé dans la BrowserWindow cachée
 *  créée par createCaptureWindow() dans main.js (contextIsolation: true,
 *  nodeIntegration: false — capture.html n'a donc accès à rien de Node/
 *  Electron sans passer par ce pont).
 *
 *  Canaux IPC (doivent rester synchronisés avec main.js) :
 *    main -> renderer :
 *      'capture:start'         { deviceId }  — démarrer la capture
 *      'capture:stop'          —              arrêter la capture
 *      'capture:list-devices'  —              demande la liste des micros
 *    renderer -> main :
 *      'capture:devices-result' [{deviceId,label}, ...] — réponse à list-devices
 *      'capture:audio-chunk'   ArrayBuffer    — un bloc PCM16 mono 16kHz
 *      'capture:error'         { message }    — erreur de capture (micro
 *                                                refusé, périphérique perdu...)
 * ============================================================================
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureBridge', {
  // --- Reçu depuis main.js -------------------------------------------------
  onStart: (callback) => {
    const listener = (_evt, payload) => callback(payload || {});
    ipcRenderer.on('capture:start', listener);
    return () => ipcRenderer.removeListener('capture:start', listener);
  },
  onStop: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('capture:stop', listener);
    return () => ipcRenderer.removeListener('capture:stop', listener);
  },
  onListDevices: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('capture:list-devices', listener);
    return () => ipcRenderer.removeListener('capture:list-devices', listener);
  },

  // --- Envoyé vers main.js --------------------------------------------------
  sendDevicesResult: (devices) => ipcRenderer.send('capture:devices-result', devices || []),

  // Un ArrayBuffer transite par IPC via structured clone (une copie) — un
  // chunk PCM16 mono de quelques Ko toutes les ~90ms reste minime, voir la
  // note dans main.js (ipcMain.on('capture:audio-chunk', ...)).
  sendAudioChunk: (arrayBuffer) => ipcRenderer.send('capture:audio-chunk', arrayBuffer),

  sendError: (message) => ipcRenderer.send('capture:error', { message: String(message || 'Erreur inconnue') }),
});
