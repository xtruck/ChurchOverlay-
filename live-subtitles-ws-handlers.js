'use strict';

/**
 * live-subtitles-ws-handlers.js — Handlers WS de la diffusion de sous-titres
 * en direct par QR code (Phase 2 — modularisation du dispatch WS de
 * server.js, même chantier que media-ws-handlers.js/camera-ws-handlers.js).
 *
 * Une seule action ici : générer le QR code d'accès à la page compagnon
 * (companion.html, déjà servie sur `/companion` — voir http-routes.js).
 *
 * DÉCISION D'ARCHITECTURE (à lire avant de "corriger" cette route pour
 * qu'elle passe par le canal WebSocket authentifié) : contrairement à
 * generateCameraPairing (camera-ws-handlers.js), l'URL générée ici ne porte
 * AUCUN jeton. Ce n'est pas un oubli — `/companion` (http-routes.js) est une
 * route DÉLIBÉRÉMENT publique et sans jeton (même sensibilité que /api/health,
 * lecture seule de données déjà projetées en salle, voir son commentaire).
 * Un canal WebSocket, LUI, exige un jeton dès que WS_HOST est non-local
 * (WS_AUTH_TOKEN devient obligatoire — voir config-validator.js) : si
 * WS_VIEWER_TOKEN n'est pas configuré séparément (cas courant — beaucoup
 * d'opérateurs ne configurent que WS_AUTH_TOKEN), un client WS sans jeton
 * serait purement et simplement REJETÉ (server.js > wss.on('connection')),
 * cassant silencieusement la page pour toute l'assemblée. La page compagnon
 * reste donc volontairement en polling HTTP tokenless — plus robuste pour ce
 * cas d'usage précis (un téléphone quelconque scanne un QR, sans jamais
 * avoir reçu la moindre configuration), pas moins sécurisé : elle n'a de
 * toute façon AUCUN canal pour émettre une commande, jeton ou non.
 *
 * @param {object} ctx
 * @param {string} ctx.wsHost - WS_HOST ; un QR généré alors que le serveur
 *   n'écoute que sur 127.0.0.1 serait inutilisable depuis un téléphone
 * @param {(pathName: string, port: number) => string|null} ctx.buildLanUrl - voir network-utils.js
 * @param {number} ctx.serverPort - SERVER_PORT
 * @param {object} ctx.QRCode - lib `qrcode` (QRCode.toDataURL)
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { wsHost, buildLanUrl, serverPort, QRCode } = ctx;

  const handlers = new Map();

  handlers.set('getCompanionQr', async (ws) => {
    // Même garde que generateCameraPairing (camera-ws-handlers.js) : un QR
    // pointant vers 127.0.0.1 ne serait joignable que depuis CE poste, jamais
    // depuis un téléphone sur le même Wi-Fi.
    if (wsHost === '127.0.0.1' || wsHost === 'localhost') {
      ws.send(
        JSON.stringify({
          action: 'error',
          error:
            "Sous-titres en direct : le serveur doit être accessible sur le réseau (WS_HOST) pour qu'un téléphone puisse scanner ce QR code. Voir README.md.",
        })
      );
      return;
    }
    const url = buildLanUrl('companion', serverPort);
    if (!url) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error: 'Sous-titres en direct : aucune adresse réseau locale détectée sur ce poste.',
        })
      );
      return;
    }
    try {
      const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
      ws.send(JSON.stringify({ action: 'companionQrGenerated', qrDataUrl, url }));
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Sous-titres en direct : ' + err.message }));
    }
  });

  return handlers;
}

module.exports = { createHandlers };
