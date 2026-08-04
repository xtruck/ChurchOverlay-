/**
 * ============================================================================
 *  rate-limiter.js — Module de limitation de taux (Rate Limiting)
 * ----------------------------------------------------------------------------
 *  Limite le nombre de connexions et messages pour prévenir les abus et
 *  les attaques par déni de service.
 * ============================================================================
 */

'use strict';

/**
 * Crée un limiteur de taux pour les connexions
 * @param {Object} options - Options de configuration
 * @returns {Object} - Limiteur de taux avec méthodes checkConnection, checkMessage, cleanup
 */
function createRateLimiter(options = {}) {
  // Constants pour WebSocket readyState
  const WS_READY_STATE = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
  const config = {
    maxConnections: options.maxConnections || 10, // Max connexions simultanées
    maxMessagesPerMinute: options.maxMessagesPerMinute || 60, // Max messages par minute par IP
    connectionWindowMs: options.connectionWindowMs || 60000, // Fenêtre de temps pour les messages
    cleanupIntervalMs: options.cleanupIntervalMs || 300000, // Intervalle de nettoyage (5 min)
    ...options,
  };

  // CORRECTIF (audit sécurité — flood par type de message) : la limite
  // globale ci-dessus (maxMessagesPerMinute, 60/min) protège contre un flood
  // générique, mais un client autorisé à envoyer des messages "operator"
  // pouvait auparavant envoyer 60 `showVerse` en 1 minute et perturber
  // l'affichage devant l'assemblée sans jamais dépasser la limite globale.
  // On ajoute des limites SPÉCIFIQUES par type d'action, en plus (pas à la
  // place) de la limite globale par IP.
  const PER_ACTION_LIMITS = {
    showVerse: { max: 5, windowMs: 60000 },
    emergencyClear: { max: 3, windowMs: 60000 },
    applyTheme: { max: 5, windowMs: 60000 },
  };
  // IP -> Map(actionType -> Array de timestamps)
  const actionHistory = new Map();

  // Stockage des connexions par IP
  const connections = new Map(); // IP -> Set de WebSocket connections

  // Stockage des messages par IP
  const messageHistory = new Map(); // IP -> Array de timestamps

  // Interval de nettoyage
  let cleanupInterval;

  /**
   * Nettoie les anciennes entrées
   */
  function cleanup() {
    const now = Date.now();

    // Nettoyer l'historique des messages
    for (const [ip, timestamps] of messageHistory.entries()) {
      const recent = timestamps.filter((time) => now - time < config.connectionWindowMs);
      if (recent.length === 0) {
        messageHistory.delete(ip);
      } else {
        messageHistory.set(ip, recent);
      }
    }

    // CORRECTIF (audit sécurité) : actionHistory grandit avec le temps
    // exactement comme messageHistory (une entrée par IP x type d'action) —
    // même stratégie de purge nécessaire pour ne pas réintroduire une fuite
    // mémoire déjà corrigée ailleurs dans le projet (voir round 7).
    for (const [ip, perIpActions] of actionHistory.entries()) {
      for (const [actionType, timestamps] of perIpActions.entries()) {
        const limit = PER_ACTION_LIMITS[actionType];
        const windowMs = limit ? limit.windowMs : config.connectionWindowMs;
        const recent = timestamps.filter((time) => now - time < windowMs);
        if (recent.length === 0) {
          perIpActions.delete(actionType);
        } else {
          perIpActions.set(actionType, recent);
        }
      }
      if (perIpActions.size === 0) {
        actionHistory.delete(ip);
      }
    }

    // Nettoyer les connexions fermées
    for (const [ip, socketSet] of connections.entries()) {
      const activeSockets = new Set();
      for (const socket of socketSet) {
        if (socket.readyState === WS_READY_STATE.OPEN) {
          activeSockets.add(socket);
        }
      }
      if (activeSockets.size === 0) {
        connections.delete(ip);
      } else {
        connections.set(ip, activeSockets);
      }
    }
  }

  /**
   * Extrait l'IP d'une connexion WebSocket
   * @param {WebSocket} ws - Connexion WebSocket
   * @returns {string} - Adresse IP
   */
  function getClientIP(ws) {
    // Essayer de récupérer l'IP depuis différentes sources
    if (ws._socket && ws._socket.remoteAddress) {
      return ws._socket.remoteAddress;
    }
    return 'unknown';
  }

  /**
   * Vérifie si une nouvelle connexion est autorisée
   * @param {WebSocket} ws - Connexion WebSocket
   * @returns {Object} - { allowed: boolean, reason: string|null }
   */
  function checkConnection(ws) {
    const ip = getClientIP(ws);
    const currentConnections = connections.get(ip) || new Set();

    // Vérifier le nombre maximum de connexions par IP
    if (currentConnections.size >= config.maxConnections) {
      return {
        allowed: false,
        reason: `Trop de connexions depuis cette IP (${currentConnections.size}/${config.maxConnections})`,
      };
    }

    // Vérifier le nombre total de connexions
    let totalConnections = 0;
    for (const socketSet of connections.values()) {
      totalConnections += socketSet.size;
    }

    if (totalConnections >= config.maxConnections * 2) {
      // Limite globale plus souple
      return {
        allowed: false,
        reason: 'Nombre maximum de connexions atteint sur le serveur',
      };
    }

    // Ajouter la connexion
    currentConnections.add(ws);
    connections.set(ip, currentConnections);

    return { allowed: true, reason: null };
  }

  /**
   * Vérifie si un message est autorisé
   * @param {WebSocket} ws - Connexion WebSocket
   * @returns {Object} - { allowed: boolean, reason: string|null }
   */
  function checkMessage(ws, actionType) {
    const ip = getClientIP(ws);
    const now = Date.now();

    // Récupérer ou créer l'historique des messages
    const timestamps = messageHistory.get(ip) || [];

    // Nettoyer les anciens messages
    const recent = timestamps.filter((time) => now - time < config.connectionWindowMs);

    // Vérifier la limite
    if (recent.length >= config.maxMessagesPerMinute) {
      return {
        allowed: false,
        reason: `Trop de messages (${recent.length}/${config.maxMessagesPerMinute} par minute)`,
      };
    }

    // CORRECTIF (audit sécurité) : vérification supplémentaire par type
    // d'action, en plus de la limite globale ci-dessus. `actionType` est
    // optionnel — les appelants existants qui font checkMessage(ws) sans
    // deuxième argument gardent exactement l'ancien comportement (limite
    // globale uniquement), donc rien ne casse en amont.
    if (actionType && PER_ACTION_LIMITS[actionType]) {
      const limit = PER_ACTION_LIMITS[actionType];
      const perIpActions = actionHistory.get(ip) || new Map();
      const actionTimestamps = perIpActions.get(actionType) || [];
      const recentActions = actionTimestamps.filter((time) => now - time < limit.windowMs);

      if (recentActions.length >= limit.max) {
        return {
          allowed: false,
          reason: `Too many ${actionType} messages per minute (${recentActions.length}/${limit.max})`,
        };
      }

      recentActions.push(now);
      perIpActions.set(actionType, recentActions);
      actionHistory.set(ip, perIpActions);
    }

    // Ajouter le message actuel
    recent.push(now);
    messageHistory.set(ip, recent);

    return { allowed: true, reason: null };
  }

  /**
   * Supprime une connexion du suivi
   * @param {WebSocket} ws - Connexion WebSocket
   */
  function removeConnection(ws) {
    const ip = getClientIP(ws);
    const socketSet = connections.get(ip);

    if (socketSet) {
      socketSet.delete(ws);
      if (socketSet.size === 0) {
        connections.delete(ip);
      }
    }
  }

  /**
   * Démarre le nettoyage automatique
   */
  function startCleanup() {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(cleanup, config.cleanupIntervalMs);
    // CORRECTIF (audit round 7) : unref() défensif — ce timer ne doit jamais
    // à lui seul empêcher le process/worker qui l'a créé de s'arrêter
    // naturellement, même sur un chemin de sortie qui aurait oublié
    // d'appeler stopCleanup().
    cleanupInterval.unref?.();
  }

  /**
   * Arrête le nettoyage automatique
   */
  function stopCleanup() {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }

  /**
   * Obtient des statistiques
   * @returns {Object} - Statistiques actuelles
   */
  function getStats() {
    let totalConnections = 0;
    for (const socketSet of connections.values()) {
      totalConnections += socketSet.size;
    }

    return {
      totalConnections,
      uniqueIPs: connections.size,
      messageHistorySize: messageHistory.size,
    };
  }

  // Démarrer le nettoyage automatique
  startCleanup();

  return {
    checkConnection,
    checkMessage,
    removeConnection,
    getStats,
    stopCleanup,
  };
}

module.exports = { createRateLimiter };
