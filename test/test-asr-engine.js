/**
 * test-asr-engine.js — Tests pour asr-engine.js (interface ASR unifiée)
 */
'use strict';
const assert = require('assert');

console.log('=== Test ASR Engine (interface unifiée) ===\n');

async function run() {
  console.log('[TEST] Test 1: resolveProvider() retombe sur \'auto\' si ASR_PROVIDER absent/invalide...');
  delete process.env.ASR_PROVIDER;
  delete require.cache[require.resolve('../asr-engine')];
  let asrEngine = require('../asr-engine');
  assert.strictEqual(asrEngine.resolveProvider(), 'auto');
  process.env.ASR_PROVIDER = 'n-importe-quoi';
  assert.strictEqual(asrEngine.resolveProvider(), 'auto', 'une valeur invalide doit retomber sur auto');
  console.log('[TEST] ✓ Repli auto correct\n');

  console.log('[TEST] Test 2: resolveProvider() respecte une valeur valide...');
  for (const p of ['groq', 'deepgram', 'qwen-local', 'auto']) {
    process.env.ASR_PROVIDER = p;
    assert.strictEqual(asrEngine.resolveProvider(), p);
  }
  delete process.env.ASR_PROVIDER;
  console.log('[TEST] ✓ Toutes les valeurs valides respectées\n');

  console.log('[TEST] Test 3: getStatus() reflète GROQ_API_KEY/DEEPGRAM_API_KEY réellement présents...');
  const savedGroq = process.env.GROQ_API_KEY;
  const savedDg = process.env.DEEPGRAM_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  let status = asrEngine.getStatus();
  assert.strictEqual(status.providers.groq.available, false);
  assert.strictEqual(status.providers.deepgram.available, false);
  process.env.GROQ_API_KEY = 'gsk_test';
  process.env.DEEPGRAM_API_KEY = 'dg_test';
  status = asrEngine.getStatus();
  assert.strictEqual(status.providers.groq.available, true);
  assert.strictEqual(status.providers.deepgram.available, true);
  if (savedGroq) process.env.GROQ_API_KEY = savedGroq;
  else delete process.env.GROQ_API_KEY;
  if (savedDg) process.env.DEEPGRAM_API_KEY = savedDg;
  else delete process.env.DEEPGRAM_API_KEY;
  console.log('[TEST] ✓ Statut cohérent avec les clés présentes\n');

  console.log('[TEST] Test 4: getStatus() marque qwen-local comme indisponible, avec une raison explicite...');
  status = asrEngine.getStatus();
  assert.strictEqual(status.providers['qwen-local'].available, false);
  assert(
    typeof status.providers['qwen-local'].reason === 'string' &&
      status.providers['qwen-local'].reason.length > 20,
    'la raison doit être explicite, pas un message générique'
  );
  console.log('[TEST] ✓ qwen-local correctement documenté comme réservé\n');

  console.log('[TEST] Test 5: transcribeSegment() avec ASR_PROVIDER=qwen-local rejette avec une erreur claire...');
  process.env.ASR_PROVIDER = 'qwen-local';
  await assert.rejects(
    () => asrEngine.transcribeSegment('/tmp/fake.wav'),
    /qwen-local/,
    "l'erreur doit mentionner qwen-local, pas une erreur générique"
  );
  delete process.env.ASR_PROVIDER;
  console.log('[TEST] ✓ Rejet explicite pour qwen-local\n');

  console.log('[TEST] Test 6: transcribeSegment() avec ASR_PROVIDER=deepgram mais sans clé rejette clairement...');
  delete process.env.DEEPGRAM_API_KEY;
  process.env.ASR_PROVIDER = 'deepgram';
  await assert.rejects(
    () => asrEngine.transcribeSegment('/tmp/fake.wav'),
    /DEEPGRAM_API_KEY/
  );
  delete process.env.ASR_PROVIDER;
  console.log('[TEST] ✓ Rejet explicite sans clé Deepgram\n');

  console.log('\n=== Tous les tests asr-engine sont passés ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
