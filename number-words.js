/**
 * ============================================================================
 *  number-words.js — Nombres écrits en toutes lettres (FR + EN)
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 9) : fusion MÉCANIQUE des tables
 *  NUMBER_WORDS de detector.js (français) et detector-en.js (anglais) —
 *  extraites directement de ces deux fichiers (via un export temporaire,
 *  jamais commité) pour éliminer tout risque de faute de frappe/oubli lors
 *  de la fusion, comme pour book-catalog.js (lot 8).
 *
 *  VOLONTAIREMENT DEUX ALGORITHMES SÉPARÉS, PAS UN SEUL UNIFIÉ : la
 *  composition orale des nombres diffère réellement entre les deux langues,
 *  pas seulement le vocabulaire —
 *    - FR : "quatre-vingt" (4 puis 20) doit donner 80, PAS 24 — une règle
 *      spéciale ("si le nombre courant est 4 et qu'on lit 20, remplacer par
 *      80") que l'anglais n'a pas.
 *    - EN : "one hundred" compose par MULTIPLICATION (hundred multiplie ce
 *      qui précède), le français fait pareil pour "cent" mais sans la
 *      bizarrerie du quatre-vingt.
 *  Forcer un seul algorithme générique aurait soit cassé "quatre-vingt-onze"
 *  (91, pas 24 + 11 = 35), soit ajouté une branche spécifique FR dans un
 *  code censé être neutre — préférer deux fonctions courtes et lisibles à
 *  une seule fonction avec des branches par langue.
 *
 *  PORTÉE DE CE LOT : additif seulement, comme book-catalog.js (lot 8).
 *  detector.js et detector-en.js ne sont PAS modifiés pour consommer ce
 *  module — voir le lot 10 (cutover), avec pour condition explicite que
 *  test-detector.js et test-detector-en.js passent SANS AUCUNE modification.
 * ============================================================================
 */
'use strict';

/** @type {Object<string, number>} Miroir exact de NUMBER_WORDS (detector.js). */
const FR = {
  zero: 0,
  un: 1,
  une: 1,
  premier: 1,
  premiere: 1,
  '1er': 1,
  '1ere': 1,
  '1st': 1,
  first: 1,
  deux: 2,
  deuxieme: 2,
  second: 2,
  seconde: 2,
  '2eme': 2,
  '2ere': 2,
  '2nd': 2,
  trois: 3,
  troisieme: 3,
  '3eme': 3,
  '3rd': 3,
  quatre: 4,
  quatrieme: 4,
  '4eme': 4,
  '4th': 4,
  cinq: 5,
  cinquieme: 5,
  '5eme': 5,
  '5th': 5,
  six: 6,
  sixieme: 6,
  '6eme': 6,
  '6th': 6,
  sept: 7,
  septieme: 7,
  '7eme': 7,
  '7th': 7,
  huit: 8,
  huitieme: 8,
  '8eme': 8,
  '8th': 8,
  neuf: 9,
  neuvieme: 9,
  '9eme': 9,
  '9th': 9,
  dix: 10,
  dixieme: 10,
  '10eme': 10,
  '10th': 10,
  onze: 11,
  onzieme: 11,
  onzeieme: 11,
  douze: 12,
  douzieme: 12,
  treize: 13,
  treizieme: 13,
  quatorze: 14,
  quatorzieme: 14,
  quinze: 15,
  quinzieme: 15,
  seize: 16,
  seizieme: 16,
  dixsept: 17,
  dixseptieme: 17,
  dixhuit: 18,
  dixhuitieme: 18,
  dixneuf: 19,
  dixneuvieme: 19,
  vingt: 20,
  vingtieme: 20,
  trente: 30,
  trentieme: 30,
  quarante: 40,
  quarantieme: 40,
  cinquante: 50,
  cinquantieme: 50,
  soixante: 60,
  cent: 100,
  cents: 100,
  centieme: 100,
};

/** @type {Object<string, number>} Miroir exact de NUMBER_WORDS (detector-en.js). */
const EN = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  fifth: 5,
  '5th': 5,
  sixth: 6,
  '6th': 6,
  seventh: 7,
  '7th': 7,
  eighth: 8,
  '8th': 8,
  ninth: 9,
  '9th': 9,
  tenth: 10,
  '10th': 10,
  eleventh: 11,
  '11th': 11,
  twelfth: 12,
  '12th': 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
};

const NUMBER_WORDS = { fr: FR, en: EN };

// Mot de liaison ("vingt ET un" / "one hundred AND one") — ignoré lors de la
// composition, pas juste un synonyme de zéro comme les autres tokens.
const CONNECTOR = { fr: 'et', en: 'and' };

function buildPattern(lang) {
  const words = Object.keys(NUMBER_WORDS[lang]).join('|');
  const connector = CONNECTOR[lang];
  return new RegExp(`\\b(?:${words})(?:[\\s-]+(?:${connector}[\\s-]+)?(?:${words}))*\\b`, 'g');
}

// Compilés une fois au chargement du module (miroir de NUMBER_WORD_PATTERN
// dans detector.js/detector-en.js) — réutiliser le même objet RegExp global
// à travers plusieurs appels à .replace() est sûr : le spec ECMAScript
// réinitialise lastIndex à 0 au début de RegExp.prototype[Symbol.replace]
// quand le flag global est actif.
const PATTERNS = { fr: buildPattern('fr'), en: buildPattern('en') };

/**
 * Indique si `value` peut se COMPOSER au nombre en cours de construction —
 * c'est-à-dire si leur somme forme encore un nombre français/anglais VALIDE.
 * Un nombre isolé (unité ou dizaine) ne compose PAS avec n'importe quoi :
 * « trois seize » est deux nombres indépendants (chapitre trois, verset
 * seize — reformulation sans mot-clé de l'énoncé « Jean trois seize »), et
 * leur somme naïve (19) est un CONTRE-SENS. Règles :
 *   - cent/hundred MULTIPLIE (cent un = 101) ;
 *   - après une centaine (>= 100), tout compose (cent vingt, cent seize) ;
 *   - après une dizaine exacte (20/30/40/50/60/80…), unités et 11-19
 *     composent (vingt-deux, trente-six, soixante-seize, quatre-vingt-dix) ;
 *   - sinon (unité suivie d'une unité/dizaine) : DEUX nombres séparés.
 *   (Le « quatre-vingt » FR — 4 puis 20 = 80 — est traité dans compound(),
 *   car il REMPLACE la valeur en cours au lieu de s'y additionner.)
 * @param {number} current - valeur en cours de construction
 * @param {number} value - valeur du token suivant
 * @returns {boolean}
 */
function canCompose(current, value) {
  if (value === 100) return true;
  if (current === 0) return false;
  if (current >= 100) return true;
  if (current % 10 === 0 && value <= 19) return true;
  return false;
}

/**
 * Compose une suite de tokens numériques en un seul nombre — algorithme
 * DÉLIBÉRÉMENT différent par langue, voir l'en-tête du fichier. Peut
 * produire PLUSIEURS nombres (séparés par une espace) quand les tokens ne
 * forment pas un nombre unique valide (« trois seize » -> « 3 16 »).
 * @param {string[]} tokens
 * @param {'fr'|'en'} lang
 * @returns {string}
 */
function compound(tokens, lang) {
  const table = NUMBER_WORDS[lang];
  let current = 0;
  let hasCurrent = false;
  const parts = [];
  for (const token of tokens) {
    const value = table[token];
    if (value === undefined) continue;
    if (value === 100) {
      current = Math.max(1, current) * 100;
      hasCurrent = true;
    } else if (lang === 'fr' && value === 20 && current === 4) {
      current = 80; // quatre-vingt : 4 puis 20 -> 80, pas 24 (remplace, n'additionne pas)
      hasCurrent = true;
    } else if (canCompose(hasCurrent ? current : 0, value)) {
      current += value;
    } else {
      if (hasCurrent) parts.push(String(current));
      current = value;
      hasCurrent = true;
    }
  }
  if (hasCurrent) parts.push(String(current));
  return parts.join(' ');
}

/**
 * Remplace tout nombre écrit en toutes lettres (français ou anglais, selon
 * `lang`) par sa forme chiffrée. Miroir fonctionnel exact de
 * detector.js#numberWordsToDigits (lang='fr') et
 * detector-en.js#numberWordsToDigits (lang='en').
 * @param {string} text - texte déjà normalisé (minuscules, sans accents)
 * @param {'fr'|'en'} [lang] - défaut 'fr' (comportement historique de
 *   detector.js#numberWordsToDigits, qui n'a jamais eu de paramètre de langue)
 * @returns {string}
 */
function numberWordsToDigits(text, lang) {
  const resolvedLang = lang === 'en' ? 'en' : 'fr';
  const connector = CONNECTOR[resolvedLang];
  return text.replace(PATTERNS[resolvedLang], (words) => {
    const tokens = words
      .replace(/-/g, ' ')
      .split(/\s+/)
      .filter((token) => token !== connector);
    return String(compound(tokens, resolvedLang));
  });
}

module.exports = { NUMBER_WORDS, numberWordsToDigits };
