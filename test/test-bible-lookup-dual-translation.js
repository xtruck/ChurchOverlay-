/**
 * ============================================================================
 *  test-bible-lookup-dual-translation.js — Tests pour getVerseDualTranslation/
 *  getVerseInTranslation (bible-lookup-with-api.js)
 * ----------------------------------------------------------------------------
 *  Chantier "Multi-Bible side-by-side" — déclenchement manuel uniquement
 *  (voir showVerse dans server.js), pas branché sur la détection automatique.
 *  Verrouille en particulier que deux traductions de LA MÊME langue (LSG +
 *  Darby, toutes deux françaises) peuvent être récupérées EN PARALLÈLE sans
 *  que l'une n'écrase la traduction "courante" de session de l'autre — le
 *  bug qu'une implémentation naïve (mutation temporaire de currentTranslation)
 *  aurait introduit sous concurrence.
 *
 *  Réseau MOQUÉ (global.fetch), même discipline que
 *  test-bible-lookup-multilang.js — aucun appel réseau réel.
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

function getbibleChapterResponse(verseNumber, text) {
  return {
    ok: true,
    json: async () => ({
      verses: [{ verse: verseNumber, text }],
    }),
  };
}

const originalFetch = global.fetch;
global.fetch = async (url) => {
  const urlStr = String(url);
  // LSG (français, servi par helloao : fra_lsg).
  if (urlStr.includes('fra_lsg')) {
    return helloaoChapterResponse(16, 'Car Dieu a tant aimé le monde (LSG mock)');
  }
  // Darby (français, servi UNIQUEMENT par getbible — helloaoId: null dans
  // AVAILABLE_TRANSLATIONS) : vérifie que la résolution par (lang, code)
  // choisit bien le bon fournisseur, pas juste la bonne langue.
  if (urlStr.includes('/darby/')) {
    return getbibleChapterResponse(16, 'Car Dieu a tant aimé le monde (Darby mock)');
  }
  if (urlStr.includes('eng_kjv')) {
    return helloaoChapterResponse(16, 'For God so loved the world (KJV mock)');
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
  await test('getVerseInTranslation() récupère LSG sans dépendre de currentTranslation', async () => {
    const result = await bibleLookup.getVerseInTranslation(JEAN_3_16, 'fr', 'lsg');
    assert.strictEqual(result.text, 'Car Dieu a tant aimé le monde (LSG mock)');
    assert.strictEqual(result.code, 'lsg');
    assert.strictEqual(result.label, 'Louis Segond 1910');
  });

  await test('getVerseInTranslation() récupère Darby (getbible uniquement)', async () => {
    const result = await bibleLookup.getVerseInTranslation(JEAN_3_16, 'fr', 'darby');
    assert.strictEqual(result.text, 'Car Dieu a tant aimé le monde (Darby mock)');
    assert.strictEqual(result.code, 'darby');
  });

  await test('getVerseInTranslation() sur un code inconnu lève une erreur claire', async () => {
    await assert.rejects(
      () => bibleLookup.getVerseInTranslation(JEAN_3_16, 'fr', 'nope'),
      /Traduction inconnue/
    );
  });

  await test('getVerseDualTranslation() : DEUX traductions de la MÊME langue en parallèle (LSG + Darby)', async () => {
    const result = await bibleLookup.getVerseDualTranslation(
      JEAN_3_16,
      { lang: 'fr', code: 'lsg' },
      { lang: 'fr', code: 'darby' }
    );
    assert.strictEqual(result.primary.text, 'Car Dieu a tant aimé le monde (LSG mock)');
    assert.strictEqual(result.secondary.text, 'Car Dieu a tant aimé le monde (Darby mock)');
    assert.strictEqual(result.primary.label, 'Louis Segond 1910');
    assert.strictEqual(result.secondary.label, 'Darby');
  });

  await test('getVerseDualTranslation() : la requête parallèle ne pollue PAS le cache/état de l’autre traduction', async () => {
    // Ré-interroge LSG seul APRÈS la requête double ci-dessus : doit
    // toujours renvoyer le texte LSG, jamais le texte Darby (préviendrait
    // une régression où une mutation globale temporaire aurait laissé
    // currentTranslation.fr sur 'darby' après le double-fetch).
    const result = await bibleLookup.getVerseInTranslation(JEAN_3_16, 'fr', 'lsg');
    assert.strictEqual(result.text, 'Car Dieu a tant aimé le monde (LSG mock)');
  });

  await test('getVerseDualTranslation() : combinaison FR + EN (langues différentes)', async () => {
    const result = await bibleLookup.getVerseDualTranslation(
      JEAN_3_16,
      { lang: 'fr', code: 'lsg' },
      { lang: 'en', code: 'kjv' }
    );
    assert.strictEqual(result.primary.text, 'Car Dieu a tant aimé le monde (LSG mock)');
    assert.strictEqual(result.secondary.text, 'For God so loved the world (KJV mock)');
    assert.ok(result.reference.includes('·'), 'référence combinée attendue (Jean · John)');
  });

  await test('getVerseDualTranslation() sur une traduction primaire inconnue lève une erreur', async () => {
    await assert.rejects(
      () =>
        bibleLookup.getVerseDualTranslation(
          JEAN_3_16,
          { lang: 'fr', code: 'nope' },
          { lang: 'en', code: 'kjv' }
        ),
      /Traduction inconnue/
    );
  });

  global.fetch = originalFetch;
  console.log(
    `\n=== Résultat test-bible-lookup-dual-translation : ${passed} passés, ${failed} échoués ===`
  );
  if (failed > 0) process.exit(1);
})().catch((err) => {
  global.fetch = originalFetch;
  console.error('Erreur fatale:', err);
  process.exit(1);
});
