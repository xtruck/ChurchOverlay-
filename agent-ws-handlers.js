'use strict';

/**
 * agent-ws-handlers.js — Handlers WS de l'agent IA conversationnel (Phase 2
 * — modularisation du dispatch WS de server.js, dernier lot de cette
 * extraction par catégorie, même chantier que media-ws-handlers.js et
 * toutes celles qui l'ont précédé).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) : agentRun/
 * agentResume — un SEUL handler couvrant les deux actions (comme dans
 * server.js d'origine), distinguées en interne par sanitized.action.
 * Forme différente de toutes les autres catégories déjà extraites : un
 * `for await` sur un générateur asynchrone (churchAgent.run()) qui envoie
 * plusieurs messages 'agentEvent' au fil de l'exécution, plutôt qu'une
 * seule réponse/diffusion — raison pour laquelle ce handler est resté seul
 * dans server.js jusqu'ici plutôt que d'être regroupé ailleurs.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * getChurchAgent est un GETTER (pas la valeur) : churchAgent est un `let`
 * de server.js, `null` à l'initialisation puis réassigné une seule fois
 * (synchrone, au chargement du module, avant que le serveur n'accepte de
 * connexions) par createChurchOverlayAgent() — une valeur capturée au
 * moment de la construction de CATEGORY_HANDLERS resterait figée sur ce
 * `null` initial.
 *
 * @param {object} ctx
 * @param {() => object|null} ctx.getChurchAgent
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { getChurchAgent } = ctx;

  const handlers = new Map();

  // --- Speech or audio transcript input ---
  const agentHandler = async (ws, sanitized) => {
    const churchAgent = getChurchAgent();
    if (!churchAgent) {
      ws.send(JSON.stringify({ action: 'error', error: 'Agent IA indisponible.' }));
      return;
    }
    const sessionId =
      typeof sanitized.sessionId === 'string' && sanitized.sessionId.trim()
        ? sanitized.sessionId.trim()
        : `service-${new Date().toISOString().slice(0, 10)}`;
    const input = typeof sanitized.input === 'string' ? sanitized.input.trim() : '';
    if (sanitized.action === 'agentRun' && (!input || input.length > 4000)) {
      ws.send(JSON.stringify({ action: 'error', error: 'Requête agent vide ou trop longue.' }));
      return;
    }
    try {
      const runOptions =
        sanitized.action === 'agentResume'
          ? {
              sessionId,
              runId: sanitized.runId,
              approvedToolCallIds: sanitized.approvedToolCallIds,
            }
          : { sessionId, input };
      for await (const event of churchAgent.run(runOptions)) {
        ws.send(JSON.stringify({ action: 'agentEvent', ...event }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Agent IA : ' + err.message }));
    }
  };

  handlers.set('agentRun', agentHandler);
  handlers.set('agentResume', agentHandler);

  return handlers;
}

module.exports = { createHandlers };
