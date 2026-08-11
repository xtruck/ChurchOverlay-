/**
 * ============================================================================
 *  test-keyword-variants.js — Tests pour keyword-variants.js
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 11a) : keyword-variants.js fusionne
 *  CHAPITRE_VARIANTS/VERSET_VARIANTS (detector.js) et CHAPTER_VARIANTS/
 *  VERSE_VARIANTS (detector-en.js). Ce test verrouille deux choses :
 *   1. le contenu reste identique aux quatre littéraux d'origine (garde-fou
 *      anti-dérive, comme test-book-catalog.js au lot 8) ;
 *   2. un CONTRÔLE DE COLLISION programmatique — pas un coup d'œil ponctuel —
 *      confirmant qu'aucune variante phonétique FR ne coïncide avec un mot EN
 *      légitime (ou l'inverse) SANS que ce soit documenté explicitement ici.
 *      Doit rester dans la suite de tests en permanence : ces listes
 *      grandissent avec le temps (nouvelles déformations Whisper observées
 *      en conditions réelles), et une collision non voulue pourrait faire
 *      qu'un détecteur réécrive silencieusement un mot de l'AUTRE langue.
 * ============================================================================
 */
'use strict';

const assert = require('assert');
const { KEYWORD_VARIANTS } = require('../keyword-variants');

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
test('KEYWORD_VARIANTS expose bien chapitre et verset, chacun avec fr/en', () => {
  assert.ok(Array.isArray(KEYWORD_VARIANTS.chapitre.fr));
  assert.ok(Array.isArray(KEYWORD_VARIANTS.chapitre.en));
  assert.ok(Array.isArray(KEYWORD_VARIANTS.verset.fr));
  assert.ok(Array.isArray(KEYWORD_VARIANTS.verset.en));
});

// ── Fidélité au contenu d'origine (miroir exact des littéraux historiques
// de detector.js/detector-en.js — jamais réexportés hors de ce test, donc
// retapés ici à l'identique et verrouillés une fois pour toutes) ──
test('chapitre.fr est identique au CHAPITRE_VARIANTS historique de detector.js', () => {
  assert.deepStrictEqual(KEYWORD_VARIANTS.chapitre.fr, [
    'chapitre',
    'chappitois',
    'sabitoire',
    'chabitouale',
    'sapitois',
    'chapitois',
    'chappitre',
    'chappite',
    'chapite',
    'chapit',
    'chaptre',
  ]);
});

test('verset.fr est identique au VERSET_VARIANTS historique de detector.js', () => {
  assert.deepStrictEqual(KEYWORD_VARIANTS.verset.fr, [
    'verset',
    'versets',
    'vecc',
    'vece',
    'vsc',
    'vc',
    'veille',
    'versai',
    'verse',
    'verce',
    'vercet',
    'versait',
    'versus',
  ]);
});

test('chapitre.en est identique au CHAPTER_VARIANTS historique de detector-en.js', () => {
  assert.deepStrictEqual(KEYWORD_VARIANTS.chapitre.en, ['chapter', 'chapters', 'chap', 'chpt']);
});

test('verset.en est identique au VERSE_VARIANTS historique de detector-en.js', () => {
  assert.deepStrictEqual(KEYWORD_VARIANTS.verset.en, ['verse', 'verses', 'vs', 'v', 'vers']);
});

// ── Contrôle de collision FR/EN (le cœur de ce lot) ──
// Toute collision AU-DELÀ de cette liste explicite doit faire échouer ce
// test — c'est le signal qu'une nouvelle variante ajoutée d'un côté
// coïncide accidentellement avec un mot légitime de l'autre langue.
const KNOWN_SAFE_COLLISIONS = new Set([
  // 'verse' est à la fois une variante phonétique FR de "verset" (Whisper
  // avale parfois la syllabe finale) ET le mot anglais canonique lui-même.
  // SANS IMPACT PRATIQUE : la correction FR ne fait que réécrire "verse" en
  // "verset" AVANT la correspondance d'alias de livre, qui reste ensuite
  // strictement française — une phrase anglaise ("John chapter 3 verse 16")
  // ne matche jamais le détecteur FR (aucun alias FR ne contient "john"),
  // collision ou pas. Voir l'en-tête de keyword-variants.js.
  'verse',
]);

test('aucune collision FR/EN au-delà de la liste explicitement documentée', () => {
  const frAll = [...KEYWORD_VARIANTS.chapitre.fr, ...KEYWORD_VARIANTS.verset.fr];
  const enAll = [...KEYWORD_VARIANTS.chapitre.en, ...KEYWORD_VARIANTS.verset.en];
  const overlap = frAll.filter((word) => enAll.includes(word));
  const unexpected = overlap.filter((word) => !KNOWN_SAFE_COLLISIONS.has(word));
  assert.deepStrictEqual(
    unexpected,
    [],
    `collision(s) FR/EN non documentée(s) trouvée(s) : ${JSON.stringify(unexpected)} — ` +
      'ajouter au KNOWN_SAFE_COLLISIONS ci-dessus avec une justification, ou corriger la liste fautive'
  );
});

test("la collision documentée ('verse') existe bien — ce test échouerait si elle disparaissait un jour", () => {
  const frAll = [...KEYWORD_VARIANTS.chapitre.fr, ...KEYWORD_VARIANTS.verset.fr];
  const enAll = [...KEYWORD_VARIANTS.chapitre.en, ...KEYWORD_VARIANTS.verset.en];
  const overlap = frAll.filter((word) => enAll.includes(word));
  assert.deepStrictEqual(overlap, ['verse']);
});

console.log(`\n=== Résultat test-keyword-variants : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) process.exit(1);
