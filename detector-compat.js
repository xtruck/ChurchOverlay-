/**
 * ============================================================================
 * detector-compat.js — Compatibility wrapper for detector.js
 * ============================================================================
 * detector.js exports: { detect, normalize, numberWordsToDigits, detectTranslationSwitch, BOOKS }
 * My server.js expects: { detectBilingual, parseReference }
 * This wrapper bridges the two APIs without modifying detector.js.
 * ============================================================================
 */

'use strict';

const detector = require('./detector');
let detectorEn = null;
try {
  detectorEn = require('./detector-en');
} catch (_e) {
  // English detector optional
}
// CUTOVER (support bilingue FR/EN, lot 11b) : la phase EXACTE (étapes 1+2
// de l'ancien dispatcher séquentiel FR-exact→EN-exact) est désormais UN
// SEUL passage bilingue trié par longueur d'alias — voir bilingual-matcher.js
// pour le détail et la justification du changement de comportement.
let bilingualMatcher = null;
try {
  bilingualMatcher = require('./bilingual-matcher');
} catch (_e) {
  // Repli possible si detector-en est absent (voir le try/catch ci-dessus) —
  // bilingual-matcher.js requiert directement detector-en, donc son
  // chargement échoue dans les mêmes conditions.
}

/**
 * detectBilingual — un seul passage bilingue pour la correspondance EXACTE
 * (voir bilingual-matcher.js), puis un repli flou par langue (FR puis EN,
 * INCHANGÉ — filet de secours rare, pas le chemin chaud, voir l'en-tête de
 * bilingual-matcher.js pour la justification de ne pas l'unifier aussi).
 */
function detectBilingual(text) {
  // Étape 1 : correspondance EXACTE bilingue en un seul passage.
  if (bilingualMatcher) {
    const exact = bilingualMatcher.detectBilingualExact(text);
    if (exact) return exact;
  } else if (detector.detectExact) {
    // Repli si bilingual-matcher.js n'a pas pu se charger (detector-en
    // absent) : comportement historique FR seul.
    const frExact = detector.detectExact(text);
    if (frExact) return frExact;
  }

  // Étape 2 : repli flou FR (INCHANGÉ — voir detector.js#detect).
  const frFuzzy = detector.detect(text);
  if (frFuzzy) return frFuzzy;

  // Étape 3 : repli flou EN (INCHANGÉ — voir detector-en.js#detect).
  if (detectorEn) {
    const enFuzzy = detectorEn.detect(text);
    if (enFuzzy) return enFuzzy;
  }

  return null;
}

/**
 * parseReference — try to parse a manual reference string in FR or EN.
 */
function parseReference(text) {
  return detectBilingual(text);
}

module.exports = {
  detectBilingual,
  parseReference,
  // Also re-export original functions for compatibility
  detect: detector.detect,
  detectExact: detector.detectExact,
  normalize: detector.normalize,
  numberWordsToDigits: detector.numberWordsToDigits,
  detectTranslationSwitch: detector.detectTranslationSwitch,
  hasIntroductionPhrase: detector.hasIntroductionPhrase,
  BOOKS: detector.BOOKS,
};
