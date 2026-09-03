'use strict';

/**
 * misc-ws-handlers.js — Handlers WS restants sans catégorie dédiée
 * (Phase 2 — modularisation du dispatch WS de server.js, dernier lot de
 * cette extraction par catégorie, même chantier que media-ws-handlers.js
 * et toutes celles qui l'ont précédé).
 *
 * Regroupe ce qui n'avait pas assez en commun avec une catégorie déjà
 * extraite pour justifier son propre module : injection manuelle de
 * transcript (test/débogage), seuil de confiance ASR, recherche
 * sémantique biblique, messages opérateur en régie (stage display), ping.
 *
 * Extrait tel quel (comportement identique, seulement déplacé) : transcript/
 * setConfidenceThreshold/searchBible/sendStageMessage/clearStageMessage/ping.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {(msg: string) => void} ctx.log
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(text: string, tracker?: object, opts?: object) => Promise<void>} ctx.enqueueTranscript
 * @param {object} ctx.featuresStore
 * @param {object|null} ctx.semanticSearch
 * @param {(text: string) => string} ctx.sanitizeForPrompt
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { log, broadcast, enqueueTranscript, featuresStore, semanticSearch, sanitizeForPrompt } =
    ctx;

  const handlers = new Map();

  handlers.set('transcript', async (ws, sanitized) => {
    const text = String(sanitized.text || '').trim();
    if (text) {
      log(`WebSocket transcript received: "${text.substring(0, 80)}"`);
      broadcast({
        action: 'transcript',
        text,
        timestamp: Date.now(),
        source: sanitized.source || 'browser',
      });
      await enqueueTranscript(text);
    }
  });

  // --- Confidence threshold ---
  handlers.set('setConfidenceThreshold', async (ws, sanitized) => {
    const val = Number(sanitized.threshold);
    if (typeof val === 'number' && val >= 0 && val <= 1) {
      const rounded = Math.round(val * 100) / 100;
      // Persister dans features.json pour que getTranscriptionConfidenceThreshold() le lit
      const features = featuresStore.readFeatures();
      if (!features.audio) features.audio = {};
      features.audio.transcriptionConfidenceThreshold = rounded > 0 ? rounded : 0;
      featuresStore.writeFeatures(features);
      broadcast({ action: 'confidenceThresholdChanged', threshold: rounded });
      log('Seuil de confiance mis à jour : ' + rounded);
    }
  });

  // --- Bible Semantic Search ---
  handlers.set('searchBible', async (ws, sanitized, requestId, sendError) => {
    if (!semanticSearch) {
      ws.send(
        JSON.stringify({
          action: 'searchError',
          error: 'Recherche biblique non disponible',
          ...(requestId ? { requestId } : {}),
        })
      );
      return;
    }
    const query = String(sanitized.query || '').trim();
    if (!query) {
      sendError('Requête requise.');
      return;
    }
    try {
      const results = await semanticSearch.search(query, sanitized.topK || 5);
      ws.send(
        JSON.stringify({
          action: 'searchResults',
          query,
          results,
          timestamp: Date.now(),
          ...(requestId ? { requestId } : {}),
        })
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          action: 'searchError',
          query,
          error: err.message,
          ...(requestId ? { requestId } : {}),
        })
      );
    }
  });

  // --- Stage display : messages opérateur visibles uniquement côté scène,
  // jamais sur l'overlay public (voir stage-display.html) ---
  handlers.set('sendStageMessage', async (ws, sanitized) => {
    const text = sanitizeForPrompt((sanitized.text || '').slice(0, 500));
    broadcast({ action: 'stageMessage', text, timestamp: Date.now() });
  });

  handlers.set('clearStageMessage', async () => {
    broadcast({ action: 'stageMessageClear' });
  });

  // AJOUT (audit fonctionnel — training-mode.js envoyait 'trainingModeChanged'
  // sans qu'aucun handler n'existe : rejeté comme action inconnue à chaque
  // Ctrl+Shift+T). Signalement d'état pur, aucun effet côté serveur — le
  // mode formation reste entièrement piloté côté client (voir
  // dashboard/features/training-mode.js) ; juste de quoi tracer dans les
  // journaux qui a activé/désactivé le mode formation et quand.
  handlers.set('trainingModeChanged', async (ws, sanitized) => {
    log(`Mode formation : ${sanitized.enabled ? 'activé' : 'désactivé'}`);
  });

  // --- Ping ---
  handlers.set('ping', async (ws) => {
    ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
  });

  return handlers;
}

module.exports = { createHandlers };
