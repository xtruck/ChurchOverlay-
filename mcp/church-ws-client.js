'use strict';
/**
 * ============================================================================
 * mcp/church-ws-client.js — Client WS pour le serveur MCP (chantier 4.5)
 * ----------------------------------------------------------------------------
 * Se connecte au serveur ChurchOverlay déjà en cours d'exécution (server.js,
 * ws://127.0.0.1:PORT par défaut) comme n'importe quel autre client
 * opérateur (tableau de bord, phone-camera, etc.) — même protocole, même
 * jeton WS_AUTH_TOKEN si configuré (passé en sous-protocole WebSocket,
 * `ws.protocol`, voir determineClientRole() dans server.js), aucune
 * nouvelle voie d'accès.
 *
 * Le protocole WS de ce projet n'a pas de corrélation requête/réponse
 * intégrée : une action envoyée déclenche soit un ws.send() direct au
 * client (ex. searchBible -> searchResults/searchError), soit un
 * broadcast() à TOUS les clients connectés, y compris l'émetteur lui-même
 * (voir broadcast() dans server.js — aucune exclusion du socket source),
 * soit les deux selon succès/échec (ex. showVerse -> broadcast 'showVerse'
 * si succès, ws.send 'error' sinon). callAction() couvre les deux cas :
 * on résout dès que l'un des messages "attendus" (successActions) ou un
 * message 'error' arrive, sur cette même connexion.
 * ============================================================================
 */

const WebSocket = require('ws');

class ChurchOverlayClient {
  /**
   * @param {{ url?: string, authToken?: string, timeoutMs?: number }} [options]
   */
  constructor(options = {}) {
    this.url = options.url || process.env.CHURCHOVERLAY_WS_URL || 'ws://127.0.0.1:8765';
    this.authToken = options.authToken || process.env.WS_AUTH_TOKEN || null;
    this.defaultTimeoutMs = options.timeoutMs || 8000;
    this.ws = null;
    this.connectPromise = null;
    this.pending = []; // { successActions: Set, resolve, reject, timer }
  }

  /** @returns {Promise<void>} résolu une fois la connexion WS ouverte. */
  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const protocols = this.authToken ? [this.authToken] : undefined;
      this.ws = new WebSocket(this.url, protocols);

      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => {
        this.connectPromise = null;
        reject(err);
      });
      this.ws.on('close', () => {
        this.connectPromise = null;
        // Toute requête encore en attente ne recevra jamais de réponse —
        // on la fait échouer proprement plutôt que de la laisser pendre.
        for (const p of this.pending.splice(0)) {
          clearTimeout(p.timer);
          p.reject(new Error('Connexion WebSocket fermée avant réponse.'));
        }
      });
      this.ws.on('message', (raw) => this._handleMessage(raw));
    });
    return this.connectPromise;
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_e) {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.action !== 'string') return;

    // Le premier en attente dont ce message correspond au critère de succès
    // (ou toute erreur, qui peut concerner n'importe quelle requête en
    // attente puisque le protocole ne porte pas d'identifiant de
    // corrélation) — voir l'en-tête de fichier. Ordre FIFO : les appels de
    // ce client sont censés être séquentiels (un outil MCP à la fois).
    const idx = this.pending.findIndex(
      (p) => msg.action === 'error' || p.successActions.has(msg.action)
    );
    if (idx === -1) return;
    const p = this.pending.splice(idx, 1)[0];
    clearTimeout(p.timer);
    if (msg.action === 'error') {
      p.reject(new Error(msg.error || 'Erreur inconnue côté serveur.'));
    } else {
      p.resolve(msg);
    }
  }

  /**
   * Envoie une action et attend la réponse correspondante.
   * @param {string} action
   * @param {object} [payload] - fusionné avec { action } dans le message envoyé
   * @param {{ successActions: string[], timeoutMs?: number }} options
   * @returns {Promise<object>} le message de réponse complet
   */
  async callAction(action, payload, options) {
    await this.connect();
    const { successActions, timeoutMs = this.defaultTimeoutMs } = options;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx !== -1) this.pending.splice(idx, 1);
        reject(
          new Error(`Timeout (${timeoutMs}ms) en attente de réponse pour l'action "${action}".`)
        );
      }, timeoutMs);
      const entry = { successActions: new Set(successActions), resolve, reject, timer };
      this.pending.push(entry);

      this.ws.send(JSON.stringify({ action, ...payload }), (err) => {
        if (err) {
          const idx = this.pending.indexOf(entry);
          if (idx !== -1) this.pending.splice(idx, 1);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connectPromise = null;
  }
}

module.exports = { ChurchOverlayClient };
