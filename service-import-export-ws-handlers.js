'use strict';

/**
 * service-import-export-ws-handlers.js — Handlers WS d'import/export de
 * service (Phase 2 — modularisation du dispatch WS de server.js, même
 * chantier que media-ws-handlers.js et les extractions de catégorie qui
 * l'ont suivi).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * importPptxSlides/exportService/importService. Délibérément laissé de
 * côté lors de l'extraction de scene-ws-handlers.js (ces trois actions
 * créent/touchent des scènes mais ont un jeu de dépendances distinct —
 * task-queue.js/pptx-importer.js/service-export.js/service-import.js —
 * plutôt qu'un CRUD scène simple).
 *
 * sourcePath/destPath viennent du sélecteur de fichier natif Electron
 * (main.js#pick-pptx-file / pick-export-zip-path / pick-import-zip-path),
 * jamais un chemin construit librement par l'UI.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.importJobQueue - concurrence 1, voir task-queue.js
 * @param {object} ctx.fs - Node `fs` (fs.promises.readFile)
 * @param {object} ctx.pptxImporter
 * @param {object} ctx.sceneStore
 * @param {object} ctx.serviceExport
 * @param {object} ctx.serviceImport
 * @param {object} ctx.rundownStore
 * @param {object} ctx.mediaLibrary
 * @param {object} ctx.songLibrary
 * @param {string} ctx.userDataDir - USER_DATA_DIR
 * @param {() => number} ctx.getCurrentRundownIndex
 * @param {(scene: object) => object} ctx.resolveSceneMediaUrls
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    importJobQueue,
    fs,
    pptxImporter,
    sceneStore,
    serviceExport,
    serviceImport,
    rundownStore,
    mediaLibrary,
    songLibrary,
    userDataDir,
    getCurrentRundownIndex,
    resolveSceneMediaUrls,
    broadcast,
    log,
  } = ctx;

  const handlers = new Map();

  // AJOUT (Partie 7.1.1 — import PowerPoint, texte seul, voir
  // pptx-importer.js pour la portée assumée) : sourcePath vient du
  // sélecteur natif main.js#pick-pptx-file, jamais un chemin envoyé
  // librement par le client (même garde que pick-media-file).
  handlers.set('importPptxSlides', async (ws, sanitized) => {
    try {
      // CORRECTIF (modularisation backend — perf) : fs.readFileSync()
      // bloquait tout le thread JS (pipeline audio/transcription inclus) le
      // temps de lire le fichier .pptx entier depuis le disque. Lecture
      // async + passage par task-queue.js (concurrence 1) : le handler WS
      // reste réactif pendant la lecture, et deux imports PowerPoint
      // lancés coup sur coup s'exécutent en séquence plutôt qu'en
      // parallèle. Réponse/erreur envoyées au client inchangées — un seul
      // message pptxImportResult ou error, comme avant.
      const { slidesFound, scenesCreated } = await importJobQueue.enqueue(async () => {
        const buf = await fs.promises.readFile(sanitized.sourcePath);
        const slides = pptxImporter.extractPptxSlidesText(buf);
        let created = 0;
        for (const slide of slides) {
          if (!slide.text.trim()) continue; // diapositive sans texte (image seule, séparateur...) : ignorée, pas une scène vide
          sceneStore.addScene({
            name: `Diapositive ${slide.slideIndex}`,
            background: { type: 'none' },
            elements: [{ type: 'text', text: slide.text }],
          });
          created++;
        }
        return { slidesFound: slides.length, scenesCreated: created };
      });
      log(
        `Import PowerPoint : ${scenesCreated} scène(s) créée(s) sur ${slidesFound} diapositive(s)`
      );
      broadcast(
        {
          action: 'sceneLibraryUpdated',
          scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
        },
        { operatorOnly: true }
      );
      ws.send(JSON.stringify({ action: 'pptxImportResult', slidesFound, scenesCreated }));
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Import PowerPoint : ' + err.message }));
    }
  });

  // AJOUT (Partie 7.1.2 — service portable, EXPORT uniquement, voir
  // service-export.js en tête pour le pourquoi de cette portée) : destPath
  // vient du sélecteur natif main.js#pick-export-zip-path, jamais un
  // chemin envoyé librement par le client (même garde que sourcePath pour
  // importPptxSlides ci-dessus).
  handlers.set('exportService', async (ws, sanitized) => {
    try {
      const summary = await serviceExport.exportService(
        sanitized.destPath,
        { rundownStore, sceneStore, mediaLibrary, songLibrary },
        userDataDir
      );
      log(
        `Export service : ${summary.mediaCount} média(s), ${summary.sceneCount} scène(s), ${summary.rundownCount} repère(s), ${summary.songCount} chant(s) -> ${sanitized.destPath}`
      );
      ws.send(JSON.stringify({ action: 'serviceExportResult', ...summary }));
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Export du service : ' + err.message }));
    }
  });

  // AJOUT (Partie 7.1.2 — service portable, IMPORT, voir service-import.js
  // en tête pour la protection zip slip) : sourcePath vient du sélecteur
  // natif main.js#pick-import-zip-path, jamais un chemin envoyé librement
  // par le client (même garde que pour exportService/importPptxSlides).
  handlers.set('importService', async (ws, sanitized) => {
    try {
      const summary = await serviceImport.importService(sanitized.sourcePath, {
        mediaLibrary,
        sceneStore,
        songLibrary,
        rundownStore,
      });
      log(
        `Import service : ${summary.mediaImported} média(s) (${summary.mediaSkipped} sauté(s)), ${summary.scenesImported} scène(s) (${summary.scenesSkipped} sautée(s)), ${summary.songsImported} chant(s) (${summary.songsSkipped} sauté(s)), ${summary.cuesImported} repère(s) (${summary.cuesSkipped} sauté(s)) <- ${sanitized.sourcePath}`
      );
      broadcast(
        { action: 'mediaLibraryUpdated', items: mediaLibrary.listItems() },
        { operatorOnly: true }
      );
      broadcast(
        {
          action: 'sceneLibraryUpdated',
          scenes: sceneStore.listItems().map(resolveSceneMediaUrls),
        },
        { operatorOnly: true }
      );
      broadcast(
        { action: 'songLibraryUpdated', songs: songLibrary.listSongs() },
        { operatorOnly: true }
      );
      broadcast({
        action: 'rundownUpdated',
        cues: rundownStore.listCues(),
        activeIndex: getCurrentRundownIndex(),
      });
      ws.send(JSON.stringify({ action: 'serviceImportResult', ...summary }));
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Import du service : ' + err.message }));
    }
  });

  return handlers;
}

module.exports = { createHandlers };
