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

console.log('\n=== Tous les tests detector-en OK ===');
