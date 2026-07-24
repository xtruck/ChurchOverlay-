/**
 * Test de la course à 3 niveaux (Groq -> Deepgram -> local) dans
 * groq-wrapper.js. Simule les trois sources sans réseau ni matériel en
 * mockant fetch (Groq, Deepgram) et en injectant un localTranscribeFn.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Fichier audio bidon nécessaire pour passer les vérifications fs.existsSync
const tmpFile = path.join(os.tmpdir(), 'test-groq-fallback-race.wav');
fs.writeFileSync(tmpFile, Buffer.from('RIFF....WAVEfmt '));

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
    if (String(url).includes('groq.com')) {
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
    const result = await groq.transcribeWithFallback(
      tmpFile,
      async () => ({ text: 'texte local (ne doit pas être utilisé)' }),
      500
    );
    assert.strictEqual(result.source, 'groq');
    assert.strictEqual(result.text, 'Jean 3 16');
  });
  console.log('[TEST] ✓ Groq prioritaire quand il répond à temps');

  console.log('[TEST] Test 2: Groq échoue, Deepgram configuré et répond -> source deepgram...');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.DEEPGRAM_API_KEY = 'test-deepgram-key';

  await withMockedFetch(async (url) => {
    if (String(url).includes('groq.com')) {
      return { ok: false, status: 500, text: async () => 'erreur serveur' };
    }
    if (String(url).includes('deepgram.com')) {
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
    const result = await groq.transcribeWithFallback(
      tmpFile,
      async () => ({ text: 'texte local (ne doit pas être utilisé)' }),
      500
    );
    assert.strictEqual(result.source, 'deepgram');
    assert.strictEqual(result.text, 'Psaume 23');
  });
  console.log('[TEST] ✓ Bascule sur Deepgram quand Groq échoue');

  console.log('[TEST] Test 3: Groq et Deepgram échouent -> source local (filet de sécurité hors ligne)...');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.DEEPGRAM_API_KEY = 'test-deepgram-key';

  await withMockedFetch(async (url) => {
    throw new Error('Panne réseau simulée (hors ligne)');
  }, async () => {
    delete require.cache[require.resolve('../groq-wrapper')];
    delete require.cache[require.resolve('../deepgram-wrapper')];
    const groq = require('../groq-wrapper');
    const result = await groq.transcribeWithFallback(
      tmpFile,
      async () => ({ text: 'Apocalypse 21' }),
      500
    );
    assert.strictEqual(result.source, 'local');
    assert.strictEqual(result.text, 'Apocalypse 21');
  });
  console.log('[TEST] ✓ Bascule sur le local quand Groq et Deepgram sont tous deux indisponibles (offline)');

  console.log('[TEST] Test 4: Deepgram non configuré -> course à 2 niveaux (Groq -> local) inchangée...');
  process.env.GROQ_API_KEY = 'test-groq-key';
  delete process.env.DEEPGRAM_API_KEY;

  await withMockedFetch(async (url) => {
    if (String(url).includes('groq.com')) {
      return { ok: false, status: 429, text: async () => 'rate limited' };
    }
    throw new Error('fetch inattendu (Deepgram ne doit pas être appelé): ' + url);
  }, async () => {
    delete require.cache[require.resolve('../groq-wrapper')];
    delete require.cache[require.resolve('../deepgram-wrapper')];
    const groq = require('../groq-wrapper');
    const result = await groq.transcribeWithFallback(
      tmpFile,
      async () => ({ text: 'texte local' }),
      500
    );
    assert.strictEqual(result.source, 'local');
    assert.strictEqual(result.text, 'texte local');
  });
  console.log('[TEST] ✓ Sans clé Deepgram, comportement identique à avant (Groq -> local)');

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
  console.log('[TEST] ✓ Tous les tests de la course Groq/Deepgram/local sont passés');
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
