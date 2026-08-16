/**
 * ============================================================================
 *  bilingual-matcher.js — Passage unique de correspondance EXACTE, FR+EN
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 11b) : jusqu'ici, detector-compat.js
 *  essayait 4 étapes SÉQUENTIELLES (FR-exact → EN-exact → FR-flou →
 *  EN-flou) — deux boucles de correspondance d'alias totalement séparées,
 *  chacune parcourant SES PROPRES alias triés par longueur, une langue
 *  entière à la fois. Un alias FR court pouvait donc "gagner" contre un
 *  alias EN plus long et plus spécifique, simplement parce que la boucle FR
 *  passait en premier — pas parce que c'était la meilleure correspondance.
 *
 *  Ce module remplace les étapes 1+2 (exactes) par UNE SEULE boucle,
 *  triée par longueur d'alias À TRAVERS LES DEUX LANGUES ENSEMBLE — la vraie
 *  correspondance la plus longue/spécifique gagne, quelle que soit sa
 *  langue. C'est le premier lot du plan bilingue qui change réellement le
 *  comportement de correspondance (voir test-detector-bilingual.js) : tous
 *  les lots précédents (8-11a) étaient des fusions mécaniques sans impact
 *  observable.
 *
 *  Réutilise TEL QUEL (aucune réimplémentation) : detector.js/detector-en.js
 *  #testAlias (le test d'UN alias contre UN texte déjà normalisé — extrait
 *  au lot 11b justement pour permettre cet entrelacement) et leurs pipelines
 *  de normalisation propres (chaque langue garde SA correction phonétique et
 *  SA conversion de nombres en toutes lettres, qui diffèrent réellement
 *  entre les langues — voir keyword-variants.js/number-words.js).
 *
 *  PORTÉE : uniquement la phase EXACTE (le chemin rapide/courant). La phase
 *  FLOUE (correction Levenshtein du nom de livre, voir detector.js#detect
 *  et detector-en.js#detect) reste déclenchée séparément par langue dans
 *  detector-compat.js, INCHANGÉE — la réécrire en un seul passage aurait un
 *  risque élevé pour un gain minime (c'est déjà un filet de secours rare,
 *  pas le chemin chaud).
 * ============================================================================
 */
'use strict';

const detector = require('./detector');
const detectorEn = require('./detector-en');

// Alias FR + EN, chacun étiqueté par langue, TRIÉS ENSEMBLE par longueur de
// nom décroissante — voir l'en-tête ci-dessus pour pourquoi ce tri combiné
// (et non deux tris séparés) est le cœur du changement de ce lot.
const COMBINED_ALIASES = [
  ...detector.aliases.map((a) => ({ ...a, lang: 'fr' })),
  ...detectorEn.aliases.map((a) => ({ ...a, lang: 'en' })),
].sort((a, b) => b.name.length - a.name.length);

/**
 * Passage unique, bilingue, de correspondance EXACTE.
 * @param {string} text - texte brut (transcription), pas encore normalisé
 * @returns {{book: string, chapter: number, verseStart?: number, verseEnd?: number, raw: string, lang: 'fr'|'en'}|null}
 */
function detectBilingualExact(text) {
  // Chaque langue garde SA propre normalisation (phonétique + nombres) —
  // voir l'en-tête : ce ne sont PAS interchangeables, un texte anglais
  // normalisé côté FR perdrait ses conversions de nombres anglais, et
  // inversement.
  const frNormalized = detector.numberWordsToDigits(detector.normalize(text));
  const enNormalized = detectorEn.numberWordsToDigits(
    detectorEn.normalizeKeywords(detectorEn.normalize(text))
  );

  for (const { book, name, lang } of COMBINED_ALIASES) {
    const normalized = lang === 'fr' ? frNormalized : enNormalized;
    const testFn = lang === 'fr' ? detector.testAlias : detectorEn.testAlias;
    const result = testFn(normalized, name, book);
    if (result) return { book, ...result, lang };
  }
  return null;
}

module.exports = { detectBilingualExact, COMBINED_ALIASES };
