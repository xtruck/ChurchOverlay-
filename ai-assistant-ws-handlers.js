'use strict';

/**
 * ai-assistant-ws-handlers.js — Handlers WS de l'assistant IA (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js et les extractions de catégorie qui l'ont suivi).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) : getTopics/
 * getMoods/getAiStats/getLiveSummary/getSermonTheme/getPostServiceRecap/
 * getArchiveMatches/getCrossReferences/askSermonQuestion.
 *
 * NE couvre PAS preServiceCheck/getNetworkStatus/listPlugins/togglePlugin,
 * thématiquement adjacents mais avec un jeu de dépendances distinct
 * (diagnostics réseau/clés API plutôt qu'enrichissement IA) — laissés dans
 * server.js pour l'instant.
 *
 * Chaque module IA optionnel (semanticSearch/themeGenerator/aiEnricher/
 * semanticDetector/corrector/plugins) peut être `null` si son chargement a
 * échoué ou s'il est absent (voir ai-modules-loader.js) — chaque handler
 * reproduit exactement le repli déjà présent dans server.js (liste/stats
 * vide, ou message d'erreur clair), jamais un crash.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object|null} ctx.semanticSearch
 * @param {object|null} ctx.themeGenerator
 * @param {object|null} ctx.aiEnricher
 * @param {object|null} ctx.semanticDetector
 * @param {object|null} ctx.corrector
 * @param {object|null} ctx.plugins
 * @param {Array} ctx.aiLoadErrors
 * @param {object} ctx.sessionState
 * @param {object} ctx.sermonArchive
 * @param {object} ctx.sermonQa
 * @param {(text: string) => string} ctx.sanitizeForPrompt
 * @param {(msg: string) => void} ctx.log
 * @param {(msg: string) => void} ctx.warn
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    semanticSearch,
    themeGenerator,
    aiEnricher,
    semanticDetector,
    corrector,
    plugins,
    aiLoadErrors,
    sessionState,
    sermonArchive,
    sermonQa,
    sanitizeForPrompt,
    log,
    warn,
  } = ctx;

  const handlers = new Map();

  handlers.set('getTopics', async (ws) => {
    ws.send(
      JSON.stringify({
        action: 'topicsList',
        topics: semanticSearch ? semanticSearch.getTopics() : [],
      })
    );
  });

  handlers.set('getMoods', async (ws) => {
    ws.send(
      JSON.stringify({
        action: 'moodsList',
        moods: themeGenerator ? themeGenerator.getMoods() : [],
      })
    );
  });

  // --- AI stats ---
  handlers.set('getAiStats', async (ws) => {
    ws.send(
      JSON.stringify({
        action: 'aiStats',
        semanticDetector: semanticDetector ? semanticDetector.getStats() : null,
        corrector: corrector ? corrector.getStats() : null,
        themeGenerator: themeGenerator ? themeGenerator.getStats() : null,
        plugins: plugins ? plugins.metadata : null,
        aiEnricher: !!aiEnricher,
        loadErrors: aiLoadErrors,
      })
    );
  });

  // --- AI Live Summary (with prompt sanitization) ---
  handlers.set('getLiveSummary', async (ws) => {
    if (!aiEnricher) {
      ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
      return;
    }
    const fullTranscript = sanitizeForPrompt(sessionState.getRecentTranscripts().join(' '));
    const summary = await aiEnricher.generateLiveSummary(fullTranscript);
    ws.send(JSON.stringify({ action: 'liveSummary', summary, timestamp: Date.now() }));
  });

  // --- AI Sermon Theme (with prompt sanitization) ---
  handlers.set('getSermonTheme', async (ws, sanitized) => {
    if (!aiEnricher) {
      ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
      return;
    }
    const fullTranscript = sanitizeForPrompt(sessionState.getRecentTranscripts().join(' '));
    const themeData = await aiEnricher.detectSermonTheme(fullTranscript);
    ws.send(
      JSON.stringify({
        action: 'sermonTheme',
        ...themeData,
        silent: !!sanitized.silent,
        timestamp: Date.now(),
      })
    );
  });

  // --- AI Post-Service Recap (with prompt sanitization) ---
  handlers.set('getPostServiceRecap', async (ws) => {
    if (!aiEnricher) {
      ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
      return;
    }
    // CORRECTIF (audit — mémoire des cultes) : sessionState.getRecentTranscripts()
    // est une fenêtre glissante de 10 fragments (pensée pour le contexte
    // court du détecteur sémantique, voir session-state.js), donc trop
    // étroite pour un "récap fin de culte" fidèle — il ne portait en
    // réalité que sur les dernières secondes du service.
    // sessionState.getFullServiceTranscript() couvre tout le culte en
    // cours (borné à MAX_SERVICE_TRANSCRIPT_CHARS caractères).
    const fullTranscript = sanitizeForPrompt(sessionState.getFullServiceTranscript());
    const recap = await aiEnricher.generatePostServiceRecap(
      fullTranscript,
      sessionState.getVerseHistory()
    );
    ws.send(JSON.stringify({ action: 'postServiceRecap', recap, timestamp: Date.now() }));

    // AJOUT (audit — mémoire des cultes, gratuit/léger) : le clic "Récap fin
    // de culte" est le seul geste explicite de fin de service déjà présent
    // dans l'app — on l'utilise aussi pour archiver localement (voir
    // sermon-archive.js) et repartir à zéro pour le prochain culte.
    try {
      sermonArchive.saveServiceEntry({
        theme: recap && recap.title,
        keyPoints: recap && recap.keyPoints,
        transcriptExcerpt: sessionState.getFullServiceTranscript().slice(-4000),
        // AJOUT (cahier des charges — assistant sermons) : texte complet,
        // pas seulement les 4000 derniers caractères — voir sermon-qa.js.
        fullTranscript: sessionState.getFullServiceTranscript(),
        versesShown: sessionState.getVerseHistory(),
      });
      log('Culte archivé localement (sermon-archive.js)');
    } catch (err) {
      warn('Archivage du culte échoué: ' + err.message);
    }
    sessionState.resetFullServiceTranscript();
  });

  // --- Sermon archive search (audit — mémoire des cultes, gratuit/léger) ---
  handlers.set('getArchiveMatches', async (ws, sanitized) => {
    const query = sanitizeForPrompt(sanitized.query || '');
    const matches = query ? sermonArchive.search(query) : [];
    ws.send(JSON.stringify({ action: 'archiveMatches', query: sanitized.query, results: matches }));
  });

  // --- AI Cross References (with prompt sanitization) ---
  handlers.set('getCrossReferences', async (ws, sanitized) => {
    if (!aiEnricher) {
      ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
      return;
    }
    const safeRef = sanitizeForPrompt(sanitized.reference || '');
    const safeText = sanitizeForPrompt(sanitized.text || '');
    const refs = await aiEnricher.findCrossReferences(safeRef, safeText);
    ws.send(
      JSON.stringify({ action: 'crossReferences', reference: sanitized.reference, results: refs })
    );
  });

  // --- Assistant Q&R sur les prédications (cahier des charges — Point 5,
  // voir sermon-qa.js pour le garde-fou "jamais de réponse sans source") ---
  handlers.set('askSermonQuestion', async (ws, sanitized) => {
    try {
      const safeQuestion = sanitizeForPrompt(sanitized.question || '');
      const result = await sermonQa.askQuestion(safeQuestion);
      ws.send(
        JSON.stringify({
          action: 'sermonQuestionAnswered',
          question: sanitized.question,
          ...result,
        })
      );
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Assistant sermons : ' + err.message }));
    }
  });

  return handlers;
}

module.exports = { createHandlers };
