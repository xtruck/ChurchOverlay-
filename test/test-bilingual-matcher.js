'use strict';
/**
 * Tests unitaires pour bilingual-matcher.js — detectBilingualExact().
 * Couvre : détection FR, détection EN, casse, texte vide, confidence.
 * Note: les noms de livres sont internes (ex: "john" → book "jean").
 */
const assert = require('assert');
const { detectBilingualExact, COMBINED_ALIASES } = require('../bilingual-matcher');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

console.log('=== Tests bilingual-matcher.js ===');

check(
  'COMBINED_ALIASES contient des alias FR et EN',
  COMBINED_ALIASES.some((a) => a.lang === 'fr') &&
    COMBINED_ALIASES.some((a) => a.lang === 'en')
);
check(
  'COMBINED_ALIASES triés par longueur décroissante',
  COMBINED_ALIASES.every(
    (a, i) => i === 0 || a.name.length <= COMBINED_ALIASES[i - 1].name.length
  )
);

// --- Détection FR ---
check(
  'détection FR: jean 3:16',
  (() => {
    const r = detectBilingualExact(' jean 3:16 ');
    return r && r.book === 'jean' && r.chapter === 3 && r.verseStart === 16 && r.lang === 'fr';
  })()
);
check(
  'détection FR: genese 1',
  (() => {
    const r = detectBilingualExact('genese 1');
    return r && r.book === 'genese' && r.chapter === 1 && r.lang === 'fr';
  })()
);
check(
  'détection FR: matthieu 5:3',
  (() => {
    const r = detectBilingualExact('matthieu 5:3');
    return r && r.book === 'matthieu' && r.chapter === 5 && r.verseStart === 3 && r.lang === 'fr';
  })()
);

// --- Détection EN (book names are internal: john→jean, genesis→genese, psalm→psaumes) ---
check(
  'détection EN: john 3:16 (book interne = jean)',
  (() => {
    const r = detectBilingualExact('john 3:16');
    return r && r.book === 'jean' && r.chapter === 3 && r.verseStart === 16 && r.lang === 'en';
  })()
);
check(
  'détection EN: genesis 1 (book interne = genese)',
  (() => {
    const r = detectBilingualExact('genesis 1');
    return r && r.book === 'genese' && r.chapter === 1 && r.lang === 'en';
  })()
);
check(
  'détection EN: psalm 23 (book interne = psaumes)',
  (() => {
    const r = detectBilingualExact('psalm 23');
    return r && r.book === 'psaumes' && r.chapter === 23 && r.lang === 'en';
  })()
);
check(
  'détection EN: matthew 5:3 (book interne = matthieu)',
  (() => {
    const r = detectBilingualExact('matthew 5:3');
    return r && r.book === 'matthieu' && r.chapter === 5 && r.verseStart === 3 && r.lang === 'en';
  })()
);

// --- Texte sans référence ---
check('texte sans référence: retourne null', detectBilingualExact('bonjour tout le monde') === null);
check('texte vide: retourne null', detectBilingualExact('') === null);
check('texte null: retourne null', detectBilingualExact(null) === null);

// --- Confidence ---
check(
  'confidence high quand verseStart défini',
  (() => {
    const r = detectBilingualExact('jean 3:16');
    return r && r.confidence === 'high';
  })()
);
check(
  'confidence medium quand chapter only',
  (() => {
    const r = detectBilingualExact('jean 3');
    return r && r.confidence === 'medium';
  })()
);

// --- Raw field ---
check(
  'raw field présent',
  (() => {
    const r = detectBilingualExact('romains 8:28');
    return r && typeof r.raw === 'string' && r.raw.includes('8');
  })()
);

// --- Livres EN avec book interne correct ---
check(
  'exodus maps to book exode',
  (() => {
    const r = detectBilingualExact('exodus 1');
    return r && r.book === 'exode' && r.lang === 'en';
  })()
);
check(
  'romans maps to book romains',
  (() => {
    const r = detectBilingualExact('romans 8');
    return r && r.book === 'romains' && r.lang === 'en';
  })()
);

console.log(`\n=== Résultat bilingual-matcher : ${passed}/${passed + failed} ===`);
if (failed > 0) process.exit(1);
