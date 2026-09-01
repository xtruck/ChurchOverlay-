'use strict';

/**
 * timer-ws-handlers.js — Handlers WS du chronomètre de culte et de
 * l'effacement d'urgence (Phase 2 — modularisation du dispatch WS de
 * server.js, même chantier que media-ws-handlers.js et les extractions de
 * catégorie qui l'ont suivi).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * emergencyClear/pauseTimer/resumeTimer/extendTime.
 *
 * CORRECTIF (audit Phase 1F — actions mortes) : ces 4 actions sont
 * enregistrées dans action-registry.js et le tableau de bord les envoie
 * bien comme de vrais messages WS (voir propresenter-studio.js#ppClearAll,
 * verse-session-display.js#pauseTimer/resumeTimer, command-palette.js) —
 * mais jusqu'à ce correctif, SEUL handleVoiceCommand() (déclenché
 * uniquement par la voix) les traitait ; un opérateur cliquant directement
 * sur ces boutons/raccourcis n'obtenait aucun effet côté overlay.
 * Diffusions identiques à celles de handleVoiceCommand() dans server.js,
 * pour un comportement cohérent entre déclenchement vocal et manuel.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { broadcast, log } = ctx;

  const handlers = new Map();

  handlers.set('emergencyClear', async () => {
    broadcast({ action: 'hideVerse', emergency: true });
    broadcast({ action: 'emergencyClear' });
    log('Effacement d’urgence déclenché manuellement');
  });

  handlers.set('pauseTimer', async () => {
    broadcast({ action: 'pauseTimer', triggeredByVoice: false });
  });

  handlers.set('resumeTimer', async () => {
    broadcast({ action: 'resumeTimer', triggeredByVoice: false });
  });

  handlers.set('extendTime', async (ws, sanitized) => {
    broadcast({ action: 'extendTime', extraMs: sanitized.extraMs, triggeredByVoice: false });
    log(`Temps prolongé manuellement de ${Math.round(sanitized.extraMs / 60000)} min`);
  });

  return handlers;
}

module.exports = { createHandlers };
