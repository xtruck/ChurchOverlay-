/**
 * ============================================================================
 *  caption-translator.js — Traduction des sous-titres en direct (optionnelle)
 * ----------------------------------------------------------------------------
 *  AJOUT (demande explicite — sous-titres traduits en direct, distinct de la
 *  traduction de VERSETS déjà existante via getVerseMultilang/langMode
 *  'both'). Ici, c'est le TRANSCRIT BRUT lui-même (ce qui est en train
 *  d'être dit, pas une citation biblique) qui est traduit.
 *
 *  GARDE-FOU (fiabilité absolue — priorité #1 de ce projet) : ce module ne
 *  doit JAMAIS ralentir ni casser le pipeline de détection de versets.
 *    - Appelé en "fire-and-forget" depuis server.js (jamais attendu avant
 *      processTranscript()) — voir startPipeline().
 *    - throttleMs empêche une rafale d'appels si la parole est hachée
 *      (segments rapprochés), pour ne pas cogner le quota gratuit Groq/
 *      Gemini partagé avec la correction/le Q&R de sermon.
 *    - Toute erreur (timeout, 429, réseau) est avalée ici : cette fonction
 *      ne lève jamais, elle renvoie simplement `null` — un sous-titre
 *      traduit manqué n'est jamais grave, un pipeline cassé l'est.
 *    - Désactivé par défaut (voir session-state.js), opt-in explicite côté
 *      opérateur, avec un texte d'avertissement dans le dashboard sur le
 *      coût en quota supplémentaire.
 * ============================================================================
 */
'use strict';

const groqWrapper = require('./groq-wrapper');

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_THROTTLE_MS = 1500; // segments les plus rapprochés ~3.2s (voir audio-capture.js) : marge large

const LANG_LABELS = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  de: 'German',
};

let lastCallAt = 0;

function buildPrompt(text, targetLangLabel) {
  return (
    `Translate the following sentence, spoken live during a church service, into ${targetLangLabel}. ` +
    'Reply with ONLY the translation — no notes, no quotes, no explanation:\n\n' +
    text
  );
}

/**
 * Traduit un segment de transcript. Best-effort strict : ne lève jamais,
 * renvoie `null` sur throttle, échec ou timeout.
 * @param {string} text - texte brut transcrit
 * @param {string} [targetLang] - code langue cible ('en', 'es', 'pt', 'de')
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.skipThrottle] - pour les tests
 * @returns {Promise<string|null>}
 */
async function translateCaption(text, targetLang = 'en', options = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  const now = Date.now();
  if (!options.skipThrottle) {
    if (now - lastCallAt < DEFAULT_THROTTLE_MS) return null;
    lastCallAt = now;
  }

  const label = LANG_LABELS[targetLang] || targetLang;
  try {
    const result = await groqWrapper.chatCompletion(buildPrompt(trimmed, label), {
      max_tokens: 200,
      temperature: 0,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    const translated = result && typeof result.text === 'string' ? result.text.trim() : '';
    return translated || null;
  } catch (_err) {
    // Best-effort strict (voir garde-fou en en-tête) : jamais d'erreur remontée.
    return null;
  }
}

/**
 * Réinitialise le throttle interne — utilisé par les tests uniquement.
 */
function resetThrottle() {
  lastCallAt = 0;
}

module.exports = {
  translateCaption,
  resetThrottle,
  LANG_LABELS,
};
