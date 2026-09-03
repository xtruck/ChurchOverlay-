'use strict';

/**
 * camera-ws-handlers.js — Handlers WS des caméras IP/téléphone (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js/scene-ws-handlers.js/song-ws-handlers.js/
 * rundown-ws-handlers.js).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * getIpCameras/addIpCamera/deleteIpCamera/generateCameraPairing.
 *
 * NE couvre PAS les routes HTTP caméra téléphone (/phone-camera-pair,
 * /phone-camera-frame/:id, /phone-camera-stream/:id — déjà extraites dans
 * phone-camera-routes.js, un chantier antérieur) ni cleanupPhoneCameraStateForItem
 * (défini là-bas, réutilisé ici tel quel).
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.ipCameraStore
 * @param {(item: object) => void} ctx.cleanupPhoneCameraStateForItem - depuis
 *   phone-camera-routes.js ; invalide le secret de flux/dernière image d'un
 *   téléphone jumelé par QR quand sa caméra IP est supprimée
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {string} ctx.wsHost - WS_HOST ; generateCameraPairing refuse de
 *   générer un QR inutilisable si le serveur n'écoute que sur localhost
 * @param {() => string|null} ctx.getLanIpAddress
 * @param {object} ctx.phoneCameraPairing
 * @param {number} ctx.serverPort - SERVER_PORT
 * @param {object} ctx.QRCode - lib `qrcode` (QRCode.toDataURL)
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    ipCameraStore,
    cleanupPhoneCameraStateForItem,
    broadcast,
    log,
    wsHost,
    getLanIpAddress,
    phoneCameraPairing,
    serverPort,
    QRCode,
  } = ctx;

  const handlers = new Map();

  // --- Caméras de téléphone (flux MJPEG réseau, voir ip-camera-store.js).
  // Contrairement à la médiathèque, il n'y a rien à diffuser à l'overlay
  // ici : c'est un outil de suivi côté opérateur uniquement, le flux
  // lui-même est chargé directement par le navigateur du dashboard depuis
  // le téléphone (pas relayé par ce serveur). broadcast() seulement pour
  // que plusieurs tableaux de bord ouverts restent synchronisés — et
  // désormais { operatorOnly: true } (voir broadcast() dans server.js) pour
  // que ça reste vrai même si une connexion viewer traîne (elle révélerait
  // sinon les IP/labels des caméras du réseau local). ---
  handlers.set('getIpCameras', async (ws) => {
    ws.send(JSON.stringify({ action: 'ipCamerasUpdated', items: ipCameraStore.listItems() }));
  });

  handlers.set('addIpCamera', async (ws, sanitized) => {
    try {
      const item = ipCameraStore.addItem(
        { label: sanitized.label, url: sanitized.url },
        cleanupPhoneCameraStateForItem
      );
      log(`Caméra IP : "${item.label}" ajoutée`);
      broadcast(
        { action: 'ipCamerasUpdated', items: ipCameraStore.listItems() },
        { operatorOnly: true }
      );
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Caméra IP : ' + err.message }));
    }
  });

  handlers.set('deleteIpCamera', async (ws, sanitized) => {
    // AJOUT (caméra téléphone QR) : si l'élément supprimé est un téléphone
    // jumelé par QR (voir POST /phone-camera-pair), on invalide aussi son
    // secret de flux et on oublie sa dernière image — sinon le téléphone
    // continuerait d'envoyer des images pour rien, indéfiniment.
    const item = ipCameraStore.listItems().find((i) => i.id === sanitized.id);
    cleanupPhoneCameraStateForItem(item);
    const removed = ipCameraStore.deleteItem(sanitized.id);
    if (removed) {
      broadcast(
        { action: 'ipCamerasUpdated', items: ipCameraStore.listItems() },
        { operatorOnly: true }
      );
    } else {
      ws.send(JSON.stringify({ action: 'error', error: 'Caméra IP : élément introuvable' }));
    }
  });

  // --- Caméra téléphone par QR code (voir phone-camera-pairing.js,
  // phone-camera.html, et les routes HTTP /phone-camera-* dans
  // phone-camera-routes.js) ---
  handlers.set('generateCameraPairing', async (ws, sanitized) => {
    // Le téléphone doit pouvoir atteindre ce serveur sur le réseau — un QR
    // généré alors que WS_HOST reste sur 127.0.0.1 (le défaut, voulu pour la
    // sécurité) ne mènerait nulle part. On le signale clairement plutôt que
    // de générer un QR silencieusement inutilisable.
    if (wsHost === '127.0.0.1' || wsHost === 'localhost') {
      ws.send(
        JSON.stringify({
          action: 'error',
          error:
            "Caméra téléphone : le serveur doit être accessible sur le réseau (WS_HOST) pour que le téléphone puisse s'y connecter. Voir README.md.",
        })
      );
      return;
    }
    const lanIp = getLanIpAddress();
    if (!lanIp) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error: 'Caméra téléphone : aucune adresse réseau locale détectée sur ce poste.',
        })
      );
      return;
    }
    try {
      // AJOUT (demande explicite — "plus de paramètres") : nom choisi par
      // l'opérateur AVANT de générer le QR (sinon plusieurs téléphones
      // jumelés apparaissent tous sous le même nom générique, impossible à
      // distinguer dans la liste — voir redeemPairingCode()) et qualité du
      // flux (Basse/Moyenne/Haute), portée dans l'URL elle-même puisque
      // c'est le TÉLÉPHONE qui doit configurer sa propre capture, sans
      // pouvoir demander à l'opérateur après coup.
      const label = typeof sanitized.label === 'string' ? sanitized.label : '';
      const quality = ['low', 'medium', 'high'].includes(sanitized.quality)
        ? sanitized.quality
        : 'medium';
      const pairCode = phoneCameraPairing.generatePairingCode(label);
      const pairUrl = `http://${lanIp}:${serverPort}/phone-camera.html?pair=${pairCode}&q=${quality}`;
      const qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 1, width: 320 });
      ws.send(
        JSON.stringify({
          action: 'cameraPairingGenerated',
          qrDataUrl,
          url: pairUrl,
          expiresInMs: phoneCameraPairing.PAIRING_TTL_MS,
        })
      );
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Caméra téléphone : ' + err.message }));
    }
  });

  return handlers;
}

module.exports = { createHandlers };
