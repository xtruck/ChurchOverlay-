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
 * (voir bilingual-matcher.js), puis un repli flou.
 *
 * CORRECTIF (Chantier A.2 — mission autonome, "double détection FR/EN") :
 * le repli flou essayait auparavant FR PUIS EN, en s'arrêtant au premier
 * qui matchait — un texte majoritairement anglais avec un nom de livre
 * français mal transcrit pouvait donc "gagner" à tort contre une meilleure
 * correspondance anglaise jamais tentée (le FR fuzzy s'arrêtait déjà avant
 * que l'EN fuzzy ait sa chance). Les deux réplis flous sont désormais
 * TOUJOURS calculés (coût négligeable : deux regex locales, aucun appel
 * réseau), et c'est la MEILLEURE correspondance qui gagne — confidence
 * d'abord ('high' > 'medium', bien qu'un repli flou ne dépasse jamais
 * 'medium' par construction, voir detector.js#detect), puis distance de
 * correction Levenshtein (fuzzyDistance, plus bas = meilleur), et en cas
 * d'égalité stricte la langue de la session ASR en cours (sessionLanguage,
 * voir session-state.js#getTranscriptionLanguage) — sinon le français reste
 * le défaut historique, pour ne rien changer au comportement d'une session
 * dont la langue n'a jamais été réglée explicitement.
 * @param {string} text
 * @param {string|null} [sessionLanguage] - 'fr'|'en'|'multi'|null, voir
 *   session-state.js#getTranscriptionLanguage(). Ignoré si absent — un
 *   appelant qui ne le passe pas garde le comportement "FR par défaut".
 */
function detectBilingual(text, sessionLanguage) {
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

  // Étape 2 : repli flou — les DEUX langues, systématiquement (voir
  // CORRECTIF ci-dessus).
  const frFuzzy = detector.detect(text);
  const enFuzzy = detectorEn ? detectorEn.detect(text) : null;

  if (frFuzzy && !enFuzzy) return { ...frFuzzy, lang: 'fr' };
  if (enFuzzy && !frFuzzy) return { ...enFuzzy, lang: 'en' };
  if (!frFuzzy && !enFuzzy) return null;

  // Les deux ont matché : la distance de correction la plus faible gagne
  // (une correction plus proche du texte original est plus fiable qu'une
  // correction plus lointaine, même à confidence égale — toujours 'medium'
  // des deux côtés ici).
  const frDistance = frFuzzy.fuzzyDistance;
  const enDistance = enFuzzy.fuzzyDistance;
  if (frDistance !== enDistance) {
    return frDistance < enDistance ? { ...frFuzzy, lang: 'fr' } : { ...enFuzzy, lang: 'en' };
  }
  // Égalité stricte : départage par la langue de la session ASR en cours.
  if (sessionLanguage === 'en') return { ...enFuzzy, lang: 'en' };
  return { ...frFuzzy, lang: 'fr' };
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
  detectExactEn: detectorEn ? detectorEn.detectExact : null,
  normalize: detector.normalize,
  numberWordsToDigits: detector.numberWordsToDigits,
  detectTranslationSwitch: detector.detectTranslationSwitch,
  hasIntroductionPhrase: detector.hasIntroductionPhrase,
  containsBookName: detector.containsBookName,
  BOOKS: detector.BOOKS,
};
