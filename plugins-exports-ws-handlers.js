'use strict';

/**
 * plugins-exports-ws-handlers.js — Handlers WS des plugins et des exports
 * (temps forts/extraits vidéo) (Phase 2 — modularisation du dispatch WS de
 * server.js, même chantier que media-ws-handlers.js et les extractions de
 * catégorie qui l'ont suivi).
 *
 * Deux petites catégories d'outillage secondaire regroupées dans un seul
 * module (accédées depuis les mêmes panneaux "Réglages"/préparation, sans
 * dépendances communes particulières au-delà de broadcast/log/sessionStore).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * exportHighlights/exportClips/listPlugins/togglePlugin.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * getClipExportInProgress/setClipExportInProgress sont des GETTER/SETTER
 * (pas la valeur) : clipExportInProgress est un `let` de server.js, une
 * garde simple contre deux exports concurrents — doit rester LA MÊME
 * variable partagée, pas une copie locale à ce module.
 *
 * @param {object} ctx
 * @param {object} ctx.sessionStore
 * @param {object} ctx.highlightExport
 * @param {object} ctx.clipExporter
 * @param {object|null} ctx.plugins
 * @param {number} ctx.sessionStartedAt - SESSION_STARTED_AT
 * @param {() => boolean} ctx.getClipExportInProgress
 * @param {(value: boolean) => void} ctx.setClipExportInProgress
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    sessionStore,
    highlightExport,
    clipExporter,
    plugins,
    sessionStartedAt,
    getClipExportInProgress,
    setClipExportInProgress,
    broadcast,
    log,
  } = ctx;

  const handlers = new Map();

  // --- Export des temps forts (chapitres YouTube / CSV) — voir
  // highlight-export.js. Réutilise l'historique déjà persistant, aucune
  // nouvelle collecte de données ici. ---
  handlers.set('exportHighlights', async (ws) => {
    try {
      const entries = sessionStore.getVerseHistorySince(sessionStartedAt);
      ws.send(
        JSON.stringify({
          action: 'highlightsExported',
          youtubeChapters: highlightExport.buildYoutubeChapters(entries, sessionStartedAt),
          csv: highlightExport.buildCsv(entries, sessionStartedAt),
          count: entries.length,
        })
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error: "Impossible d'exporter les temps forts : " + err.message,
        })
      );
    }
  });

  // --- Extraits vidéo autour des temps forts (chantier 4.6) ---
  handlers.set('exportClips', async (ws, sanitized) => {
    if (getClipExportInProgress()) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error:
            'Un export de clips est déjà en cours — attendez sa fin avant den lancer un nouveau.',
        })
      );
      return;
    }
    const sourcePath = String(sanitized.sourcePath || '').trim();
    const outputDir = String(sanitized.outputDir || '').trim();
    if (!sourcePath || !outputDir) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error: 'Fichier source et dossier de destination requis.',
        })
      );
      return;
    }
    setClipExportInProgress(true);
    broadcast({ action: 'clipExportStarted' });
    try {
      const entries = sessionStore.getVerseHistorySince(sessionStartedAt);
      const result = await clipExporter.exportClips(
        sourcePath,
        outputDir,
        entries,
        sessionStartedAt,
        {
          clipDurationSec: Number(sanitized.clipDurationSec) || undefined,
          onProgress: (done, total) => broadcast({ action: 'clipExportProgress', done, total }),
        }
      );
      broadcast({
        action: 'clipExportComplete',
        ok: result.ok,
        clips: result.clips,
        errors: result.errors,
        outputDir,
      });
      log(
        `Extraits vidéo : ${result.clips.length} généré(s), ${result.errors.length} échec(s) — ${outputDir}`
      );
    } catch (err) {
      broadcast({
        action: 'error',
        error: "Échec de l'export des extraits vidéo : " + err.message,
      });
    } finally {
      setClipExportInProgress(false);
    }
  });

  // --- Plugin management ---
  handlers.set('listPlugins', async (ws) => {
    ws.send(
      JSON.stringify({ action: 'pluginsList', plugins: plugins ? plugins.getPluginList() : [] })
    );
  });

  handlers.set('togglePlugin', async (ws, sanitized) => {
    if (plugins) {
      plugins.setEnabled(sanitized.pluginName, sanitized.enabled);
      ws.send(
        JSON.stringify({
          action: 'pluginToggled',
          pluginName: sanitized.pluginName,
          enabled: sanitized.enabled,
        })
      );
    }
  });

  return handlers;
}

module.exports = { createHandlers };
