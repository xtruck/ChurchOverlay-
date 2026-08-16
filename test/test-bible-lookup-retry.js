/**
 * ============================================================================
 *  test-bible-lookup-retry.js — Tests du mécanisme de nouvelles tentatives
 *  (Chantier 2 — retries) de fetchJson dans bible-lookup-with-api.js.
 * ----------------------------------------------------------------------------
 *  Un hoquet réseau transitoire (TypeError fetch, timeout, 5xx) ne doit plus
 *  faire échouer un verset du premier coup : fetchJson retente jusqu'à 2 fois
 *  avec backoff, mais JAMAIS sur une 4xx (erreur définitive de notre requête).
 *
 *  Réseau MOQUÉ (global.fetch) — aucun appel réseau réel, comme
 *  test-bible-lookup-multilang.js. Les délais de backoff réels (600/1600ms)
 *  ralentiraient le test ; on les vérifie donc via le COMPTAGE des appels et
 *  on réduit la fenêtre d'attente en ne testant que les cas de figure
 *  structurels (type d'erreur -> retenté ou pas).
 * ============================================================================
 */
'use strict';

const assert = require('assert');

function helloaoChapterResponse(verseNumber, text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      chapter: {
        content: [{ type: 'verse', number: verseNumber, content: [text] }],
      },
    }),
  };
}

function jsonResponse(status) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
}

const bibleLookup = require('../bible-lookup-with-api');

const JEAN_3_16 = { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 };

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

(async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  await test('une panne réseau (TypeError) transitoire est retentée et finit par réussir', async () => {
    fetchCalls = 0;
    global.fetch = async (url) => {
      fetchCalls++;
      // Panne réseau les 2 premières fois, puis réussite (3e tentative).
      if (fetchCalls <= 2) throw new TypeError('fetch failed (réseau coupé)');
      return helloaoChapterResponse(16, 'Car Dieu a tant aimé le monde (retry OK)');
    };
    const result = await bibleLookup.getVerse(JEAN_3_16, 'fr');
    assert.ok(result, 'getVerse doit réussir après retry');
    assert.ok(result.text.includes('retry OK'), 'le texte doit venir de la tentative réussie');
    assert.ok(
      fetchCalls >= 3,
      `fetch doit avoir été appelé ≥3 fois (transitoire), reçu ${fetchCalls}`
    );
  });

  await test("une 4xx (404) n'est PAS retentée — échec direct", async () => {
    bibleLookup.clearCache();
    fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return jsonResponse(404);
    };
    await assert.rejects(
      () => bibleLookup.getVerse(JEAN_3_16, 'fr'),
      /any provider/i,
      'tous les fournisseurs doivent échouer (404 définitif)'
    );
    // Chaque fournisseur n'est appelé qu'UNE fois : pas de retry sur 4xx.
    // getVerse essaie helloao puis getbible (FR) = 2 appels au total.
    assert.strictEqual(fetchCalls, 2, `404 ne doit pas être retenté — reçu ${fetchCalls} appels`);
  });

  await test('un 5xx transitoire est retenté (≥3 tentatives par fournisseur) avant échec final', async () => {
    bibleLookup.clearCache();
    fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return jsonResponse(500);
    };
    await assert.rejects(
      () => bibleLookup.getVerse(JEAN_3_16, 'fr'),
      /any provider/i,
      '5xx persistant doit finir en échec après épuisement des retries'
    );
    // 2 fournisseurs × 3 tentatives chacun (1 + 2 retries) = 6 appels.
    assert.strictEqual(
      fetchCalls,
      6,
      `5xx doit être retenté (6 appels attendus), reçu ${fetchCalls}`
    );
  });

  global.fetch = originalFetch;
  console.log(`\n=== Résultat test-bible-lookup-retry : ${passed} passés, ${failed} échoués ===`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  global.fetch = originalFetch;
  console.error('Erreur fatale:', err);
  process.exit(1);
});
