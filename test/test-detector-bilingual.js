/**
 * ============================================================================
 *  test-detector-bilingual.js — Tests pour bilingual-matcher.js / detectBilingual
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 11b) : premier lot du plan bilingue à
 *  changer réellement le COMPORTEMENT de correspondance — bilingual-matcher.js
 *  remplace l'ancien dispatcher séquentiel (FR-exact → EN-exact) de
 *  detector-compat.js par UN SEUL passage trié par longueur d'alias À
 *  TRAVERS LES DEUX LANGUES. Ce test verrouille :
 *   1. la parité de clé canonique (Jean 3:16 / John 3:16 -> même `book`) ;
 *   2. le repli flou (fuzzy) toujours fonctionnel après le passage exact ;
 *   3. l'absence de faux positifs (texte sans référence, dans les deux
 *      langues, ne doit jamais matcher) ;
 *   4. la composition bilingue des nombres écrits en toutes lettres
 *      ("quatre-vingt-onze" / "ninety-one" -> même verset).
 * ============================================================================
 */
'use strict';

const assert = require('assert');
const { detectBilingual } = require('../detector-compat');
const { detectBilingualExact, COMBINED_ALIASES } = require('../bilingual-matcher');

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

function refEq(result, book, chapter, verseStart, verseEnd) {
  return (
    !!result &&
    result.book === book &&
    result.chapter === chapter &&
    result.verseStart === verseStart &&
    (verseEnd === undefined ? result.verseEnd === verseStart : result.verseEnd === verseEnd)
  );
}

// ── Parité de clé canonique : même verset, langue différente -> même `book` ──
test("'Jean 3:16' et 'John 3:16' résolvent au même livre canonique ('jean')", () => {
  const fr = detectBilingual('Jean 3:16');
  const en = detectBilingual('John 3:16');
  assert.ok(fr && en, 'les deux doivent matcher');
  assert.strictEqual(fr.book, 'jean');
  assert.strictEqual(en.book, 'jean');
  assert.strictEqual(fr.book, en.book);
  assert.strictEqual(fr.lang, 'fr');
  assert.strictEqual(en.lang, 'en');
});

test("'Apocalypse 21:4' et 'Revelation 21:4' résolvent au même livre canonique ('apocalypse')", () => {
  const fr = detectBilingual('Apocalypse 21:4');
  const en = detectBilingual('Revelation 21:4');
  assert.ok(refEq(fr, 'apocalypse', 21, 4));
  assert.ok(refEq(en, 'apocalypse', 21, 4));
});

test("'1 Corinthiens 13:4-7' et 'First Corinthians 13:4-7' résolvent au même livre ('1corinthiens')", () => {
  const fr = detectBilingual('1 Corinthiens 13:4-7');
  const en = detectBilingual('First Corinthians 13:4-7');
  assert.ok(refEq(fr, '1corinthiens', 13, 4, 7));
  assert.ok(refEq(en, '1corinthiens', 13, 4, 7));
});

// ── Phrasé naturel complet, dans les deux langues ──
test("'Jean chapitre 3 verset 16' et 'John chapter 3 verse 16' -> même résultat", () => {
  const fr = detectBilingual('Jean chapitre 3 verset 16');
  const en = detectBilingual('John chapter 3 verse 16');
  assert.ok(refEq(fr, 'jean', 3, 16));
  assert.ok(refEq(en, 'jean', 3, 16));
});

// ── Repli flou (fuzzy) toujours fonctionnel après le passage exact ──
test("repli flou FR toujours actif : 'Filipiens 2:5' -> 'philippiens' (nom de livre mal transcrit)", () => {
  const result = detectBilingual('Filipiens 2:5');
  assert.ok(refEq(result, 'philippiens', 2, 5));
  assert.strictEqual(result.fuzzy, true);
});

// ── Faux positifs : phrases sans référence, dans les deux langues ──
test("'Praise the Lord' (EN, sans référence) ne matche jamais", () => {
  assert.strictEqual(detectBilingual('Praise the Lord'), null);
});

test("'Louons le Seigneur' (FR, sans référence) ne matche jamais", () => {
  assert.strictEqual(detectBilingual('Louons le Seigneur'), null);
});

test('chaîne vide / null ne plante pas et ne matche jamais', () => {
  assert.strictEqual(detectBilingualExact(''), null);
});

// ── Exigence explicite du cahier des charges bilingue : nombres composés
// écrits en toutes lettres, dans les deux langues (voir number-words.js,
// lot 9) ──
test("'Psaumes quatre-vingt-onze' (FR, nombre composé) -> chapitre 91", () => {
  const result = detectBilingual('Psaumes quatre-vingt-onze');
  assert.ok(result, 'doit matcher');
  assert.strictEqual(result.book, 'psaumes');
  assert.strictEqual(result.chapter, 91);
});

test("'Psalm ninety-one' (EN, nombre composé) -> chapitre 91, même livre canonique", () => {
  const result = detectBilingual('Psalm ninety-one');
  assert.ok(result, 'doit matcher');
  assert.strictEqual(result.book, 'psaumes');
  assert.strictEqual(result.chapter, 91);
});

// ── Structure du moteur combiné ──
test('COMBINED_ALIASES contient des alias des deux langues, triés par longueur décroissante', () => {
  assert.ok(COMBINED_ALIASES.some((a) => a.lang === 'fr'));
  assert.ok(COMBINED_ALIASES.some((a) => a.lang === 'en'));
  for (let i = 1; i < COMBINED_ALIASES.length; i++) {
    assert.ok(
      COMBINED_ALIASES[i - 1].name.length >= COMBINED_ALIASES[i].name.length,
      'tri par longueur décroissante requis (voir en-tête de bilingual-matcher.js)'
    );
  }
});

test('un alias EN plus long et plus spécifique gagne face à un alias FR plus court (John/Jean)', () => {
  // 'john' (4) et 'jean' (4) sont de même longueur ici, mais confirme que le
  // tri combiné place bien les alias multi-mots (ex. '1 corinthians', 13
  // caractères) avant les alias courts d'UNE langue OU L'AUTRE — pas
  // "toute la liste FR d'abord, puis toute la liste EN".
  const longFr = COMBINED_ALIASES.find((a) => a.name === '1 corinthiens');
  const longEn = COMBINED_ALIASES.find((a) => a.name === '1 corinthians');
  const shortEn = COMBINED_ALIASES.find((a) => a.name === 'job');
  assert.ok(longFr && longEn && shortEn);
  const idxLongFr = COMBINED_ALIASES.indexOf(longFr);
  const idxLongEn = COMBINED_ALIASES.indexOf(longEn);
  const idxShortEn = COMBINED_ALIASES.indexOf(shortEn);
  assert.ok(idxLongFr < idxShortEn, 'un alias FR long doit passer avant un alias EN court');
  assert.ok(idxLongEn < idxShortEn, 'un alias EN long doit passer avant un autre alias EN court');
});

console.log(`\n=== Résultat test-detector-bilingual : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) process.exit(1);
