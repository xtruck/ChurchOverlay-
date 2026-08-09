/**
 * ============================================================================
 * phone-camera-pairing.js — Jumelage caméra téléphone par QR code
 * ----------------------------------------------------------------------------
 * AJOUT (demande explicite — "scanner un QR code, le téléphone est prêt à
 * filmer, sans DroidCam ni IP à taper à la main"). Contrairement à
 * ip-camera-store.js (qui référence le flux d'une app tierce comme "IP
 * Webcam"), ici c'est ChurchOverlay LUI-MÊME qui sert la page ouverte par
 * le téléphone (phone-camera.html) et reçoit son flux — aucune app à
 * installer sur le téléphone, juste son navigateur.
 *
 * Deux étapes, deux secrets DIFFÉRENTS et volontairement à durée de vie
 * différente :
 *   1. Code de jumelage (pairing code) : généré à l'affichage du QR, à
 *      USAGE UNIQUE, expire après PAIRING_TTL_MS (le temps de scanner et
 *      d'accorder la permission caméra — pas indéfiniment valide, un QR
 *      capturé/partagé accidentellement plus tard devient inutile).
 *   2. Secret de flux (stream secret) : émis UNE FOIS le code de jumelage
 *      échangé avec succès, dure toute la session (jusqu'à
 *      removeCamera()) — c'est lui que le téléphone renvoie à CHAQUE
 *      frame envoyée, le code de jumelage lui n'est utilisé qu'une fois.
 *
 * Module pur (aucun accès réseau/Express ici — voir server.js pour les
 * routes HTTP qui l'utilisent), testable isolément.
 * ============================================================================
 */
'use strict';

const crypto = require('crypto');

// Assez de temps pour scanner le QR, accorder la permission caméra et que la
// page se connecte — pas indéfiniment valide (voir commentaire d'en-tête).
const PAIRING_TTL_MS = 10 * 60 * 1000;

const pendingCodes = new Map(); // code -> { createdAt }
const cameras = new Map(); // cameraId -> { streamSecret, pairedAt }

function cleanupExpiredCodes() {
  const now = Date.now();
  for (const [code, info] of pendingCodes) {
    if (now - info.createdAt > PAIRING_TTL_MS) pendingCodes.delete(code);
  }
}

/**
 * @returns {string} un nouveau code de jumelage à usage unique
 */
function generatePairingCode() {
  cleanupExpiredCodes();
  const code = crypto.randomBytes(16).toString('hex');
  pendingCodes.set(code, { createdAt: Date.now() });
  return code;
}

/**
 * @param {string} code
 * @returns {boolean} true si le code existe encore et n'a pas expiré
 */
function isPairingCodeValid(code) {
  cleanupExpiredCodes();
  return !!code && pendingCodes.has(code);
}

/**
 * Échange un code de jumelage (usage unique, consommé immédiatement même en
 * cas de succès) contre un identifiant de caméra + un secret de flux durable.
 * @param {string} code
 * @returns {{cameraId: string, streamSecret: string}|null} null si le code est invalide/expiré
 */
function redeemPairingCode(code) {
  cleanupExpiredCodes();
  if (!code || !pendingCodes.has(code)) return null;
  pendingCodes.delete(code);

  const cameraId = crypto.randomUUID();
  const streamSecret = crypto.randomBytes(24).toString('hex');
  cameras.set(cameraId, { streamSecret, pairedAt: Date.now() });
  return { cameraId, streamSecret };
}

/**
 * @param {string} cameraId
 * @param {string} secret
 * @returns {boolean} true si le secret correspond à cette caméra jumelée
 */
function isStreamSecretValid(cameraId, secret) {
  const camera = cameras.get(cameraId);
  return !!camera && !!secret && camera.streamSecret === secret;
}

/**
 * @param {string} cameraId
 * @returns {boolean} true si cet id correspond à une caméra jumelée (jamais expiré)
 */
function isCameraPaired(cameraId) {
  return cameras.has(cameraId);
}

/**
 * Retire une caméra jumelée (téléphone retiré de la médiathèque IP côté
 * opérateur) — son secret de flux devient immédiatement invalide.
 * @param {string} cameraId
 */
function removeCamera(cameraId) {
  cameras.delete(cameraId);
}

module.exports = {
  generatePairingCode,
  isPairingCodeValid,
  redeemPairingCode,
  isStreamSecretValid,
  isCameraPaired,
  removeCamera,
  PAIRING_TTL_MS,
};
