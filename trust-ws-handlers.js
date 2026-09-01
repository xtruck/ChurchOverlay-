'use strict';

/**
 * trust-ws-handlers.js — Handlers WS du mode confiance (Partie 2 —
 * auto/semi-auto/manuel) (Phase 2 — modularisation du dispatch WS de
 * server.js, même chantier que media-ws-handlers.js et les extractions de
 * catégorie qui l'ont suivi).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * setTrustMode/confirmPendingVerse/dismissPendingVerse.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * getPendingVerse est un GETTER (pas la valeur) : pendingVerse est un `let`
 * de server.js réassigné par confirmPendingVerse()/dismissPendingVerse()
 * eux-mêmes (passés ici tel quels, ils encapsulent déjà leur propre
 * mutation) — seul setTrustMode a besoin de LIRE l'état actuel pour
 * décider s'il doit rejeter un verset en attente devenu orphelin.
 *
 * @param {object} ctx
 * @param {object} ctx.sessionState
 * @param {() => object|null} ctx.getPendingVerse
 * @param {() => Promise<{ok: boolean, reason?: string, reference?: string}>} ctx.confirmPendingVerse
 * @param {() => {ok: boolean, reference?: string}} ctx.dismissPendingVerse
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    sessionState,
    getPendingVerse,
    confirmPendingVerse,
    dismissPendingVerse,
    broadcast,
    log,
  } = ctx;

  const handlers = new Map();

  handlers.set('setTrustMode', async (ws, sanitized) => {
    const ok = sessionState.setTrustMode(sanitized.mode);
    if (!ok) {
      ws.send(
        JSON.stringify({ action: 'error', error: `Mode confiance invalide : ${sanitized.mode}` })
      );
      return;
    }
    // Changer de mode en cours de route ne doit jamais laisser un verset
    // orphelin en attente d'un mode qui n'existe plus (ex. bascule vers
    // 'auto' pendant qu'une confirmation était en attente) — rejeté
    // proprement plutôt que silencieusement oublié.
    if (getPendingVerse()) {
      const dismissed = dismissPendingVerse();
      broadcast({ action: 'pendingVerseDismissed', reference: dismissed.reference });
    }
    broadcast({ action: 'trustModeChanged', trustMode: sessionState.getTrustMode() });
    log('Mode confiance : ' + sessionState.getTrustMode());
  });

  handlers.set('confirmPendingVerse', async (ws) => {
    const result = await confirmPendingVerse();
    if (!result.ok) {
      ws.send(JSON.stringify({ action: 'error', error: result.reason }));
    }
  });

  handlers.set('dismissPendingVerse', async () => {
    const result = dismissPendingVerse();
    if (result.ok) {
      broadcast({ action: 'pendingVerseDismissed', reference: result.reference });
    }
  });

  return handlers;
}

module.exports = { createHandlers };
