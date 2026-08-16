/**
 * ============================================================================
 *  test-detector-compat.js — Tests pour detector-compat.js#detectBilingual
 * ----------------------------------------------------------------------------
 *  AJOUT (Chantier A.2 — mission autonome, "double détection FR/EN") :
 *  jusqu'ici, le repli flou de detectBilingual() essayait FR PUIS EN,
 *  s'arrêtant au premier qui matchait (voir bilingual-matcher.js — la phase
 *  EXACTE, elle, entrelaçait déjà les deux langues depuis le lot 11b). Un
 *  repli flou français plus faible pouvait donc "gagner" contre un repli
 *  anglais qui n'avait simplement jamais sa chance. detectBilingual()
 *  calcule désormais TOUJOURS les deux, et retient la meilleure
 *  correspondance (distance de correction la plus faible, puis la langue de
 *  la session ASR en cas d'égalité stricte — voir son en-tête pour le
 *  détail complet de la règle).
 *
 *  Les cas ci-dessous fabriquent des résultats FR/EN CONTRÔLÉS (module
 *  './detector'/'./detector-en' remplacés par de faux exports AVANT le
 *  premier require de detector-compat.js — même technique que
 *  integration-scene-crud.js/test-caption-translator.js) plutôt que de
 *  chercher des phrases réelles produisant la collision exacte voulue : la
 *  logique de comparaison est testée en isolation, indépendamment de la
 *  qualité du fuzzy-matching réel (déjà couvert par test-detector-bilingual.js
 *  et test-detector.js/test-detector-en.js).
 * ============================================================================
 */
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

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

// --- Fixtures : deux faux détecteurs entièrement contrôlés -----------------
// bilingualMatcher.detectBilingualExact() est mocké à null systématiquement
// (jamais de correspondance exacte) pour forcer detectBilingual() sur le
// chemin flou étudié ici — testAlias n'est jamais appelé par ces fixtures,
// donc aucune dépendance à book-catalog.js n'est nécessaire.
let frDetectResult = null;
let enDetectResult = null;

injectFakeModule('detector.js', {
  detectExact: () => null,
  detect: () => frDetectResult,
  numberWordsToDigits: (t) => t,
  normalize: (t) => t,
  testAlias: () => null,
  aliases: [],
});
injectFakeModule('detector-en.js', {
  detectExact: () => null,
  detect: () => enDetectResult,
  numberWordsToDigits: (t) => t,
  normalizeKeywords: (t) => t,
  normalize: (t) => t,
  testAlias: () => null,
  aliases: [],
});
injectFakeModule('bilingual-matcher.js', {
  detectBilingualExact: () => null,
  COMBINED_ALIASES: [],
});

const { detectBilingual } = require('../detector-compat');

test('un seul des deux réplis flous matche -> celui-là est retenu, tagué avec sa langue', () => {
  frDetectResult = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, fuzzyDistance: 2 };
  enDetectResult = null;
  const result = detectBilingual('texte quelconque');
  assert.ok(result);
  assert.strictEqual(result.book, 'jean');
  assert.strictEqual(result.lang, 'fr');
});

test('symétrique : seul EN matche -> retenu, tagué en', () => {
  frDetectResult = null;
  enDetectResult = { book: 'romains', chapter: 8, verseStart: 28, verseEnd: 28, fuzzyDistance: 1 };
  const result = detectBilingual('some text');
  assert.ok(result);
  assert.strictEqual(result.book, 'romains');
  assert.strictEqual(result.lang, 'en');
});

test('aucun des deux ne matche -> null, pas de plantage', () => {
  frDetectResult = null;
  enDetectResult = null;
  assert.strictEqual(detectBilingual('bruit sans référence'), null);
});

test('les deux matchent, distances différentes -> la distance la plus faible gagne (FR ici)', () => {
  frDetectResult = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, fuzzyDistance: 1 };
  enDetectResult = { book: 'romains', chapter: 8, verseStart: 28, verseEnd: 28, fuzzyDistance: 3 };
  const result = detectBilingual('texte mixte');
  assert.strictEqual(result.book, 'jean', 'distance 1 (FR) doit battre distance 3 (EN)');
  assert.strictEqual(result.lang, 'fr');
});

test('symétrique : distance EN plus faible -> EN gagne malgré le défaut historique FR', () => {
  frDetectResult = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, fuzzyDistance: 3 };
  enDetectResult = { book: 'romains', chapter: 8, verseStart: 28, verseEnd: 28, fuzzyDistance: 1 };
  const result = detectBilingual('texte mixte');
  assert.strictEqual(result.book, 'romains', 'distance 1 (EN) doit battre distance 3 (FR)');
  assert.strictEqual(result.lang, 'en');
});

test('distances EGALES, sans langue de session -> le français reste le défaut (comportement historique préservé)', () => {
  frDetectResult = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, fuzzyDistance: 2 };
  enDetectResult = { book: 'romains', chapter: 8, verseStart: 28, verseEnd: 28, fuzzyDistance: 2 };
  const result = detectBilingual('texte ambigu');
  assert.strictEqual(result.lang, 'fr');
  assert.strictEqual(result.book, 'jean');
});

test("distances EGALES, session réglée sur 'en' -> l'anglais départage", () => {
  frDetectResult = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, fuzzyDistance: 2 };
  enDetectResult = { book: 'romains', chapter: 8, verseStart: 28, verseEnd: 28, fuzzyDistance: 2 };
  const result = detectBilingual('texte ambigu', 'en');
  assert.strictEqual(result.lang, 'en');
  assert.strictEqual(result.book, 'romains');
});

test("distances EGALES, session réglée sur 'fr' -> le français départage explicitement aussi", () => {
  frDetectResult = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, fuzzyDistance: 2 };
  enDetectResult = { book: 'romains', chapter: 8, verseStart: 28, verseEnd: 28, fuzzyDistance: 2 };
  const result = detectBilingual('texte ambigu', 'fr');
  assert.strictEqual(result.lang, 'fr');
});

test(
  "distances EGALES, session réglée sur 'multi' (code-switching, ni fr ni en) -> défaut FR, " +
    'pas de plantage sur une valeur inattendue',
  () => {
    frDetectResult = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, fuzzyDistance: 2 };
    enDetectResult = {
      book: 'romains',
      chapter: 8,
      verseStart: 28,
      verseEnd: 28,
      fuzzyDistance: 2,
    };
    const result = detectBilingual('texte ambigu', 'multi');
    assert.strictEqual(result.lang, 'fr');
  }
);

console.log(`\n=== Résultat test-detector-compat : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) process.exit(1);
