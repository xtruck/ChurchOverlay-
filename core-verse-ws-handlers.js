'use strict';

/**
 * core-verse-ws-handlers.js — Handlers WS de l'affichage central (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js et les extractions de catégorie qui l'ont suivi).
 *
 * Les actions les plus fondamentales de l'app (affichage/masquage manuel
 * de verset, langue, traduction, thème) — regroupées à part des autres
 * catégories déjà extraites car ce sont celles-là, historiquement, autour
 * desquelles tout le reste (mode lecture, feuille de route, commandes
 * vocales) s'articule.
 *
 * Extrait tel quel (comportement identique, seulement déplacé) : showVerse/
 * hideVerse/setLanguage/setTranslation/applyTheme.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js. showVerse est le premier
 * handler extrait qui utilise réellement sendError (déjà supporté par la
 * convention depuis media-ws-handlers.js#triggerMediaItem/
 * scene-ws-handlers.js#triggerScene, jamais exercé côté showVerse jusqu'ici).
 *
 * @param {object} ctx
 * @param {object} ctx.detector
 * @param {object} ctx.sessionState
 * @param {object} ctx.bibleLookup
 * @param {() => number} ctx.getVerseDurationMs
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(entry: object) => void} ctx.pushHistory
 * @param {(msg: string) => void} ctx.log
 * @param {(msg: string) => void} ctx.warn
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    detector,
    sessionState,
    bibleLookup,
    getVerseDurationMs,
    broadcast,
    pushHistory,
    log,
    warn,
  } = ctx;

  const handlers = new Map();

  // --- Manual verse display ---
  handlers.set('showVerse', async (ws, sanitized, requestId, sendError) => {
    const ref = detector.parseReference(sanitized.reference);
    if (!ref) {
      sendError('Référence invalide.');
      return;
    }
    try {
      const displayLang = sessionState.getDisplayLanguage();
      const verse = await bibleLookup.getVerseMultilang(ref, displayLang);
      const durationMs = sanitized.durationMs || getVerseDurationMs();
      const payload = { action: 'showVerse', ...verse, durationMs, triggeredManually: true };
      if (requestId) payload.requestId = requestId;

      // AJOUT (Multi-Bible côte à côte, déclenchement MANUEL uniquement —
      // voir bibleLookup.getVerseDualTranslation) : si une traduction
      // secondaire est configurée (voir setSecondaryTranslation,
      // reading-translation-ws-handlers.js) ET qu'on n'est pas déjà en mode
      // bilingue 'both' (qui affiche déjà 2 textes — un 3e surchargerait
      // l'overlay plutôt que d'aider), récupère AUSSI le verset dans cette
      // traduction pour comparaison. Best-effort strict : un échec ici
      // (réseau, traduction retirée entre-temps...) n'empêche jamais
      // l'affichage du verset principal, il fait juste manquer
      // secondaryText — jamais d'erreur bloquante pour un réglage de confort.
      const secondary = sessionState.getSecondaryTranslation();
      if (secondary && displayLang !== 'both') {
        try {
          const activeEntry = (bibleLookup.listTranslations()[displayLang] || []).find(
            (t) => t.active
          );
          if (activeEntry) {
            const dual = await bibleLookup.getVerseDualTranslation(
              ref,
              { lang: displayLang, code: activeEntry.code },
              secondary
            );
            payload.secondaryText = dual.secondary.text;
            payload.secondaryLabel = dual.secondary.label;
            payload.secondaryLang = dual.secondary.lang;
          }
        } catch (secErr) {
          warn('Traduction secondaire indisponible : ' + secErr.message);
        }
      }

      broadcast(payload);
      pushHistory({ ...verse, triggeredManually: true, timestamp: Date.now() });
      broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
    } catch (err) {
      sendError(err.message);
    }
  });

  // --- Hide overlay ---
  handlers.set('hideVerse', async (ws, sanitized, requestId) => {
    const hidePayload = { action: 'hideVerse' };
    if (requestId) hidePayload.requestId = requestId;
    broadcast(hidePayload);
    sessionState.clearLastReference();
  });

  // --- Language switch ---
  handlers.set('setLanguage', async (ws, sanitized) => {
    const lang = sanitized.language;
    if (['fr', 'en', 'both'].includes(lang)) {
      sessionState.setDisplayLanguage(lang);
      broadcast({ action: 'languageChanged', language: lang });
      log('Language changed: ' + lang);
    }
  });

  // --- Translation switch ---
  handlers.set('setTranslation', async (ws, sanitized) => {
    try {
      const newId = bibleLookup.setTranslation(sanitized.language, sanitized.code);
      broadcast({
        action: 'translationChanged',
        language: sanitized.language,
        code: sanitized.code,
        translationId: newId,
      });
      log(`Translation: ${sanitized.language} → ${sanitized.code}`);
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: err.message }));
    }
  });

  // --- Theme application ---
  handlers.set('applyTheme', async (ws, sanitized) => {
    broadcast({ action: 'applyTheme', ...sanitized.css });
  });

  return handlers;
}

module.exports = { createHandlers };
