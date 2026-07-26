'use strict';
/**
 * obs-controller.js — Contrôle multi-scènes OBS via obs-websocket
 *
 * ENTIÈREMENT OPTIONNEL. Si features.broadcast.multiScene.enabled = false,
 * ce module ne se charge même pas. L'app tourne exactement comme avant.
 *
 * Prérequis côté OBS Studio :
 *   Outils → obs-websocket → Activer serveur WebSocket
 *   (déjà intégré depuis OBS 28+)
 */

const { safeStorage } = require('electron');
const features = require('./config/features.json');

let obsClient = null;

// CORRECTIF (audit round 4) — le mot de passe OBS est désormais chiffré par
// main.js (safeStorage) avant d'être écrit dans config/features.json (voir
// obs-set-config dans main.js). On le déchiffre ici avant de s'en servir ;
// `cfg.password` en clair reste lu en repli uniquement pour une config
// existante pas encore migrée (safeStorage indisponible au moment de la
// sauvegarde) ou écrite avant ce correctif.
function resolvePassword(cfg) {
  if (cfg.passwordEncrypted) {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('[obs] Chiffrement système indisponible : impossible de lire le mot de passe OBS.');
      return '';
    }
    try {
      return safeStorage.decryptString(Buffer.from(cfg.passwordEncrypted, 'base64'));
    } catch (e) {
      console.error('[obs] Échec du déchiffrement du mot de passe OBS:', e.message);
      return '';
    }
  }
  return cfg.password || '';
}

async function connect() {
  if (!features.broadcast.multiScene.enabled) return null;

  // Import dynamique — n'installe la dépendance que si feature activée
  const { OBSWebSocket } = await import('obs-websocket-js');
  obsClient = new OBSWebSocket();

  const cfg = features.broadcast.multiScene;
  try {
    await obsClient.connect(cfg.obsWebsocketUrl, resolvePassword(cfg));
    console.log('[obs] Connecté à OBS Studio');
    return obsClient;
  } catch (e) {
    console.warn('[obs] Impossible de se connecter — vérifiez qu\'OBS tourne :', e.message);
    return null;
  }
}

/** Bascule vers une scène OBS par son nom. */
async function switchScene(sceneName) {
  if (!obsClient) return { ok: false, reason: 'OBS non connecté' };
  try {
    await obsClient.call('SetCurrentProgramScene', { sceneName });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Liste toutes les scènes disponibles dans OBS. */
async function listScenes() {
  if (!obsClient) return [];
  const res = await obsClient.call('GetSceneList');
  return res.scenes.map(s => s.sceneName);
}

/** Démarre/arrête l'enregistrement du sermon. */
async function toggleRecording() {
  if (!obsClient) return { ok: false };
  const status = await obsClient.call('GetRecordStatus');
  if (status.outputActive) {
    await obsClient.call('StopRecord');
    return { ok: true, recording: false };
  } else {
    await obsClient.call('StartRecord');
    return { ok: true, recording: true };
  }
}

module.exports = { connect, switchScene, listScenes, toggleRecording };
