/**
 * Tests unitaires pour detector-en.js.
 * Reprend la même structure/style que test-detector.js (sortie [TEST] ✓/✗)
 * pour intégration transparente dans `npm test`.
 */
'use strict';

const detector = require('../detector-en');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}
function refEq(r, book, chapter, vs, ve) {
  return (
    r &&
    r.book === book &&
    r.chapter === chapter &&
    r.verseStart === vs &&
    r.verseEnd === (ve === undefined ? vs : ve)
  );
}

console.log('=== Tests detector-en.js ===');

// --- Détections positives : formats classiques ---
assert(refEq(detector.detect('John 3:16'), 'jean', 3, 16), 'John 3:16');
assert(refEq(detector.detect('John chapter 3 verse 16'), 'jean', 3, 16), 'John chapter 3 verse 16');
assert(refEq(detector.detect('John 3 verse 16'), 'jean', 3, 16), 'John 3 verse 16');
assert(
  refEq(detector.detect('John chapter 3, verse 16'), 'jean', 3, 16),
  'John chapter 3, verse 16'
);
assert(refEq(detector.detect('John 3:16-18'), 'jean', 3, 16, 18), 'John 3:16-18 (plage)');
assert(
  refEq(detector.detect('John chapter 3 verses 16 to 18'), 'jean', 3, 16, 18),
  'John chapter 3 verses 16 to 18'
);
assert(refEq(detector.detect('John 3:16 through 18'), 'jean', 3, 16, 18), 'John 3:16 through 18');

// --- Chapitre seul (doit être détecté) ---
const psOnly = detector.detect('Psalm 23');
assert(
  psOnly && psOnly.book === 'psaumes' && psOnly.chapter === 23 && psOnly.verseStart === undefined,
  'Psalm 23 (chapitre seul)'
);

// --- Livres numérotés (ordinal / arabe / romain) ---
assert(refEq(detector.detect('1 Corinthians 13:4'), '1corinthiens', 13, 4), '1 Corinthians 13:4');
assert(
  refEq(detector.detect('First Corinthians 13:4-7'), '1corinthiens', 13, 4, 7),
  'First Corinthians 13:4-7'
);
assert(
  refEq(detector.detect('II Timothy 3:16'), '2timothee', 3, 16),
  'II Timothy 3:16 (numéral romain)'
);
assert(refEq(detector.detect('Second Timothy 3:16'), '2timothee', 3, 16), 'Second Timothy 3:16');

// --- Abréviations ---
assert(refEq(detector.detect('Rom 8:28'), 'romains', 8, 28), 'Rom 8:28');
assert(refEq(detector.detect('Rev 21:4'), 'apocalypse', 21, 4), 'Rev 21:4');
assert(refEq(detector.detect('Matt 5:3'), 'matthieu', 5, 3), 'Matt 5:3');

// --- Chiffres en toutes lettres ---
const jw = detector.detect('John chapter three verse sixteen');
assert(refEq(jw, 'jean', 3, 16), 'John chapter three verse sixteen (mots → chiffres)');
const rw = detector.detect('Romans chapter eight verse twenty-eight');
assert(refEq(rw, 'romains', 8, 28), 'Romans chapter eight verse twenty-eight');

// --- Variantes phonétiques Whisper (chap/vs) ---
assert(refEq(detector.detect('John chap 3 vs 16'), 'jean', 3, 16), 'John chap 3 vs 16 (variantes)');

// --- Non-détections : phrases anglaises sans référence ---
assert(detector.detect('Praise the Lord') === null, 'Praise the Lord (aucune réf)');
assert(detector.detect('Thank you very much') === null, 'Thank you very much (aucune réf)');
assert(detector.detect('') === null, 'Chaîne vide');
assert(detector.detect(null) === null, 'null');

// --- Validation des plages ---
assert(detector.detect('John 200:16') === null, 'Chapitre > 150 rejeté');
assert(detector.detect('John 3:250') === null, 'Verset > 200 rejeté');

// --- Alias 'i' pour "I John" (utilise \b, donc "i john" doit matcher) ---
assert(refEq(detector.detect('I John 4:8'), '1jean', 4, 8), 'I John 4:8');

// --- AJOUT (Chantier A.1 — livres à chapitre unique) : Philemon, Jude,
// 2 John, 3 John n'ont qu'un seul chapitre — miroir de test-detector.js (FR).
// Corpus réel (B2/D3) : le pattern standard exige toujours un numéro de
// chapitre, "Philemon verse 6" renvoyait null avant ce correctif. ---
assert(refEq(detector.detect('Philemon verse 6'), 'philemon', 1, 6), 'Philemon verse 6');
assert(
  refEq(detector.detect('Philemon 6'), 'philemon', 1, 6),
  'Philemon 6 (un seul nombre -> verset, jamais chapitre 6 inexistant)'
);
assert(refEq(detector.detect('verse 6 of Philemon'), 'philemon', 1, 6), 'verse 6 of Philemon');
assert(refEq(detector.detect('Jude verse 3'), 'jude', 1, 3), 'Jude verse 3');
assert(refEq(detector.detect('2 John verse 5'), '2jean', 1, 5), '2 John verse 5');
assert(refEq(detector.detect('3 John verse 2'), '3jean', 1, 2), '3 John verse 2');
assert(
  refEq(detector.detect('Philemon chapter 1 verse 6'), 'philemon', 1, 6),
  'Philemon chapter 1 verse 6 (forme explicite, chemin standard inchangé)'
);
assert(refEq(detector.detect('Jude verses 3 to 5'), 'jude', 1, 3, 5), 'Jude verses 3 to 5 (plage)');
// Un livre à chapitres multiples ne doit jamais être réinterprété.
const johnSix = detector.detect('John 6');
assert(
  johnSix && johnSix.chapter === 6 && johnSix.verseStart === undefined,
  'John 6 reste chapitre 6, jamais réinterprété en verset'
);

// AJOUT (Chantier A.3 — mission autonome, miroir de detector.js) : la forme
// avec l'article « the » ou le mot « number » doit capturer le verset exact.
assert(
  refEq(detector.detect('Isaiah 48, the verse 3'), 'esaie', 48, 3),
  'Isaiah 48, the verse 3 (article the)'
);
assert(
  refEq(detector.detect('John 14, verse number 6'), 'jean', 14, 6),
  'John 14, verse number 6 (mot number)'
);
assert(
  refEq(detector.detect('John 14 the verse 6'), 'jean', 14, 6),
  'John 14 the verse 6 (article sans virgule)'
);
assert(
  refEq(detector.detect('John chapter 3, the verse 16'), 'jean', 3, 16),
  'John chapter 3, the verse 16'
);
assert(
  refEq(detector.detect('John 3, the verse 16 to 18'), 'jean', 3, 16, 18),
  'John 3, the verse 16 to 18 (plage avec article)'
);
// Garde-fou : « and » seul (liste de chapitres) ne doit jamais capturer un
// faux verset — tout au plus une référence chapitre seule.
const enFp = detector.detect('John 2, and 3');
assert(
  enFp && enFp.verseStart === undefined,
  'le connecteur « and » seul ne doit pas capturer un faux verset'
);

console.log('\n=== Tous les tests detector-en OK ===');
