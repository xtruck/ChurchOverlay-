'use strict';
/**
 * propresenter-controller.js — Pont ProPresenter 7 (Remote API WebSocket)
 *
 * ENTIÈREMENT OPTIONNEL, sur le même principe que obs-controller.js : si
 * features.broadcast.propresenter.enabled = false (défaut), ce module n'est
 * même pas sollicité. L'app tourne exactement comme avant.
 *
 * Remplace propresenter-bridge.js (ancien plugin, jamais réellement chargé —
 * absent de config/plugins/, jamais référencé par plugin-system.js — retiré
 * du dépôt). Contrairement à ce plugin mort (envoi UNIDIRECTIONNEL vers
 * ProPresenter uniquement), ce module ouvre une vraie connexion persistante
 * au canal Remote de ProPresenter.
 *
 * -----------------------------------------------------------------------
 * PROTOCOLE (recherché avant implémentation, pas deviné) — voir
 * jeffmikels.github.io/ProPresenter-API/Pro7/, documentation communautaire
 * de référence pour l'API Remote de ProPresenter 7 :
 *   1. Connexion WebSocket : ws://<host>:<port>/remote
 *   2. Immédiatement après l'ouverture, envoyer :
 *      {"action":"authenticate","protocol":701,"password":"..."}
 *      (protocol: 701 pour ProPresenter 7.4.2+, 700 pour les versions
 *      antérieures — 701 utilisé ici, la grande majorité des installations
 *      2026 sont au-delà de 7.4.2)
 *   3. Réponse attendue : {"authenticated":1,...} (0 si mot de passe refusé)
 *   4. Message vers l'écran scène : {"action":"stageDisplaySendMessage",
 *      "stageDisplayMessage":"texte"}
 *
 * Volontairement PAS de déclenchement de diapositive (presentationTriggerIndex)
 * dans cette version : cette commande a besoin de connaître le chemin exact
 * de la présentation ProPresenter active côté opérateur, une information que
 * ChurchOverlay n'a aucun moyen de connaître — l'implémenter à l'aveugle
 * aurait été deviner plutôt que suivre la documentation. sendStageMessage()
 * seule couvre déjà le besoin réel (verset détecté -> message sur l'écran
 * scène ProPresenter).
 */

function getSafeStorage() {
  return require('electron').safeStorage;
}
const featuresStore = require('./features-store');

let wsClient = null;
let authenticated = false;

// Même raisonnement que resolvePassword() dans obs-controller.js.
function resolvePassword(cfg) {
  if (cfg.passwordEncrypted) {
    const safeStorage = getSafeStorage();
    if (!safeStorage.isEncryptionAvailable()) {
      console.error(
        '[propresenter] Chiffrement système indisponible : impossible de lire le mot de passe.'
      );
      return '';
    }
    try {
      return safeStorage.decryptString(Buffer.from(cfg.passwordEncrypted, 'base64'));
    } catch (e) {
      console.error('[propresenter] Échec du déchiffrement du mot de passe:', e.message);
      return '';
    }
  }
  return cfg.password || '';
}

/**
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function connect() {
  const cfg = (featuresStore.readFeatures().broadcast || {}).propresenter || {};
  if (!cfg.enabled) return { ok: false, error: 'ProPresenter désactivé dans la configuration' };

  if (wsClient) {
    try {
      wsClient.terminate();
    } catch (_e) {
      /* déjà fermé */
    }
    wsClient = null;
    authenticated = false;
  }

  const WebSocketClient = require('ws');
  const host = cfg.host || 'localhost';
  const port = cfg.port || 50001;
  const url = `ws://${host}:${port}/remote`;

  return new Promise((resolve) => {
    let settled = false;
    const client = new WebSocketClient(url);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        client.terminate();
      } catch (_e) {
        /* best effort */
      }
      resolve({ ok: false, error: `Timeout de connexion à ${url}` });
    }, 5000);

    client.on('open', () => {
      client.send(
        JSON.stringify({
          action: 'authenticate',
          protocol: 701,
          password: resolvePassword(cfg),
        })
      );
    });

    client.on('message', (data) => {
      if (settled) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_e) {
        return;
      }
      if (msg.action === 'authenticate') {
        settled = true;
        clearTimeout(timeout);
        if (msg.authenticated) {
          wsClient = client;
          authenticated = true;
          console.log('[propresenter] Connecté et authentifié.');
          resolve({ ok: true });
        } else {
          try {
            client.terminate();
          } catch (_e) {
            /* best effort */
          }
          resolve({ ok: false, error: msg.error || 'Authentification refusée (mot de passe ?)' });
        }
      }
    });

    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message });
    });

    client.on('close', () => {
      authenticated = false;
      wsClient = null;
    });
  });
}

/**
 * Envoie un message texte à l'écran scène ProPresenter (Stage Display).
 * @param {string} text
 * @returns {{ok: boolean, error?: string}}
 */
function sendStageMessage(text) {
  if (!wsClient || !authenticated) {
    return { ok: false, error: 'ProPresenter non connecté' };
  }
  try {
    wsClient.send(
      JSON.stringify({ action: 'stageDisplaySendMessage', stageDisplayMessage: String(text || '') })
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isConnected() {
  return !!(wsClient && authenticated);
}

function disconnect() {
  if (wsClient) {
    try {
      wsClient.terminate();
    } catch (_e) {
      /* best effort */
    }
  }
  wsClient = null;
  authenticated = false;
}

module.exports = { connect, sendStageMessage, isConnected, disconnect };
