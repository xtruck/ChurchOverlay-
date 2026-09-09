'use strict';
/**
 * ============================================================================
 *  network-utils.js — détection de l'adresse IP réseau locale (LAN)
 * ----------------------------------------------------------------------------
 *  AJOUT (chantier "Diffusion des sous-titres en direct par QR code").
 *  DURCISSEMENT : getLanIpAddress() existait déjà, mais DUPLIQUÉE à
 *  l'identique dans server.js (utilisée par generateCameraPairing) ET
 *  main.js (utilisée par getNetworkPageUrl pour companion.html/
 *  stage-display.html/announcement-loop.html) — un commentaire de server.js
 *  documentait déjà explicitement ce choix ("dupliquée plutôt que
 *  partagée"). Extraite ici une bonne fois : les deux fichiers requièrent
 *  désormais la MÊME implémentation, un bug corrigé ici (ex. IPv6 pris par
 *  erreur) se propage aux deux au lieu de devoir être corrigé deux fois.
 * ============================================================================
 */

const os = require('os');

/**
 * Détecte la première adresse IPv4 non-interne (donc une vraie interface
 * réseau — Wi-Fi/Ethernet — pas la boucle locale 127.0.0.1) trouvée sur ce
 * poste. Utilisée pour construire une URL joignable depuis un autre appareil
 * du même réseau local (téléphone scannant un QR code, caméra IP jumelée).
 * @returns {string|null} adresse IPv4, ou null si aucune interface externe
 *   n'est trouvée (poste hors réseau, VPN-only, etc.)
 */
function getLanIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

/**
 * Construit l'URL réseau (http://<ip locale>:<port>/<chemin>) d'une page
 * servie par ce serveur, joignable depuis un autre appareil du même réseau
 * Wi-Fi. Renvoie null si aucune IP locale n'est détectable (même garde que
 * getLanIpAddress() — jamais une URL inutilisable pointant vers rien).
 * @param {string} pathName - chemin de la route HTTP (ex. 'companion', 'phone-camera.html')
 * @param {number} port
 * @returns {string|null}
 */
function buildLanUrl(pathName, port) {
  const lanIp = getLanIpAddress();
  if (!lanIp) return null;
  const cleanPath = String(pathName || '').replace(/^\/+/, '');
  return `http://${lanIp}:${port}/${cleanPath}`;
}

module.exports = { getLanIpAddress, buildLanUrl };
