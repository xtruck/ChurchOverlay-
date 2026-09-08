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
  COMBINED_ALIASES.some((a) => a.lang === 'fr') && COMBINED_ALIASES.some((a) => a.lang === 'en')
);
check(
  'COMBINED_ALIASES triés par longueur décroissante',
  COMBINED_ALIASES.every((a, i) => i === 0 || a.name.length <= COMBINED_ALIASES[i - 1].name.length)
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
check(
  'texte sans référence: retourne null',
  detectBilingualExact('bonjour tout le monde') === null
);
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

// ==========================================================================
// AJOUT (Axe 3 — plages de versets complexes en langage naturel, ex.
// "Jean 3:16 à 18" / "John 3:16 to 18") : le parsing de plage (verseStart/
// verseEnd) existait DÉJÀ dans detector.js/detector-en.js (le groupe de
// séparateur `(?:-|a|à|au)` en FR, `(?:-|to|through)` en EN), réutilisé TEL
// QUEL ici via testAlias() — voir l'en-tête du fichier. Cette section
// verrouille ce comportement au niveau du PASSAGE BILINGUE combiné
// (detectBilingualExact), qui n'avait jusqu'ici aucune couverture de test
// sur les plages, dans aucune des deux langues.
// ==========================================================================
console.log('\n--- Plages de versets complexes (Axe 3) ---');

check(
  'plage FR: "jean 3:16 à 18" → verseStart=16, verseEnd=18',
  (() => {
    const r = detectBilingualExact('jean 3:16 à 18');
    return r && r.verseStart === 16 && r.verseEnd === 18 && r.lang === 'fr';
  })()
);
check(
  'plage FR: "à" et "-" équivalents ("jean 3:16-18")',
  (() => {
    const r = detectBilingualExact('jean 3:16-18');
    return r && r.verseStart === 16 && r.verseEnd === 18;
  })()
);
check(
  'plage FR: forme longue "jean chapitre 3 verset 16 à 18"',
  (() => {
    const r = detectBilingualExact('jean chapitre 3 verset 16 à 18');
    return r && r.chapter === 3 && r.verseStart === 16 && r.verseEnd === 18 && r.lang === 'fr';
  })()
);
check(
  'plage FR: séparateur "au" ("jean 3:16 au 18")',
  (() => {
    const r = detectBilingualExact('jean 3:16 au 18');
    return r && r.verseStart === 16 && r.verseEnd === 18;
  })()
);

check(
  'plage EN: "john 3:16 to 18" → verseStart=16, verseEnd=18',
  (() => {
    const r = detectBilingualExact('john 3:16 to 18');
    return r && r.verseStart === 16 && r.verseEnd === 18 && r.lang === 'en';
  })()
);
check(
  'plage EN: "-" équivalent ("john 3:16-18")',
  (() => {
    const r = detectBilingualExact('john 3:16-18');
    return r && r.verseStart === 16 && r.verseEnd === 18;
  })()
);
check(
  'plage EN: forme longue "john chapter 3 verse 16 to 18"',
  (() => {
    const r = detectBilingualExact('john chapter 3 verse 16 to 18');
    return r && r.chapter === 3 && r.verseStart === 16 && r.verseEnd === 18 && r.lang === 'en';
  })()
);
check(
  'plage EN: séparateur "through" ("john 3:16 through 18")',
  (() => {
    const r = detectBilingualExact('john 3:16 through 18');
    return r && r.verseStart === 16 && r.verseEnd === 18;
  })()
);

// --- Synchronisation FR/EN : la MÊME plage logique, dans les deux langues,
// doit produire des verseStart/verseEnd IDENTIQUES (seuls book/lang/raw
// diffèrent) — c'est cette égalité qui permet à server.js de récupérer
// EXACTEMENT la même plage dans les deux traductions pour l'affichage
// bilingue simultané (voir bible-lookup-with-api.js#getVerseMultilang, qui
// transmet reference.verseStart/verseEnd tel quel aux deux langues).
check(
  'synchronisation FR/EN : même plage logique → mêmes verseStart/verseEnd',
  (() => {
    const fr = detectBilingualExact('jean 3:16 à 18');
    const en = detectBilingualExact('john 3:16 to 18');
    return (
      fr &&
      en &&
      fr.book === en.book && // les deux résolvent vers le même livre interne ("jean")
      fr.chapter === en.chapter &&
      fr.verseStart === en.verseStart &&
      fr.verseEnd === en.verseEnd
    );
  })()
);

// --- Un seul verset (pas de plage) : verseEnd retombe sur verseStart —
// comportement de base sur lequel repose la synchronisation ci-dessus.
check(
  'verset unique (sans plage) : verseEnd === verseStart',
  (() => {
    const r = detectBilingualExact('jean 3:16');
    return r && r.verseStart === 16 && r.verseEnd === 16;
  })()
);

// --- Plage invalide (fin avant début) : rejetée, pas de résultat aberrant.
check(
  'plage invalide (fin < début) : rejetée (null)',
  detectBilingualExact('jean 3:18 à 16') === null
);

console.log(`\n=== Résultat bilingual-matcher : ${passed}/${passed + failed} ===`);
if (failed > 0) process.exit(1);
