'use strict';

/**
 * scene-ws-handlers.js — Handlers WS du studio de scènes (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js/http-routes.js/phone-camera-routes.js).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * getSceneLibrary/addScene/updateScene/deleteScene/setDefaultScene/
 * triggerScene/hideScene.
 *
 * NE couvre PAS : importPptxSlides/exportService/importService, qui créent
 * ou touchent aussi des scènes mais restent dans server.js (dépendances
 * différentes — task-queue.js/pptx-importer.js/service-export.js/
 * service-import.js — et catégorie séparée dans une future extraction
 * "import/export de service").
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.sceneStore
 * @param {object} ctx.mediaLibrary - arbitrage croisé poster média/scène
 *   (setDefaultScene démarque silencieusement un média par défaut existant,
 *   et vice-versa côté media-ws-handlers.js#setDefaultMediaItem)
 * @param {object} ctx.sessionStore
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {(scene: object) => object} ctx.resolveSceneMediaUrls - convertit
 *   une scène stockée (mediaId nus) en payload prêt à l'emploi côté client
 *   (mediaUrl résolues) ; reste défini dans server.js (aussi utilisée par
 *   les handlers média non extraits ici, ex. importPptxSlides)
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { sceneStore, mediaLibrary, sessionStore, broadcast, log, resolveSceneMediaUrls } = ctx;

  const handlers = new Map();

  handlers.set('getSceneLibrary', async (ws, sanitized, requestId) => {
    ws.send(
      JSON.stringify({
        action: 'sceneLibraryUpdated',
        scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
        ...(requestId ? { requestId } : {}),
      })
    );
  });

  handlers.set('addScene', async (ws, sanitized) => {
    try {
      const scene = sceneStore.addScene({
        name: sanitized.name,
        background: sanitized.background,
        elements: sanitized.elements,
        triggerPhrases: sanitized.triggerPhrases,
      });
      log(`Studio de scènes : "${scene.name}" créée`);
      broadcast(
        {
          action: 'sceneLibraryUpdated',
          scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
        },
        { operatorOnly: true }
      );
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Studio de scènes : ' + err.message }));
    }
  });

  handlers.set('updateScene', async (ws, sanitized) => {
    const updated = sceneStore.updateScene(sanitized.id, {
      name: sanitized.name,
      background: sanitized.background,
      elements: sanitized.elements,
      triggerPhrases: sanitized.triggerPhrases,
    });
    if (updated) {
      log(`Studio de scènes : "${updated.name}" mise à jour`);
      broadcast(
        {
          action: 'sceneLibraryUpdated',
          scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
        },
        { operatorOnly: true }
      );
    } else {
      ws.send(JSON.stringify({ action: 'error', error: 'Studio de scènes : scène introuvable' }));
    }
  });

  handlers.set('deleteScene', async (ws, sanitized) => {
    const wasDefault = !!(sceneStore.getItem(sanitized.id) || {}).isDefault;
    const removed = sceneStore.deleteItem(sanitized.id);
    if (removed) {
      broadcast(
        {
          action: 'sceneLibraryUpdated',
          scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
        },
        { operatorOnly: true }
      );
      // Même raisonnement que deleteMediaItem (media-ws-handlers.js) : la
      // scène par défaut supprimée ne doit pas rester "fantôme" côté overlay.
      if (wasDefault) broadcast({ action: 'defaultSceneChanged', item: null });
    } else {
      ws.send(JSON.stringify({ action: 'error', error: 'Studio de scènes : scène introuvable' }));
    }
  });

  // --- Poster principal (scène) — voir setDefaultScene() dans
  // scene-store.js. sanitized.id absent/vide = retire le poster principal
  // (scène) actuel sans en désigner un nouveau. ---
  handlers.set('setDefaultScene', async (ws, sanitized) => {
    const updated = sanitized.id
      ? sceneStore.setDefaultScene(sanitized.id)
      : sceneStore.clearDefaultScene();
    if (sanitized.id && !updated) {
      ws.send(JSON.stringify({ action: 'error', error: 'Studio de scènes : scène introuvable' }));
      return;
    }
    log(
      sanitized.id
        ? `Studio de scènes : "${updated.name}" désignée comme poster principal`
        : 'Studio de scènes : poster principal (scène) retiré'
    );
    broadcast(
      {
        action: 'sceneLibraryUpdated',
        scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
      },
      { operatorOnly: true }
    );
    // AJOUT (studio de scènes, lot 4) : resolveSceneMediaUrls() ici, PAS
    // l'item brut du store (mediaId nus, inexploitables tels quels par
    // renderSceneDom() côté overlay.html) — même besoin de résolution que
    // triggerScene ci-dessous.
    const newDefaultScene = sceneStore.getDefaultScene();
    broadcast({
      action: 'defaultSceneChanged',
      item: newDefaultScene ? resolveSceneMediaUrls(newDefaultScene) : null,
    });
    // AJOUT (arbitrage croisé, lot 2) : désigner une scène par défaut
    // démarque silencieusement tout média par défaut existant
    // (scene-store.js#setDefaultScene) — symétrique au correctif du même
    // nom sur setDefaultMediaItem (media-ws-handlers.js).
    if (sanitized.id) {
      broadcast(
        { action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() },
        { operatorOnly: true }
      );
      broadcast({ action: 'defaultMediaChanged', item: mediaLibrary.getDefaultItem() });
    }
  });

  // AJOUT (studio de scènes, lot 4/6 — déclenchement à l'écran) : miroir de
  // triggerMediaItem/hideMedia (media-ws-handlers.js), distinct de
  // setDefaultScene (poster PERSISTANT) — un déclenchement ponctuel, comme
  // un média manuel. Résout CHAQUE mediaId référencé (fond + éléments
  // image) en URL `/media/<filename>` ICI, côté serveur — jamais confiance
  // au tableau de bord pour avoir une URL à jour. Un mediaId dont l'élément
  // a été supprimé de la médiathèque se dégrade proprement (mediaUrl omis
  // pour cet élément seul) plutôt que de faire planter la diffusion entière.
  handlers.set('triggerScene', async (ws, sanitized, requestId, sendError) => {
    const scene = sceneStore.getItem(sanitized.id);
    if (!scene) {
      sendError('Studio de scènes : scène introuvable');
      return;
    }
    log(`Studio de scènes : "${scene.name}" déclenchée manuellement`);
    broadcast({
      action: 'showScene',
      ...resolveSceneMediaUrls(scene),
      detectedBy: 'manual',
      ...(requestId ? { requestId } : {}),
    });
    sessionStore.recordVerseShown({
      reference: `🎬 ${scene.name}`,
      detectedBy: 'scene',
      timestamp: Date.now(),
    });
  });

  handlers.set('hideScene', async (ws, sanitized, requestId) => {
    const hideScenePayload = { action: 'hideScene' };
    if (requestId) hideScenePayload.requestId = requestId;
    broadcast(hideScenePayload);
  });

  return handlers;
}

module.exports = { createHandlers };
