'use strict';

/**
 * rundown-ws-handlers.js — Handlers WS de la feuille de route/cue-list
 * (Phase 2 — modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js/scene-ws-handlers.js/song-ws-handlers.js).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) : getRundown/
 * addRundownCue/removeRundownCue/reorderRundownCues/clearRundown/
 * triggerRundownCue/nextRundownCue.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * getCurrentRundownIndex/setCurrentRundownIndex sont des GETTER/SETTER (pas
 * la valeur) : currentRundownIndex est un `let` de server.js, lu ET écrit
 * par CES handlers eux-mêmes (quel repère est "actif") — server.js le lit
 * aussi, ailleurs (importService), donc la valeur doit rester la même
 * variable partagée, pas une copie locale à ce module.
 *
 * @param {object} ctx
 * @param {object} ctx.rundownStore
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {() => number} ctx.getCurrentRundownIndex
 * @param {(index: number) => void} ctx.setCurrentRundownIndex
 * @param {(cue: object) => Promise<{ok: boolean, error?: string}>} ctx.executeCue
 *   - déclenche un repère (verset/média/scène), quel que soit son type ;
 *   reste défini dans server.js (dépendances propres : detector, bibleLookup,
 *   sessionState, mediaLibrary, sceneStore, resolveSceneMediaUrls...)
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    rundownStore,
    broadcast,
    log,
    getCurrentRundownIndex,
    setCurrentRundownIndex,
    executeCue,
  } = ctx;

  const handlers = new Map();

  handlers.set('getRundown', async (ws) => {
    ws.send(
      JSON.stringify({
        action: 'rundownUpdated',
        cues: rundownStore.listCues(),
        activeIndex: getCurrentRundownIndex(),
      })
    );
  });

  handlers.set('addRundownCue', async (ws, sanitized) => {
    try {
      const cue = rundownStore.addCue({
        type: sanitized.type,
        label: sanitized.label,
        reference: sanitized.reference,
        mediaId: sanitized.mediaId,
        sceneId: sanitized.sceneId,
      });
      setCurrentRundownIndex(-1);
      log(`Feuille de route : repère "${cue.label}" ajouté (${cue.type})`);
      broadcast({
        action: 'rundownUpdated',
        cues: rundownStore.listCues(),
        activeIndex: getCurrentRundownIndex(),
      });
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: err.message }));
    }
  });

  handlers.set('removeRundownCue', async (ws, sanitized) => {
    const removed = rundownStore.removeCue(sanitized.id);
    if (removed) {
      setCurrentRundownIndex(-1);
      broadcast({
        action: 'rundownUpdated',
        cues: rundownStore.listCues(),
        activeIndex: getCurrentRundownIndex(),
      });
    }
  });

  handlers.set('reorderRundownCues', async (ws, sanitized) => {
    rundownStore.reorderCues(Array.isArray(sanitized.orderedIds) ? sanitized.orderedIds : []);
    setCurrentRundownIndex(-1);
    broadcast({
      action: 'rundownUpdated',
      cues: rundownStore.listCues(),
      activeIndex: getCurrentRundownIndex(),
    });
  });

  handlers.set('clearRundown', async () => {
    rundownStore.clearCues();
    setCurrentRundownIndex(-1);
    log('Feuille de route : vidée');
    broadcast({ action: 'rundownUpdated', cues: [], activeIndex: -1 });
  });

  handlers.set('triggerRundownCue', async (ws, sanitized) => {
    const cues = rundownStore.listCues();
    const idx = cues.findIndex((c) => c.id === sanitized.id);
    if (idx === -1) {
      ws.send(JSON.stringify({ action: 'error', error: 'Feuille de route : repère introuvable' }));
      return;
    }
    const result = await executeCue(cues[idx]);
    setCurrentRundownIndex(idx);
    broadcast({ action: 'rundownActiveCue', id: cues[idx].id, index: idx });
    if (!result.ok) {
      ws.send(JSON.stringify({ action: 'error', error: result.error }));
    }
  });

  handlers.set('nextRundownCue', async (ws) => {
    const cues = rundownStore.listCues();
    const nextIdx = getCurrentRundownIndex() + 1;
    if (nextIdx >= cues.length) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error:
            cues.length === 0
              ? 'Feuille de route vide.'
              : 'Fin de la feuille de route — aucun repère suivant.',
        })
      );
      return;
    }
    const result = await executeCue(cues[nextIdx]);
    setCurrentRundownIndex(nextIdx);
    broadcast({ action: 'rundownActiveCue', id: cues[nextIdx].id, index: nextIdx });
    if (!result.ok) {
      ws.send(JSON.stringify({ action: 'error', error: result.error }));
    }
  });

  return handlers;
}

module.exports = { createHandlers };
