/**
 * ============================================================================
 *  test-bible-lookup-multilang.js — Tests pour getVerseMultilang (bible-lookup-with-api.js)
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 13 — vérification, aucun changement de
 *  code) : getVerseMultilang() existait déjà et gère correctement le mode
 *  bilingue (voir son code, non modifié par ce lot) — mais AUCUN test
 *  existant ne verrouillait sa forme réelle. Les seules occurrences trouvées
 *  dans test/ étaient des MOCKS de cette fonction (pour des tests
 *  d'intégration server.js), jamais un test de la vraie implémentation.
 *
 *  Ce test comble ce trou : verrouille que le mode 'both' peuple TOUJOURS
 *  text_fr ET text_en (jamais seulement 'text', conformément à l'exigence du
 *  cahier des charges bilingue), que les modes mono-langue laissent l'autre
 *  champ à `null` (pas absent, pas chaîne vide), et que la référence
 *  bilingue combine bien les deux labels quand ils diffèrent.
 *
 *  Réseau MOQUÉ (global.fetch) — comme test-deepgram-wrapper.js et
 *  test-groq-fallback-race.js, aucun appel réseau réel dans ce test.
 * ============================================================================
 */
'use strict';

const assert = require('assert');

function helloaoChapterResponse(verseNumber, text) {
  return {
    ok: true,
    json: async () => ({
      chapter: {
        content: [{ type: 'verse', number: verseNumber, content: [text] }],
      },
    }),
  };
}

const originalFetch = global.fetch;
global.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.includes('fra_lsg')) {
    return helloaoChapterResponse(16, 'Car Dieu a tant aimé le monde (FR mock)');
  }
  if (urlStr.includes('eng_kjv')) {
    return helloaoChapterResponse(16, 'For God so loved the world (EN mock)');
  }
  throw new Error(`URL inattendue dans le mock fetch: ${urlStr}`);
};

const bibleLookup = require('../bible-lookup-with-api');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   ${err.message}`);
    failed++;
  }
}

const JEAN_3_16 = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 };

(async () => {
  await test("langMode='both' peuple TOUJOURS text_fr ET text_en (jamais seulement 'text')", async () => {
    const result = await bibleLookup.getVerseMultilang(JEAN_3_16, 'both');
    assert.ok(result.text_fr, 'text_fr doit être renseigné en mode both');
    assert.ok(result.text_en, 'text_en doit être renseigné en mode both');
    assert.strictEqual(result.text_fr, 'Car Dieu a tant aimé le monde (FR mock)');
    assert.strictEqual(result.text_en, 'For God so loved the world (EN mock)');
    assert.strictEqual(result.langMode, 'both');
    // 'text' (langue primaire) doit rester peuplé pour les appelants qui ne
    // lisent pas encore text_fr/text_en (rétrocompatibilité).
    assert.ok(result.text, "le champ 'text' (langue primaire) doit rester peuplé");
  });

  await test("langMode='both' combine les deux références quand elles diffèrent (FR · EN)", async () => {
    const result = await bibleLookup.getVerseMultilang(JEAN_3_16, 'both');
    assert.ok(result.reference.includes('·'), 'référence bilingue attendue (Jean · John)');
    assert.ok(result.reference.includes('Jean'));
    assert.ok(result.reference.includes('John'));
  });

  await test("langMode='fr' laisse text_en à null (pas absent, pas chaîne vide)", async () => {
    const result = await bibleLookup.getVerseMultilang(
      { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 },
      'fr'
    );
    assert.strictEqual(result.text_en, null);
    assert.ok(result.text_fr, 'text_fr doit être renseigné');
    assert.strictEqual(result.text_fr, result.text, "'text' doit refléter la langue demandée");
  });

  await test("langMode='en' laisse text_fr à null (pas absent, pas chaîne vide)", async () => {
    const result = await bibleLookup.getVerseMultilang(
      { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 },
      'en'
    );
    assert.strictEqual(result.text_fr, null);
    assert.ok(result.text_en, 'text_en doit être renseigné');
    assert.strictEqual(result.text_en, result.text, "'text' doit refléter la langue demandée");
  });

  global.fetch = originalFetch;
  console.log(
    `\n=== Résultat test-bible-lookup-multilang : ${passed} passés, ${failed} échoués ===`
  );
  if (failed > 0) process.exit(1);
})().catch((err) => {
  global.fetch = originalFetch;
  console.error('Erreur fatale:', err);
  process.exit(1);
});
