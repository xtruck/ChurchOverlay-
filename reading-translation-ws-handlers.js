'use strict';

/**
 * reading-translation-ws-handlers.js — Handlers WS du mode lecture,
 * traduction (secondaire + IA à la volée) et thème d'ambiance (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js et les extractions de catégorie qui l'ont suivi).
 *
 * Trois domaines proches regroupés (dépendances Bible/session très
 * proches) : mode lecture verset par verset (readingMode), traduction
 * (secondaire côte à côte + traduction IA à la volée), et thème
 * d'ambiance par mood (déclenchement manuel, distinct du cycle automatique
 * qui reste dans server.js — startAmbientMoodLoop/stopAmbientMoodLoop).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * setSecondaryTranslation/startReading/stopReading/nextReadingVerse/
 * previousReadingVerse/setMoodTheme/translateText/hideTranslation.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.sessionState
 * @param {object} ctx.bibleLookup
 * @param {object} ctx.detector
 * @param {object} ctx.readingMode
 * @param {object|null} ctx.themeGenerator - peut être null (module IA optionnel absent)
 * @param {object|null} ctx.aiEnricher - peut être null (module IA optionnel absent)
 * @param {(text: string) => string} ctx.sanitizeForPrompt
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {(entry: object) => void} ctx.pushHistory
 * @param {() => number} ctx.getVerseDurationMs
 * @param {(rm: object, verseNum: number) => object} ctx.readingModePosition
 * @param {(direction: number) => void} ctx.advanceReadingModeVerse
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    sessionState,
    bibleLookup,
    detector,
    readingMode,
    themeGenerator,
    aiEnricher,
    sanitizeForPrompt,
    broadcast,
    log,
    pushHistory,
    getVerseDurationMs,
    readingModePosition,
    advanceReadingModeVerse,
  } = ctx;

  const handlers = new Map();

  // AJOUT (Multi-Bible côte à côte, déclenchement manuel) : {lang, code}
  // pour activer, ou lang/code absents/vides pour désactiver la
  // comparaison. Validé contre bibleLookup.listTranslations() plutôt que
  // de faire confiance au client — un code de traduction inconnu
  // échouerait de toute façon dans getVerseDualTranslation, mais autant le
  // signaler clairement ici, au moment du réglage.
  handlers.set('setSecondaryTranslation', async (ws, sanitized) => {
    const lang = sanitized.lang || null;
    const code = sanitized.code || null;
    if (!lang || !code) {
      sessionState.setSecondaryTranslation(null, null);
      broadcast({ action: 'secondaryTranslationChanged', lang: null, code: null });
      log('Traduction secondaire : désactivée');
      return;
    }
    const known = (bibleLookup.listTranslations()[lang] || []).some((t) => t.code === code);
    if (!known) {
      ws.send(JSON.stringify({ action: 'error', error: `Traduction inconnue: ${lang}/${code}` }));
      return;
    }
    sessionState.setSecondaryTranslation(lang, code);
    broadcast({ action: 'secondaryTranslationChanged', lang, code });
    log(`Traduction secondaire : ${lang}/${code}`);
  });

  // --- Reading mode ---
  handlers.set('startReading', async (ws, sanitized) => {
    const ref = detector.parseReference(sanitized.reference);
    if (!ref) {
      ws.send(
        JSON.stringify({ action: 'error', error: 'Référence invalide pour le mode lecture.' })
      );
      return;
    }
    try {
      const firstVerse = await readingMode.start(ref.book, ref.chapter, ref.verseStart);
      broadcast({ action: 'readingStarted', reference: ref });
      if (firstVerse) {
        const label = bibleLookup.buildReferenceLabel(
          { book: ref.book, chapter: ref.chapter, verseStart: firstVerse.num },
          sessionState.getDisplayLanguage()
        );
        broadcast({
          action: 'showVerse',
          reference: label,
          text: firstVerse.text,
          text_fr: firstVerse.text_fr || null,
          text_en: firstVerse.text_en || null,
          langMode: sessionState.getDisplayLanguage(),
          durationMs: getVerseDurationMs(),
          readingMode: true,
          readingModePos: readingModePosition(readingMode, firstVerse.num),
        });
        pushHistory({
          reference: label,
          text: firstVerse.text.substring(0, 200),
          readingMode: true,
          timestamp: Date.now(),
        });
        broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
      }
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: err.message }));
    }
  });

  handlers.set('stopReading', async () => {
    readingMode.stop();
    broadcast({ action: 'readingStopped' });
  });

  // AJOUT (mode lecture — bouton manuel) : avant ce correctif, avancer
  // verset par verset en mode lecture n'était possible QUE par commande
  // vocale ('nextVerse'/'previousVerse' dans handleVoiceCommand() de
  // server.js) — aucune action WS directe n'existait pour un clic Suivant/
  // Précédent depuis le tableau de bord. Réutilise advanceReadingModeVerse(),
  // le même helper que le chemin vocal ; triggeredByVoice:false permet aux
  // deux chemins de rester distinguables côté client si besoin un jour.
  handlers.set('nextReadingVerse', async () => {
    broadcast({ action: 'nextVerse', triggeredByVoice: false });
    advanceReadingModeVerse(1);
  });

  handlers.set('previousReadingVerse', async () => {
    broadcast({ action: 'previousVerse', triggeredByVoice: false });
    advanceReadingModeVerse(-1);
  });

  // --- Set theme by mood ---
  handlers.set('setMoodTheme', async (ws, sanitized) => {
    if (!themeGenerator) {
      ws.send(JSON.stringify({ action: 'error', error: 'Générateur de thèmes non disponible' }));
      return;
    }
    const mood = sanitized.mood;
    const theme = themeGenerator.getTheme(mood);
    broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme) });
    ws.send(JSON.stringify({ action: 'themeApplied', mood, themeName: theme.name }));
  });

  // --- AI Live Translation (with prompt sanitization) ---
  handlers.set('translateText', async (ws, sanitized) => {
    if (!aiEnricher) {
      ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
      return;
    }
    const targetLang = sanitized.targetLang || 'en';
    const safeText = sanitizeForPrompt(sanitized.text || '');
    const translation = await aiEnricher.translateSegment(safeText, targetLang);
    if (sanitized.autoBroadcast) {
      broadcast({
        action: 'showTranslation',
        translation,
        targetLang,
        reference: sanitized.reference || null,
      });
    }
    ws.send(
      JSON.stringify({
        action: 'textTranslated',
        original: sanitized.text,
        targetLang,
        translation,
        autoBroadcast: !!sanitized.autoBroadcast,
      })
    );
  });

  // --- Live translation off ---
  handlers.set('hideTranslation', async () => {
    broadcast({ action: 'hideTranslation' });
  });

  return handlers;
}

module.exports = { createHandlers };
