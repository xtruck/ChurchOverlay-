'use strict';

/**
 * media-ws-handlers.js — Handlers WS de la médiathèque (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * http-routes.js/phone-camera-routes.js/session-state.js).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) : getMediaLibrary/
 * testTriggerPhrase/addMediaItem/updateMediaItem/setDefaultMediaItem/
 * deleteMediaItem/triggerMediaItem/hideMedia, et la famille groupes
 * (getMediaGroups/addMediaGroup/deleteMediaGroup/setMediaItemGroup).
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — requestId/sendError viennent du message en cours (voir server.js, message
 * handler), pas de ce module ; sendError(error) échoie déjà requestId si présent.
 *
 * createHandlers(ctx) retourne une Map<action, handler> plutôt que d'exporter
 * les handlers un par un : server.js fusionne les Maps de tous les modules
 * de handlers extraits dans une seule table de dispatch (voir CATEGORY_HANDLERS).
 *
 * @param {object} ctx
 * @param {object} ctx.mediaLibrary
 * @param {object} ctx.songLibrary - testTriggerPhrase() vérifie aussi les chants
 * @param {object} ctx.sceneStore - testTriggerPhrase() vérifie aussi les scènes
 * @param {object} ctx.voiceTriggerMatcher
 * @param {object} ctx.sessionStore
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {(scene: object) => object} ctx.resolveSceneMediaUrls - pour l'arbitrage
 *   croisé poster média/scène dans setDefaultMediaItem (voir scene-ws-handlers.js,
 *   pas encore extrait au moment d'écrire ce module — reste dans server.js)
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    mediaLibrary,
    songLibrary,
    sceneStore,
    voiceTriggerMatcher,
    sessionStore,
    broadcast,
    log,
    resolveSceneMediaUrls,
  } = ctx;

  const handlers = new Map();

  // --- Médiathèque (déclenchement vocal de photos/vidéos) ---------------
  // Réponse directe au demandeur (ws.send) pour la lecture/mutation de la
  // liste, même convention que getArchiveMatches/getSessionStats (server.js) ;
  // broadcast() uniquement pour ce que TOUS les clients (overlay compris)
  // doivent voir (affichage/masquage réel, mise à jour de la liste pour
  // les autres tableaux de bord éventuellement ouverts).
  handlers.set('getMediaLibrary', async (ws, sanitized, requestId) => {
    ws.send(
      JSON.stringify({
        action: 'mediaLibraryUpdated',
        items: mediaLibrary.listItems(),
        ...(requestId ? { requestId } : {}),
      })
    );
  });

  // AJOUT (Partie 2.3 — Mur Média, bouton "essayer") : rejoue EXACTEMENT le
  // même chemin que la détection vocale réelle (mediaLibrary/songLibrary/
  // sceneStore.matchTriggerPhrase, dans le même ordre que processTranscript
  // dans server.js) sur un texte tapé au clavier — permet de vérifier
  // AVANT le culte qu'une phrase déclencheuse fonctionne vraiment, sans
  // attendre de la dire en plein direct. Honnête par construction : ce
  // n'est pas une simulation séparée qui pourrait diverger du
  // comportement réel, c'est le même code.
  handlers.set('testTriggerPhrase', async (ws, sanitized) => {
    const text = String(sanitized.text || '').trim();
    if (!text) {
      ws.send(JSON.stringify({ action: 'triggerPhraseTestResult', matched: false, text }));
      return;
    }
    let result = { matched: false, kind: null, label: null, text };
    const mediaMatch = mediaLibrary.matchTriggerPhrase(text);
    if (mediaMatch) {
      result = { matched: true, kind: 'media', label: mediaMatch.label, text };
    } else {
      // AJOUT (Partie 2.3 — groupes) : dryRun:true — un test "essayer" ne
      // doit jamais consommer un tour de rotation destiné au vrai culte
      // (voir matchGroupTriggerPhrase dans media-library.js).
      const groupMatch = mediaLibrary.matchGroupTriggerPhrase(text, { dryRun: true });
      if (groupMatch) {
        result = {
          matched: true,
          kind: 'media',
          label: `${groupMatch.label} (groupe, prochain à tour de rôle)`,
          text,
        };
      } else {
        const songMatch = songLibrary.matchTriggerPhrase(text);
        if (songMatch) {
          result = {
            matched: true,
            kind: 'song',
            label: `${songMatch.song.title} — ${songMatch.song.sections[songMatch.sectionIndex]?.label || ''}`,
            text,
          };
        } else {
          const sceneMatch = sceneStore.matchTriggerPhrase(text);
          if (sceneMatch) {
            result = { matched: true, kind: 'scene', label: sceneMatch.name, text };
          }
        }
      }
    }
    ws.send(JSON.stringify({ action: 'triggerPhraseTestResult', ...result }));
  });

  handlers.set('addMediaItem', async (ws, sanitized) => {
    try {
      // AJOUT (Partie 2.3 — Mur Média, collisions phonétiques "dès
      // l'import") : vérifié AVANT l'ajout (le nouvel élément n'existe pas
      // encore, pas besoin de s'auto-exclure). Combine médiathèque ET
      // bibliothèque de chants : une phrase déclencheuse qui collisionne
      // avec un chant existant est tout aussi dangereuse en plein culte
      // qu'une collision interne à la médiathèque — les deux partagent le
      // même moteur de détection vocale. Non bloquant : averti,
      // l'opérateur reste libre d'ajouter quand même (ex. collision jugée
      // acceptable, ou fausse alerte).
      const candidatePhrases = Array.isArray(sanitized.triggerPhrases)
        ? sanitized.triggerPhrases
        : sanitized.label
          ? [sanitized.label]
          : [];
      const collisions = mediaLibrary
        .checkTriggerCollisions(candidatePhrases)
        .concat(
          voiceTriggerMatcher.findPhoneticCollisions(candidatePhrases, songLibrary.listSongs())
        );

      let item = mediaLibrary.addItem({
        sourcePath: sanitized.sourcePath,
        label: sanitized.label,
        triggerPhrases: sanitized.triggerPhrases,
        displayDurationMs: sanitized.displayDurationMs,
        includeInLoop: sanitized.includeInLoop,
        transitionStyle: sanitized.transitionStyle,
      });
      log(`Médiathèque : "${item.label}" ajouté (${item.mediaType})`);
      if (collisions.length > 0) {
        log(
          `Médiathèque : ${collisions.length} collision(s) phonétique(s) détectée(s) pour "${item.label}"`
        );
        ws.send(
          JSON.stringify({
            action: 'mediaTriggerCollisions',
            itemId: item.id,
            itemLabel: item.label,
            collisions: collisions.map((c) => ({
              phrase: c.phrase,
              withLabel: c.withItem.label || c.withItem.title,
              withPhrase: c.withPhrase,
              distance: c.distance,
              exact: c.exact,
            })),
          })
        );
      }
      // CORRECTIF (poster principal — "le poster ne revient pas après un
      // verset") : une image sans durée explicite reçoit silencieusement
      // DEFAULT_IMAGE_DURATION_MS (15s, voir media-library.js#addItem) — un
      // opérateur qui uploade un nouveau poster chaque semaine et clique
      // juste "Afficher" obtenait donc un média qui disparaissait tout seul
      // après 15 secondes, sans jamais revenir (rien n'était marqué
      // isDefault, le seul état que maybeShowDefaultMedia() sait ramener à
      // l'écran — voir overlay.html). Cocher "Poster" dans le formulaire
      // d'ajout (dashboard/features/media-library.js) fait maintenant en un
      // seul geste ce qui exigeait avant un second clic sur l'étoile ⭐
      // APRÈS l'ajout — facile à oublier, et la cause réelle du bug signalé.
      if (sanitized.setAsPoster) {
        item = mediaLibrary.setDefaultItem(item.id) || item;
        broadcast({ action: 'defaultMediaChanged', item: mediaLibrary.getDefaultItem() });
      }
      broadcast({ action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() });
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Médiathèque : ' + err.message }));
    }
  });

  // --- Détails d'affichage média (durée/style) — voir updateItem() dans
  // media-library.js. Pour les médias DÉJÀ uploadés, sans les re-uploader. ---
  handlers.set('updateMediaItem', async (ws, sanitized) => {
    const displayDurationMs =
      sanitized.displayDurationMs === null || sanitized.displayDurationMs === 0
        ? null
        : sanitized.displayDurationMs;
    const updated = mediaLibrary.updateItem(sanitized.id, {
      displayDurationMs,
      transitionStyle: sanitized.transitionStyle,
    });
    if (updated) {
      log(`Médiathèque : détails d'affichage mis à jour pour "${updated.label}"`);
      broadcast({ action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() });
    } else {
      ws.send(JSON.stringify({ action: 'error', error: 'Médiathèque : élément introuvable' }));
    }
  });

  // --- Poster principal (voir setDefaultItem() dans media-library.js) :
  // affiché automatiquement dès que rien d'autre n'est à l'écran — voir
  // maybeShowDefaultMedia() côté overlay.html. sanitized.id absent/vide =
  // retire le poster principal actuel sans en désigner un nouveau. ---
  handlers.set('setDefaultMediaItem', async (ws, sanitized) => {
    const updated = sanitized.id
      ? mediaLibrary.setDefaultItem(sanitized.id)
      : mediaLibrary.clearDefaultItem();
    if (sanitized.id && !updated) {
      ws.send(JSON.stringify({ action: 'error', error: 'Médiathèque : élément introuvable' }));
      return;
    }
    log(
      sanitized.id
        ? `Médiathèque : "${updated.label}" désigné comme poster principal`
        : 'Médiathèque : poster principal retiré'
    );
    broadcast({ action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() });
    broadcast({ action: 'defaultMediaChanged', item: mediaLibrary.getDefaultItem() });
    // AJOUT (studio de scènes, lot 3 — arbitrage croisé, voir lot 2) :
    // désigner un média par défaut démarque silencieusement toute scène par
    // défaut existante (media-library.js#setDefaultItem) — sans ces deux
    // diffusions, un tableau de bord resterait persuadé qu'une scène déjà
    // démarquée côté serveur est toujours le poster principal.
    if (sanitized.id) {
      broadcast({
        action: 'sceneLibraryUpdated',
        scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
      });
      broadcast({ action: 'defaultSceneChanged', item: sceneStore.getDefaultScene() });
    }
  });

  handlers.set('deleteMediaItem', async (ws, sanitized) => {
    const wasDefault = !!(mediaLibrary.getItem(sanitized.id) || {}).isDefault;
    const removed = mediaLibrary.deleteItem(sanitized.id);
    if (removed) {
      broadcast({ action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() });
      // Le poster principal supprimé ne doit pas rester "fantôme" côté
      // overlay (URL cassée réaffichée à la prochaine minute d'inactivité).
      if (wasDefault) broadcast({ action: 'defaultMediaChanged', item: null });
    } else {
      ws.send(JSON.stringify({ action: 'error', error: 'Médiathèque : élément introuvable' }));
    }
  });

  handlers.set('triggerMediaItem', async (ws, sanitized, requestId, sendError) => {
    const item = mediaLibrary.getItem(sanitized.id);
    if (!item) {
      sendError('Médiathèque : élément introuvable');
      return;
    }
    log(`Médiathèque : "${item.label}" déclenché manuellement`);
    broadcast({
      action: 'showMedia',
      id: item.id,
      mediaType: item.mediaType,
      mediaUrl: `/media/${item.filename}`,
      label: item.label,
      displayDurationMs: item.displayDurationMs,
      transitionStyle: item.transitionStyle,
      detectedBy: 'manual',
      ...(requestId ? { requestId } : {}),
    });
    sessionStore.recordVerseShown({
      reference: `📷 ${item.label}`,
      detectedBy: 'media',
      timestamp: Date.now(),
    });
  });

  handlers.set('hideMedia', async (ws, sanitized, requestId) => {
    const hideMediaPayload = { action: 'hideMedia' };
    if (requestId) hideMediaPayload.requestId = requestId;
    broadcast(hideMediaPayload);
  });

  // ---------------------------------------------------------------------
  // AJOUT (Partie 2.3 — groupes nommés déclenchables à la voix) : un média
  // ne peut appartenir qu'à un seul groupe (voir setItemGroup dans
  // media-library.js) ; dire la phrase déclencheuse du groupe affiche le
  // membre suivant, en rotation (voir matchGroupTriggerPhrase, câblé dans
  // processTranscript de server.js, juste après la détection média
  // individuelle).
  // ---------------------------------------------------------------------
  handlers.set('getMediaGroups', async (ws) => {
    ws.send(JSON.stringify({ action: 'mediaGroupsUpdated', groups: mediaLibrary.listGroups() }));
  });

  handlers.set('addMediaGroup', async (ws, sanitized) => {
    try {
      const candidatePhrases = Array.isArray(sanitized.triggerPhrases)
        ? sanitized.triggerPhrases
        : sanitized.name
          ? [sanitized.name]
          : [];
      // Même vérification "dès l'import" que pour un média (voir
      // addMediaItem ci-dessus) : la phrase d'un groupe partage le même
      // moteur de détection que les médias/chants individuels.
      const collisions = mediaLibrary
        .checkTriggerCollisions(candidatePhrases)
        .concat(
          voiceTriggerMatcher.findPhoneticCollisions(candidatePhrases, songLibrary.listSongs())
        )
        .concat(
          voiceTriggerMatcher.findPhoneticCollisions(candidatePhrases, mediaLibrary.listGroups())
        );
      const group = mediaLibrary.addGroup({
        name: sanitized.name,
        triggerPhrases: sanitized.triggerPhrases,
      });
      log(`Médiathèque : groupe "${group.name}" créé`);
      if (collisions.length > 0) {
        ws.send(
          JSON.stringify({
            action: 'mediaTriggerCollisions',
            itemId: group.id,
            itemLabel: group.name,
            collisions: collisions.map((c) => ({
              phrase: c.phrase,
              withLabel: c.withItem.label || c.withItem.title || c.withItem.name,
              withPhrase: c.withPhrase,
              distance: c.distance,
              exact: c.exact,
            })),
          })
        );
      }
      broadcast({ action: 'mediaGroupsUpdated', groups: mediaLibrary.listGroups() });
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Groupe média : ' + err.message }));
    }
  });

  handlers.set('deleteMediaGroup', async (ws, sanitized) => {
    const removed = mediaLibrary.deleteGroup(sanitized.id);
    if (removed) {
      broadcast({ action: 'mediaGroupsUpdated', groups: mediaLibrary.listGroups() });
      broadcast({ action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() });
    } else {
      ws.send(JSON.stringify({ action: 'error', error: 'Groupe média : introuvable' }));
    }
  });

  handlers.set('setMediaItemGroup', async (ws, sanitized) => {
    const ok = mediaLibrary.setItemGroup(sanitized.itemId, sanitized.groupId || null);
    if (ok) {
      broadcast({ action: 'mediaGroupsUpdated', groups: mediaLibrary.listGroups() });
      broadcast({ action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() });
    } else {
      ws.send(
        JSON.stringify({ action: 'error', error: 'Groupe média : média ou groupe introuvable' })
      );
    }
  });

  return handlers;
}

module.exports = { createHandlers };
