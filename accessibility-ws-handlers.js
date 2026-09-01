'use strict';

/**
 * accessibility-ws-handlers.js — Handlers WS d'accessibilité et d'affichage
 * (Phase 2 — modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js et les extractions de catégorie qui l'ont suivi).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * setHighContrast/setCaptions/setTranslatedCaptions/setTestPattern/
 * setBackgroundPattern/setBlackScreen/startCountdown/stopCountdown/
 * setAmbientMode.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.sessionState
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {() => void} ctx.startAmbientMoodLoop
 * @param {() => void} ctx.stopAmbientMoodLoop
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { sessionState, broadcast, log, startAmbientMoodLoop, stopAmbientMoodLoop } = ctx;

  const handlers = new Map();

  handlers.set('setHighContrast', async (ws, sanitized) => {
    sessionState.setHighContrast(!!sanitized.enabled);
    const highContrast = sessionState.getHighContrast();
    broadcast({ action: 'accessibilityMode', highContrast });
    log('Accessibilité : mode grand contraste ' + (highContrast ? 'activé' : 'désactivé'));
  });

  // --- Accessibility: live caption strip (audit — free/light) ---
  handlers.set('setCaptions', async (ws, sanitized) => {
    sessionState.setCaptionsEnabled(!!sanitized.enabled);
    const captions = sessionState.getCaptionsEnabled();
    broadcast({ action: 'captionsMode', captions });
    log('Accessibilité : sous-titres ' + (captions ? 'activés' : 'désactivés'));
  });

  // --- Sous-titres traduits en direct (opt-in, coût quota supplémentaire
  // Groq/Gemini — voir caption-translator.js et son garde-fou) ---
  handlers.set('setTranslatedCaptions', async (ws, sanitized) => {
    sessionState.setTranslatedCaptionsEnabled(!!sanitized.enabled);
    if (sanitized.targetLang) sessionState.setCaptionTargetLang(sanitized.targetLang);
    const translatedCaptions = sessionState.getTranslatedCaptionsEnabled();
    const targetLang = sessionState.getCaptionTargetLang();
    broadcast({ action: 'translatedCaptionsMode', enabled: translatedCaptions, targetLang });
    log(
      'Accessibilité : sous-titres traduits ' +
        (translatedCaptions ? `activés (${targetLang})` : 'désactivés')
    );
  });

  // --- Display: test pattern (audit — affichage/sortie, free/light) ---
  handlers.set('setTestPattern', async (ws, sanitized) => {
    sessionState.setTestPattern(!!sanitized.enabled);
    const enabled = sessionState.getTestPattern();
    broadcast({ action: 'testPatternMode', enabled });
    log('Affichage : motif de test ' + (enabled ? 'activé' : 'désactivé'));
  });

  // --- Display: background pattern (audit — affichage/sortie, free/light) ---
  handlers.set('setBackgroundPattern', async (ws, sanitized) => {
    const allowed = ['none', 'dots', 'grid', 'diagonal'];
    const pattern = allowed.includes(sanitized.pattern) ? sanitized.pattern : 'none';
    sessionState.setBackgroundPattern(pattern);
    broadcast({ action: 'backgroundPatternMode', pattern });
    log('Affichage : motif de fond -> ' + pattern);
  });

  // --- Black screen (écran noir d'urgence) ---
  handlers.set('setBlackScreen', async (ws, sanitized) => {
    broadcast({ action: 'blackScreenMode', enabled: !!sanitized.enabled });
    log('Affichage : écran noir ' + (sanitized.enabled ? 'activé' : 'désactivé'));
  });

  // --- Service countdown ---
  handlers.set('startCountdown', async (ws, sanitized) => {
    const endTimeMs = Number(sanitized.endTimeMs);
    if (endTimeMs > Date.now()) {
      broadcast({
        action: 'countdownMode',
        endTimeMs,
        label: sanitized.label || 'Le culte commence dans',
      });
      log("Affichage : countdown démarré jusqu'à " + new Date(endTimeMs).toLocaleTimeString());
    }
  });

  handlers.set('stopCountdown', async () => {
    broadcast({ action: 'countdownStop' });
    log('Affichage : countdown arrêté');
  });

  // --- Ambient mode override (manual pause/resume) ---
  handlers.set('setAmbientMode', async (ws, sanitized) => {
    if (sanitized.enabled === false) {
      stopAmbientMoodLoop();
      log("Ambiance automatique désactivée par l'opérateur");
    } else {
      startAmbientMoodLoop();
      log("Ambiance automatique réactivée par l'opérateur");
    }
    broadcast({ action: 'ambientModeChanged', enabled: sanitized.enabled !== false });
  });

  return handlers;
}

module.exports = { createHandlers };
