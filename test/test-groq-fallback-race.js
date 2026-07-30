/**
 * Test de la course à 2 niveaux (Groq -> Deepgram) dans groq-wrapper.js.
 * Simule les deux sources sans réseau ni matériel en mockant fetch.
 *
 * CHANGELOG v0.3.0 : le 3e niveau (Whisper local) a été retiré du projet
 * (plus gros consommateur CPU de l'app). Ce test ne couvre donc plus que
 * Groq -> Deepgram ; quand les deux échouent, transcribeWithFallback()
 * rejette désormais (plus de filet de secours hors-ligne).
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Fichier audio bidon nécessaire pour passer les vérifications fs.existsSync
const tmpFile = path.join(os.tmpdir(), 'test-groq-fallback-race.wav');
fs.writeFileSync(tmpFile, Buffer.from('RIFF....WAVEfmt '));

// Parsing d'URL structuré plutôt qu'un test de sous-chaîne (CodeQL alert #5 :
// "Incomplete URL substring sanitization" — url.includes('groq.com') matcherait
// aussi https://evil.com/groq.com). On compare le hostname réellement résolu.
function hostMatches(url, domain) {
  let hostname;
  try {
    hostname = new URL(String(url)).hostname;
  } catch {
    return false;
  }
  return hostname === domain || hostname.endsWith('.' + domain);
}

function withMockedFetch(responderFn, fn) {
  const originalFetch = global.fetch;
  global.fetch = responderFn;
  return fn().finally(() => { global.fetch = originalFetch; });
}

async function run() {
  console.log('[TEST] Test 1: Groq répond vite et sans erreur -> source groq...');
  process.env.GROQ_API_KEY = 'test-groq-key';
  delete process.env.DEEPGRAM_API_KEY;

  await withMockedFetch(async (url) => {
    if (hostMatches(url, 'groq.com')) {
      return {
        ok: true,
        json: async () => ({ text: 'Jean 3 16' }),
      };
    }
    throw new Error('fetch inattendu: ' + url);
  }, async () => {
    delete require.cache[require.resolve('../groq-wrapper')];
    delete require.cache[require.resolve('../deepgram-wrapper')];
    const groq = require('../groq-wrapper');
    const result = await groq.transcribeWithFallback(tmpFile, 500);
    assert.strictEqual(result.source, 'groq');
    assert.strictEqual(result.text, 'Jean 3 16');
  });
  console.log('[TEST] ✓ Groq prioritaire quand il répond à temps');

  console.log('[TEST] Test 2: Groq échoue, Deepgram configuré et répond -> source deepgram...');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.DEEPGRAM_API_KEY = 'test-deepgram-key';

  await withMockedFetch(async (url) => {
    if (hostMatches(url, 'groq.com')) {
      return { ok: false, status: 500, text: async () => 'erreur serveur' };
    }
    if (hostMatches(url, 'deepgram.com')) {
      return {
        ok: true,
        json: async () => ({
          results: { channels: [{ alternatives: [{ transcript: 'Psaume 23' }] }] },
        }),
      };
    }
    throw new Error('fetch inattendu: ' + url);
  }, async () => {
    delete require.cache[require.resolve('../groq-wrapper')];
    delete require.cache[require.resolve('../deepgram-wrapper')];
    const groq = require('../groq-wrapper');
    const result = await groq.transcribeWithFallback(tmpFile, 500);
    assert.strictEqual(result.source, 'deepgram');
    assert.strictEqual(result.text, 'Psaume 23');
  });
  console.log('[TEST] ✓ Bascule sur Deepgram quand Groq échoue');

  console.log('[TEST] Test 3: Groq et Deepgram échouent -> rejette (plus de filet local hors ligne)...');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.DEEPGRAM_API_KEY = 'test-deepgram-key';

  await withMockedFetch(async (url) => {
    throw new Error('Panne réseau simulée (hors ligne)');
  }, async () => {
    delete require.cache[require.resolve('../groq-wrapper')];
    delete require.cache[require.resolve('../deepgram-wrapper')];
    const groq = require('../groq-wrapper');
    let threw = false;
    try {
      await groq.transcribeWithFallback(tmpFile, 500);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
    }
    assert.strictEqual(threw, true, 'transcribeWithFallback aurait dû rejeter');
  });
  console.log('[TEST] ✓ Rejette proprement quand Groq et Deepgram sont tous deux indisponibles (offline)');

  console.log('[TEST] Test 4: Deepgram non configuré, Groq échoue -> rejette directement...');
  process.env.GROQ_API_KEY = 'test-groq-key';
  delete process.env.DEEPGRAM_API_KEY;

  await withMockedFetch(async (url) => {
    if (hostMatches(url, 'groq.com')) {
      return { ok: false, status: 429, text: async () => 'rate limited' };
    }
    throw new Error('fetch inattendu (Deepgram ne doit pas être appelé): ' + url);
  }, async () => {
    delete require.cache[require.resolve('../groq-wrapper')];
    delete require.cache[require.resolve('../deepgram-wrapper')];
    const groq = require('../groq-wrapper');
    let threw = false;
    try {
      await groq.transcribeWithFallback(tmpFile, 500);
    } catch (err) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'transcribeWithFallback aurait dû rejeter');
  });
  console.log('[TEST] ✓ Sans clé Deepgram, rejette directement si Groq échoue');

  console.log('[TEST] Test 5: deepgram-wrapper.isConfigured() reflète la variable d\'environnement...');
  delete require.cache[require.resolve('../deepgram-wrapper')];
  delete process.env.DEEPGRAM_API_KEY;
  let deepgram = require('../deepgram-wrapper');
  assert.strictEqual(deepgram.isConfigured(), false);
  process.env.DEEPGRAM_API_KEY = 'une-cle';
  assert.strictEqual(deepgram.isConfigured(), true);
  console.log('[TEST] ✓ isConfigured() correct dans les deux cas');

  fs.unlinkSync(tmpFile);
  delete process.env.GROQ_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;

  console.log('\n=== Tests terminés ===');
  console.log('[TEST] ✓ Tous les tests de la course Groq/Deepgram sont passés');
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
