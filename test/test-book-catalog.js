/**
 * ============================================================================
 *  test-book-catalog.js — Tests pour book-catalog.js
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 8) : book-catalog.js est une fusion
 *  MÉCANIQUE des tables BOOKS de detector.js (français) et detector-en.js
 *  (anglais) — les deux fichiers exportaient déjà chacune leur BOOKS avant ce
 *  lot. Ce test est le nouveau garde-fou anti-dérive : il vérifie que le
 *  catalogue fusionné reste, à tout moment, EXACTEMENT égal aux deux
 *  originaux (mêmes clés, mêmes alias, dans le même ordre) — rien n'existait
 *  avant ce lot pour empêcher ces deux fichiers de diverger silencieusement.
 *
 *  detector.js et detector-en.js ne sont PAS modifiés dans ce lot — voir le
 *  lot 10 (cutover) pour le remplacement de leurs BOOKS littéraux par un
 *  import de ce catalogue.
 * ============================================================================
 */
'use strict';

const assert = require('assert');
const { BOOKS: frBooks } = require('../detector');
const { BOOKS: enBooks } = require('../detector-en');
const { BOOK_CATALOG } = require('../book-catalog');

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

test('BOOK_CATALOG a exactement le même jeu de clés que BOOKS (detector.js)', () => {
  assert.deepStrictEqual(Object.keys(BOOK_CATALOG).sort(), Object.keys(frBooks).sort());
});

test('BOOK_CATALOG a exactement le même jeu de clés que BOOKS (detector-en.js)', () => {
  assert.deepStrictEqual(Object.keys(BOOK_CATALOG).sort(), Object.keys(enBooks).sort());
});

test('BOOK_CATALOG contient les 66 livres bibliques attendus', () => {
  assert.strictEqual(Object.keys(BOOK_CATALOG).length, 66);
});

test('chaque entrée BOOK_CATALOG[x].fr est identique (deep-equal) à BOOKS[x] de detector.js', () => {
  for (const key of Object.keys(frBooks)) {
    assert.deepStrictEqual(
      BOOK_CATALOG[key] && BOOK_CATALOG[key].fr,
      frBooks[key],
      `alias FR divergents pour '${key}'`
    );
  }
});

test('chaque entrée BOOK_CATALOG[x].en est identique (deep-equal) à BOOKS[x] de detector-en.js', () => {
  for (const key of Object.keys(enBooks)) {
    assert.deepStrictEqual(
      BOOK_CATALOG[key] && BOOK_CATALOG[key].en,
      enBooks[key],
      `alias EN divergents pour '${key}'`
    );
  }
});

test("chaque clé est bien le slug français canonique (aucune clé anglaise ne s'est glissée)", () => {
  // Repère les régressions les plus probables d'une future édition manuelle :
  // une clé anglaise ('john') introduite par erreur à la place du slug FR
  // canonique ('jean') casserait tout lookup existant (HELLOAO_BOOK_CODES,
  // reading-mode.js, refKey de server.js) sans qu'aucune erreur ne le signale.
  assert.ok(BOOK_CATALOG.jean, "la clé canonique 'jean' doit exister");
  assert.ok(!BOOK_CATALOG.john, "la clé anglaise 'john' ne doit jamais exister comme clé");
  assert.ok(BOOK_CATALOG.apocalypse, "la clé canonique 'apocalypse' doit exister");
  assert.ok(
    !BOOK_CATALOG.revelation,
    "la clé anglaise 'revelation' ne doit jamais exister comme clé"
  );
});

console.log(`\n=== Résultat test-book-catalog : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) process.exit(1);
