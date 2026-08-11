/**
 * ============================================================================
 *  test-number-words.js — Tests pour number-words.js
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 9) : number-words.js fusionne
 *  mécaniquement les tables NUMBER_WORDS de detector.js et detector-en.js —
 *  ce test vérifie la PARITÉ : chaque nombre écrit en toutes lettres déjà
 *  exercé par test-detector.js/test-detector-en.js (via detect()) doit
 *  produire exactement le même chiffre ici. detector.js/detector-en.js ne
 *  sont pas modifiés dans ce lot (voir le lot 10 pour le cutover) — ce test
 *  ne peut donc PAS comparer contre leurs numberWordsToDigits internes
 *  (non exportées volontairement en dehors de ce lot) ; il compare plutôt
 *  contre les valeurs numériques ATTENDUES déjà verrouillées par les
 *  assertions existantes de ces deux fichiers de test.
 *
 *  Couvre aussi explicitement l'exigence du cahier des charges bilingue :
 *  "quatre-vingt-onze" (FR) et "ninety-one" (EN) doivent tous deux donner
 *  91 — la composition orale diffère entre les deux langues (voir l'en-tête
 *  de number-words.js), pas seulement le vocabulaire.
 * ============================================================================
 */
'use strict';

const assert = require('assert');
const { NUMBER_WORDS, numberWordsToDigits } = require('../number-words');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   ${err.message}`);
    failed++;
  }
}

// ── Structure ──
test('NUMBER_WORDS expose bien deux tables fr et en', () => {
  assert.ok(NUMBER_WORDS.fr && typeof NUMBER_WORDS.fr === 'object');
  assert.ok(NUMBER_WORDS.en && typeof NUMBER_WORDS.en === 'object');
});

test('NUMBER_WORDS.fr contient 79 entrées (miroir exact de detector.js)', () => {
  assert.strictEqual(Object.keys(NUMBER_WORDS.fr).length, 79);
});

test('NUMBER_WORDS.en contient 64 entrées (miroir exact de detector-en.js)', () => {
  assert.strictEqual(Object.keys(NUMBER_WORDS.en).length, 64);
});

// ── Parité FR : mots isolés déjà exercés par test-detector.js ──
// (voir 'Jean chapitre trois verset seize' -> chapter:3, verseStart:16 ;
// 'premier Corinthiens treize versets quatre à sept' -> chapter:13,
// verseStart:4, verseEnd:7)
test("FR: 'trois' -> 3 (test-detector.js: 'Jean chapitre trois verset seize')", () => {
  assert.strictEqual(numberWordsToDigits('trois', 'fr'), '3');
});

test("FR: 'seize' -> 16 (test-detector.js: 'Jean chapitre trois verset seize')", () => {
  assert.strictEqual(numberWordsToDigits('seize', 'fr'), '16');
});

test("FR: 'treize' -> 13 (test-detector.js: 'premier Corinthiens treize versets...')", () => {
  assert.strictEqual(numberWordsToDigits('treize', 'fr'), '13');
});

test("FR: 'quatre' -> 4, 'sept' -> 7 (test-detector.js: '...versets quatre à sept')", () => {
  assert.strictEqual(numberWordsToDigits('quatre', 'fr'), '4');
  assert.strictEqual(numberWordsToDigits('sept', 'fr'), '7');
});

test("FR: phrase complète 'Jean chapitre trois verset seize' -> chiffres corrects", () => {
  assert.strictEqual(
    numberWordsToDigits('jean chapitre trois verset seize', 'fr'),
    'jean chapitre 3 verset 16'
  );
});

// ── Parité EN : mots isolés/composés déjà exercés par test-detector-en.js ──
// (voir 'John chapter three verse sixteen' -> jean/3/16 ; 'Romans chapter
// eight verse twenty-eight' -> romains/8/28, un vrai nombre composé)
test("EN: 'three' -> 3, 'sixteen' -> 16 (test-detector-en.js: 'John chapter three verse sixteen')", () => {
  assert.strictEqual(numberWordsToDigits('three', 'en'), '3');
  assert.strictEqual(numberWordsToDigits('sixteen', 'en'), '16');
});

test("EN: 'eight' -> 8 (test-detector-en.js: 'Romans chapter eight verse twenty-eight')", () => {
  assert.strictEqual(numberWordsToDigits('eight', 'en'), '8');
});

test("EN: 'twenty-eight' -> 28, nombre composé (test-detector-en.js: '...verse twenty-eight')", () => {
  assert.strictEqual(numberWordsToDigits('twenty-eight', 'en'), '28');
  assert.strictEqual(numberWordsToDigits('twenty eight', 'en'), '28');
});

test("EN: phrase complète 'Romans chapter eight verse twenty-eight' -> chiffres corrects", () => {
  assert.strictEqual(
    numberWordsToDigits('romans chapter eight verse twenty-eight', 'en'),
    'romans chapter 8 verse 28'
  );
});

// ── Exigence explicite du cahier des charges bilingue : composition
// orale différente FR/EN pour le même nombre (91) ──
test("FR: 'quatre-vingt-onze' -> 91 (composition FR spécifique : 4 puis 20 -> 80, pas 24)", () => {
  assert.strictEqual(numberWordsToDigits('quatre-vingt-onze', 'fr'), '91');
  assert.strictEqual(numberWordsToDigits('quatre vingt onze', 'fr'), '91');
});

test("EN: 'ninety-one' -> 91 (composition EN : simple addition, pas de règle spéciale)", () => {
  assert.strictEqual(numberWordsToDigits('ninety-one', 'en'), '91');
  assert.strictEqual(numberWordsToDigits('ninety one', 'en'), '91');
});

test("FR: 'quatre-vingt' seul -> 80 (pas 24)", () => {
  assert.strictEqual(numberWordsToDigits('quatre-vingt', 'fr'), '80');
});

// ── Composition avec centaines (règle commune aux deux langues, testée
// séparément par langue) ──
test("FR: 'cent' -> 100, 'cent un' -> 101, 'deux cent cinquante' -> 250", () => {
  assert.strictEqual(numberWordsToDigits('cent', 'fr'), '100');
  assert.strictEqual(numberWordsToDigits('cent un', 'fr'), '101');
  assert.strictEqual(numberWordsToDigits('deux cent cinquante', 'fr'), '250');
});

test("EN: 'hundred' -> 100, 'one hundred one' -> 101, 'two hundred fifty' -> 250", () => {
  assert.strictEqual(numberWordsToDigits('hundred', 'en'), '100');
  assert.strictEqual(numberWordsToDigits('one hundred one', 'en'), '101');
  assert.strictEqual(numberWordsToDigits('two hundred fifty', 'en'), '250');
});

// ── Mot de liaison ("et"/"and") ignoré, pas confondu avec un chiffre ──
test("FR: 'vingt et un' -> 21 ('et' est un connecteur, pas un nombre)", () => {
  assert.strictEqual(numberWordsToDigits('vingt et un', 'fr'), '21');
});

test("EN: 'one hundred and one' -> 101 ('and' est un connecteur, pas un nombre)", () => {
  assert.strictEqual(numberWordsToDigits('one hundred and one', 'en'), '101');
});

// ── Défaut sans langue explicite : comportement historique de
// detector.js#numberWordsToDigits (jamais eu de paramètre de langue) ──
test("sans langue explicite, retombe sur 'fr' (comportement historique de detector.js)", () => {
  assert.strictEqual(numberWordsToDigits('trois'), '3');
});

console.log(`\n=== Résultat test-number-words : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) process.exit(1);
