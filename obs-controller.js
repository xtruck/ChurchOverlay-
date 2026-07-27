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
 *
 * -----------------------------------------------------------------------
 * AJOUT (audit — inspiré du protocole obs-websocket documenté dans
 * obsproject/obs-websocket, submodule d'obsproject/obs-studio).
 * -----------------------------------------------------------------------
 * Avant cet ajout, ce module était STRICTEMENT unidirectionnel : il
 * envoyait des commandes à OBS (changer de scène, démarrer/arrêter
 * l'enregistrement) mais ne s'abonnait JAMAIS à aucun événement OBS.
 *
 * Le protocole obs-websocket expose pourtant des événements exploitables
 * pour économiser des ressources réelles pendant un culte :
 *   - CurrentProgramSceneChanged : la scène affichée en direct a changé
 *     (ex: passage à une scène "Louange" musique seule, ou "Pause").
 *   - StreamStateChanged / RecordStateChanged : le stream ou
 *     l'enregistrement a démarré/s'est arrêté.
 *
 * Le "gating" ajouté ici (setupGating / evaluateGate) permet de mettre en
 * pause la transcription (donc les appels payants à Groq/Deepgram) quand
 * OBS indique que ce n'est pas utile : scène hors liste "en direct"
 * configurée, ou aucun stream/enregistrement actif. C'est un filet de
 * sécurité optionnel, désactivé par défaut (features.broadcast.multiScene.
 * gating.enabled = false) — sans configuration explicite, le comportement
 * de l'app ne change pas.
 *
 * Ce module reste néanmoins agnostique de la manière dont la pause est
 * effectivement appliquée : voir main.js (relais worker.postMessage) et
 * server.js (le worker qui applique réellement la pause avant l'appel
 * Groq/Deepgram, dans audioCapture.on({ onAudioSegment })).
 */

const { safeStorage } = require('electron');
const featuresStore = require('./features-store');

let obsClient = null;
let gatingConfig = null;
let currentObsState = { sceneName: null, streaming: false, recording: false };
let lastGateOpen = null; // null = jamais évalué ; évite un log/callback redondant

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

/**
 * @param {(open: boolean, reason: string, state: object) => void} [onGateChange]
 *   Appelé à chaque fois que l'état "transcription autorisée ou non"
 *   change (jamais à chaque événement OBS brut — voir emitGateIfChanged).
 *   Optionnel : si omis, le gating n'est simplement pas activé, même si
 *   features.broadcast.multiScene.gating.enabled = true dans la config.
 */
async function connect(onGateChange) {
  // CORRECTIF (audit round 5) : la config est relue à CHAQUE connexion (via
  // features-store, qui fusionne la config livrée et les réglages
  // utilisateur écrits dans userData). Avant, elle était figée au premier
  // require() du fichier JSON, ce qui obligeait main.js à vider le cache de
  // modules après chaque enregistrement pour que le changement soit pris en
  // compte — et faisait perdre la connexion OBS déjà établie au passage.
  const cfg = (featuresStore.readFeatures().broadcast || {}).multiScene || {};
  if (!cfg.enabled) return null;

  // Import dynamique — n'installe la dépendance que si feature activée
  const { OBSWebSocket } = await import('obs-websocket-js');
  obsClient = new OBSWebSocket();

  gatingConfig = cfg.gating || { enabled: false, liveSceneNames: [], requireStreamingOrRecording: false };

  try {
    await obsClient.connect(cfg.obsWebsocketUrl, resolvePassword(cfg));
    console.log('[obs] Connecté à OBS Studio');

    if (gatingConfig.enabled && typeof onGateChange === 'function') {
      await setupGating(onGateChange);
    }

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

// -----------------------------------------------------------------------
// AJOUT (audit — gating par état OBS, inspiré du protocole obs-websocket)
// -----------------------------------------------------------------------

/**
 * Décide si la transcription doit être active ("ouverte") ou en pause
 * ("fermée") à partir du dernier état OBS connu et de la config gating.
 *
 * Règles (cumulatives — les DEUX doivent être satisfaites si les deux sont
 * configurées) :
 *   1. Si `liveSceneNames` est une liste NON VIDE, la scène courante doit
 *      y figurer, sinon on ferme (ex: scène "Louange" ou "Pause" -> fermé).
 *      Liste vide ou absente = pas de restriction par scène.
 *   2. Si `requireStreamingOrRecording` est vrai, il faut qu'OBS soit en
 *      train de streamer OU d'enregistrer, sinon on ferme (ex: réglages
 *      avant culte, OBS ouvert mais rien ne part encore -> fermé).
 *
 * @param {{sceneName: string|null, streaming: boolean, recording: boolean}} state
 * @param {{enabled: boolean, liveSceneNames?: string[], requireStreamingOrRecording?: boolean}} cfg
 * @returns {{open: boolean, reason: string}}
 */
function evaluateGate(state, cfg) {
  if (!cfg || !cfg.enabled) return { open: true, reason: 'gating désactivé' };

  if (Array.isArray(cfg.liveSceneNames) && cfg.liveSceneNames.length > 0) {
    if (!state.sceneName || !cfg.liveSceneNames.includes(state.sceneName)) {
      return { open: false, reason: `scène "${state.sceneName || '?'}" hors liste des scènes "en direct"` };
    }
  }

  if (cfg.requireStreamingOrRecording && !state.streaming && !state.recording) {
    return { open: false, reason: 'ni streaming ni enregistrement actif dans OBS' };
  }

  return { open: true, reason: 'conditions remplies' };
}

// N'appelle onGateChange que si l'état OUVERT/FERMÉ a réellement changé —
// pas à chaque événement OBS brut (ex: plusieurs SceneItemTransformChanged
// sans rapport avec le nom de la scène ne doivent pas spammer le worker).
function emitGateIfChanged(onGateChange) {
  const { open, reason } = evaluateGate(currentObsState, gatingConfig);
  if (open === lastGateOpen) return;
  lastGateOpen = open;
  console.log(`[obs] Gating transcription : ${open ? 'OUVERT' : 'FERMÉ'} (${reason})`);
  try {
    onGateChange(open, reason, { ...currentObsState });
  } catch (e) {
    console.error('[obs] Erreur dans le callback de gating:', e.message);
  }
}

/**
 * Récupère l'état initial (scène courante, stream/enregistrement actifs)
 * puis s'abonne aux événements obs-websocket qui peuvent le faire changer.
 * Chaque échec de requête initiale est non bloquant (log + valeur par
 * défaut conservée) : un fournisseur OBS partiellement répondant ne doit
 * jamais empêcher la connexion de s'établir.
 */
async function setupGating(onGateChange) {
  try {
    const scene = await obsClient.call('GetCurrentProgramScene');
    currentObsState.sceneName = scene.sceneName || scene.currentProgramSceneName || null;
  } catch (e) {
    console.warn('[obs] Gating : lecture de la scène courante impossible:', e.message);
  }
  try {
    const stream = await obsClient.call('GetStreamStatus');
    currentObsState.streaming = !!stream.outputActive;
  } catch (e) {
    console.warn('[obs] Gating : lecture du statut de stream impossible:', e.message);
  }
  try {
    const record = await obsClient.call('GetRecordStatus');
    currentObsState.recording = !!record.outputActive;
  } catch (e) {
    console.warn('[obs] Gating : lecture du statut d\'enregistrement impossible:', e.message);
  }

  emitGateIfChanged(onGateChange); // état initial, avant le premier événement

  obsClient.on('CurrentProgramSceneChanged', (data) => {
    currentObsState.sceneName = data.sceneName;
    emitGateIfChanged(onGateChange);
  });
  obsClient.on('StreamStateChanged', (data) => {
    currentObsState.streaming = !!data.outputActive;
    emitGateIfChanged(onGateChange);
  });
  obsClient.on('RecordStateChanged', (data) => {
    currentObsState.recording = !!data.outputActive;
    emitGateIfChanged(onGateChange);
  });

  console.log('[obs] Gating activé — abonné à CurrentProgramSceneChanged, StreamStateChanged, RecordStateChanged.');
}

module.exports = {
  connect, switchScene, listScenes, toggleRecording,
  evaluateGate, // exporté pour les tests unitaires (pure function, sans obsClient)
};
