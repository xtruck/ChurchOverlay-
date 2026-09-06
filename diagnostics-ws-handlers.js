'use strict';

/**
 * diagnostics-ws-handlers.js — Handlers WS de diagnostic/état (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js et les extractions de catégorie qui l'ont suivi).
 *
 * Actions de lecture seule regroupées ici (aucune ne mute d'état) :
 * vérification pré-culte, statut réseau, statistiques de session
 * (SQLite), statut de la base biblique hors-ligne.
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * preServiceCheck/getNetworkStatus/getSessionStats/getOfflineBibleStatus.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.groq
 * @param {object} ctx.deepgramWrapper
 * @param {string|null} ctx.wsAuthToken - WS_AUTH_TOKEN
 * @param {string} ctx.wsHost - WS_HOST
 * @param {object} ctx.mediaLibrary
 * @param {object} ctx.brandingStore
 * @param {object} ctx.bibleOfflineCache
 * @param {object} ctx.ipCameraStore
 * @param {object} ctx.sessionStore
 * @param {object} ctx.rundownStore
 * @param {object} ctx.sessionState
 * @param {string[]} ctx.aiLoadErrors - échecs de CHARGEMENT des modules IA au
 *   démarrage (voir ai-modules-loader.js) — même liste déjà diffusée dans
 *   chaque message 'init' (voir setAiDegradedStatus côté dashboard).
 * @param {import('ws').Server} ctx.wss - pour agréger le backpressure WS en
 *   cours (voir ws._backpressureSince, posé par broadcast() dans server.js).
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    groq,
    deepgramWrapper,
    wsAuthToken,
    wsHost,
    mediaLibrary,
    brandingStore,
    bibleOfflineCache,
    ipCameraStore,
    sessionStore,
    rundownStore,
    sessionState,
    aiLoadErrors,
    wss,
  } = ctx;

  const handlers = new Map();

  // --- Pre-service test ---
  handlers.set('preServiceCheck', async (ws) => {
    try {
      const [groqResult, deepgramResult] = await Promise.all([
        groq.checkKey(),
        deepgramWrapper.checkKey(),
      ]);
      // AJOUT (checkup — "vérifier que tout ce qui a été ajouté fonctionne
      // bien, un seul endroit avant le culte") : ce contrôle ne portait
      // jusqu'ici que sur la transcription (Groq/Deepgram) et
      // l'authentification WebSocket — datant d'avant la médiathèque, le
      // poster principal, l'habillage caméra, la caméra téléphone par QR et
      // la base biblique hors-ligne. Plutôt que de laisser l'équipe
      // vérifier chaque panneau séparément, ce même bouton couvre
      // désormais tout — lecture seule, aucun appel réseau supplémentaire
      // (tout est déjà en mémoire/disque local).

      // AJOUT (Pre-Service Readiness Score) : agrège des signaux déjà
      // trackés ailleurs (rundown, mode de confiance, échecs de chargement
      // IA, backpressure WS) en un score/checklist unique, calculé côté
      // serveur pour que le tableau de bord n'ait pas à dupliquer cette
      // logique. `readyToGoLive` reste permissif par construction : une
      // feuille de route vide ou un mode IA dégradé sont des AVERTISSEMENTS
      // (un culte 100% manuel, sans aucune clé IA, est un usage légitime),
      // pas des blocages — seul un vrai problème de connexion serait un
      // faux "prêt".
      let wsBackpressureCount = 0;
      if (wss && wss.clients) {
        for (const client of wss.clients) {
          if (client._backpressureSince) wsBackpressureCount++;
        }
      }
      const rundownCueCount = rundownStore ? rundownStore.listCues().length : 0;
      const trustMode = sessionState ? sessionState.getTrustMode() : null;
      const aiDegradedList = Array.isArray(aiLoadErrors) ? aiLoadErrors : [];

      const readinessChecks = [
        {
          key: 'transcription',
          label: 'Transcription (Groq ou Deepgram)',
          ok: !!(groqResult.ok || deepgramResult.ok),
        },
        { key: 'rundown', label: 'Feuille de route préparée', ok: rundownCueCount > 0 },
        { key: 'trustMode', label: 'Mode de confiance choisi', ok: !!trustMode },
        { key: 'aiModules', label: 'Modules IA', ok: aiDegradedList.length === 0 },
        { key: 'wsBackpressure', label: 'Charge réseau WebSocket', ok: wsBackpressureCount === 0 },
      ];
      const readinessScore = Math.round(
        (readinessChecks.filter((c) => c.ok).length / readinessChecks.length) * 100
      );

      ws.send(
        JSON.stringify({
          action: 'preServiceCheckResult',
          wsConnected: true,
          wsAuthEnabled: !!wsAuthToken,
          wsHost,
          groq: groqResult,
          deepgram: deepgramResult,
          mediaLibraryCount: mediaLibrary.listItems().length,
          hasDefaultPoster: !!mediaLibrary.getDefaultItem(),
          brandingLogoConfigured: !!brandingStore.getConfig().logoFilename,
          offlineBibleStatus: bibleOfflineCache.getStatus().status,
          ipCameraCount: ipCameraStore.listItems().length,
          qrCameraReady: wsHost !== '127.0.0.1' && wsHost !== 'localhost',
          rundownCueCount,
          trustMode,
          aiDegradedCount: aiDegradedList.length,
          aiLoadErrors: aiDegradedList,
          wsBackpressureCount,
          readinessChecks,
          readinessScore,
          readyToGoLive: readinessChecks.every((c) => c.ok),
          timestamp: Date.now(),
        })
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error: 'Échec de la vérification pré-culte : ' + err.message,
        })
      );
    }
  });

  // AJOUT (carte réseau — "Réseau / caméra téléphone (QR)") : statut de
  // lecture seule séparé de preServiceCheck ci-dessus pour que rafraîchir
  // cette carte (au chargement des Réglages, après un enregistrement) ne
  // déclenche pas au passage un appel réseau Groq/Deepgram inutile.
  handlers.set('getNetworkStatus', async (ws) => {
    ws.send(
      JSON.stringify({
        action: 'networkStatus',
        wsHost,
        wsAuthEnabled: !!wsAuthToken,
        qrCameraReady: wsHost !== '127.0.0.1' && wsHost !== 'localhost',
      })
    );
  });

  // --- Session stats (historique persistant SQLite — voir session-store.js) ---
  // AJOUT (audit round 9) : session-store.js écrit déjà chaque verset
  // affiché et chaque erreur de pipeline en SQLite depuis le chantier de
  // fiabilité du 2026-08-05 (jour de survie à un crash, trace consultable
  // après un culte), mais rien ne relisait jamais cette base — aucune
  // action WebSocket ne l'exposait, donc aucun panneau du tableau de bord
  // ne pouvait la montrer. La persistance tournait "dans le vide".
  handlers.set('getSessionStats', async (ws, sanitized) => {
    try {
      const days = Math.min(Math.max(Number.parseInt(sanitized.days, 10) || 1, 1), 30);
      const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const verses = sessionStore.getVerseHistorySince(sinceMs);
      const errors = sessionStore.getPipelineErrorsSince(sinceMs);
      const errorsByType = {};
      for (const e of errors) {
        errorsByType[e.type] = (errorsByType[e.type] || 0) + 1;
      }
      ws.send(
        JSON.stringify({
          action: 'sessionStats',
          persistenceEnabled: sessionStore.isEnabled(),
          days,
          sinceMs,
          verseCount: verses.length,
          verses: verses.slice(0, 100),
          errorCount: errors.length,
          errors: errors.slice(0, 50),
          errorsByType,
          // AJOUT (chantier 4.6 — présence anonyme via companion.html) :
          // même fenêtre `days`/`sinceMs` que le reste de cette réponse.
          checkinCount: sessionStore.getCheckinCountSince(sinceMs),
          timestamp: Date.now(),
        })
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          action: 'error',
          error: 'Impossible de récupérer les statistiques de session : ' + err.message,
        })
      );
    }
  });

  // --- Base biblique hors-ligne (cahier des charges — Point 1B) ---------
  handlers.set('getOfflineBibleStatus', async (ws) => {
    ws.send(JSON.stringify({ action: 'offlineBibleStatus', ...bibleOfflineCache.getStatus() }));
  });

  return handlers;
}

module.exports = { createHandlers };
