/**
 * ============================================================================
 *  rate-limiter.ts — Module de limitation de taux (Rate Limiting)
 * ----------------------------------------------------------------------------
 *  Limite le nombre de connexions et messages pour prévenir les abus et
 *  les attaques par déni de service.
 * ============================================================================
 */

'use strict';

import { RateLimitConfig } from './types';

interface WebSocketConnection {
  readyState: number;
  _socket?: {
    remoteAddress?: string;
  };
}

interface ConnectionCheckResult {
  allowed: boolean;
  reason: string | null;
}

interface ActionLimit {
  max: number;
  windowMs: number;
}

interface RateLimiterOptions extends RateLimitConfig {
  maxConnections?: number;
  maxMessagesPerMinute?: number;
  connectionWindowMs?: number;
  cleanupIntervalMs?: number;
}

const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

const PER_ACTION_LIMITS: Record<string, ActionLimit> = {
  showVerse: { max: 5, windowMs: 60000 },
  emergencyClear: { max: 3, windowMs: 60000 },
  applyTheme: { max: 5, windowMs: 60000 },
};

/**
 * Crée un limiteur de taux pour les connexions
 * @param options - Options de configuration
 * @returns - Limiteur de taux avec méthodes checkConnection, checkMessage, cleanup
 */
function createRateLimiter(options: RateLimiterOptions = {}) {
  const config = {
    maxConnections: options.maxConnections || 10,
    maxMessagesPerMinute: options.maxMessagesPerMinute || 60,
    connectionWindowMs: options.connectionWindowMs || 60000,
    cleanupIntervalMs: options.cleanupIntervalMs || 300000,
    ...options,
  };

  // IP -> Map(actionType -> Array de timestamps)
  const actionHistory = new Map<string, Map<string, number[]>>();

  // Stockage des connexions par IP
  const connections = new Map<string, Set<WebSocketConnection>>();

  // Stockage des messages par IP
  const messageHistory = new Map<string, number[]>();

  // Interval de nettoyage
  let cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Nettoie les anciennes entrées
   */
  function cleanup(): void {
    const now = Date.now();

    // Nettoyer l'historique des messages
    for (const [ip, timestamps] of messageHistory.entries()) {
      const recent = timestamps.filter(
        (time: number) => now - time < (config.connectionWindowMs || 60000)
      );
      if (recent.length === 0) {
        messageHistory.delete(ip);
      } else {
        messageHistory.set(ip, recent);
      }
    }

    // Nettoyer l'historique des actions
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
      const activeSockets = new Set<WebSocketConnection>();
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
   * @param ws - Connexion WebSocket
   * @returns - Adresse IP
   */
  function getClientIP(ws: WebSocketConnection): string {
    // Essayer de récupérer l'IP depuis différentes sources
    if (ws._socket && ws._socket.remoteAddress) {
      return ws._socket.remoteAddress;
    }
    return 'unknown';
  }

  /**
   * Vérifie si une nouvelle connexion est autorisée
   * @param ws - Connexion WebSocket
   * @returns - { allowed: boolean, reason: string|null }
   */
  function checkConnection(ws: WebSocketConnection): ConnectionCheckResult {
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
   * @param ws - Connexion WebSocket
   * @param actionType - Type d'action optionnel pour limite spécifique
   * @returns - { allowed: boolean, reason: string|null }
   */
  function checkMessage(ws: WebSocketConnection, actionType?: string): ConnectionCheckResult {
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

    // Vérification supplémentaire par type d'action
    if (actionType && PER_ACTION_LIMITS[actionType]) {
      const limit = PER_ACTION_LIMITS[actionType];
      const perIpActions = actionHistory.get(ip) || new Map();
      const actionTimestamps = perIpActions.get(actionType) || [];
      const recentActions = actionTimestamps.filter((time: number) => now - time < limit.windowMs);

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
   * @param ws - Connexion WebSocket
   */
  function removeConnection(ws: WebSocketConnection): void {
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
  function startCleanup(): void {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(cleanup, config.cleanupIntervalMs);
    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }

  /**
   * Arrête le nettoyage automatique
   */
  function stopCleanup(): void {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }

  /**
   * Retourne les statistiques actuelles
   */
  function getStats(): Record<string, any> {
    let totalConnections = 0;
    for (const socketSet of connections.values()) {
      totalConnections += socketSet.size;
    }

    const stats = {
      totalConnections,
      uniqueIPs: connections.size,
      totalMessages: 0,
      connectionsPerIP: {} as Record<string, number>,
    };

    for (const [ip, socketSet] of connections.entries()) {
      stats.connectionsPerIP[ip] = socketSet.size;
    }

    for (const timestamps of messageHistory.values()) {
      stats.totalMessages += timestamps.length;
    }

    return stats;
  }

  // Démarrer le nettoyage automatique
  startCleanup();

  return {
    checkConnection,
    checkMessage,
    removeConnection,
    stopCleanup,
    getStats,
    cleanup,
  };
}

export { createRateLimiter };
export type { ConnectionCheckResult, RateLimiterOptions };
