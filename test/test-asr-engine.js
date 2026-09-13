/**
 * test-asr-engine.js — Tests pour asr-engine.js (interface ASR unifiée)
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sessionState = require('../session-state');

console.log('=== Test ASR Engine (interface unifiée) ===\n');

// AJOUT (support bilingue FR/EN, lot 4) : même mock fetch minimal que
// test-groq-fallback-race.js (hostname réellement résolu, pas un test de
// sous-chaîne — voir son commentaire CodeQL) — dupliqué ici volontairement
// plutôt qu'importé, les fichiers de test ne s'importent pas entre eux
// dans ce projet.
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
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

async function run() {
  console.log(
    "[TEST] Test 1: resolveProvider() retombe sur 'auto' si ASR_PROVIDER absent/invalide..."
  );
  delete process.env.ASR_PROVIDER;
  delete require.cache[require.resolve('../asr-engine')];
  let asrEngine = require('../asr-engine');
  assert.strictEqual(asrEngine.resolveProvider(), 'auto');
  process.env.ASR_PROVIDER = 'n-importe-quoi';
  assert.strictEqual(
    asrEngine.resolveProvider(),
    'auto',
    'une valeur invalide doit retomber sur auto'
  );
  console.log('[TEST] ✓ Repli auto correct\n');

  console.log('[TEST] Test 2: resolveProvider() respecte une valeur valide...');
  for (const p of ['groq', 'deepgram', 'qwen-local', 'auto']) {
    process.env.ASR_PROVIDER = p;
    assert.strictEqual(asrEngine.resolveProvider(), p);
  }
  delete process.env.ASR_PROVIDER;
  console.log('[TEST] ✓ Toutes les valeurs valides respectées\n');

  console.log(
    '[TEST] Test 3: getStatus() reflète GROQ_API_KEY/DEEPGRAM_API_KEY réellement présents...'
  );
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

  console.log(
    '[TEST] Test 4: getStatus() marque qwen-local comme indisponible, avec une raison explicite...'
  );
  status = asrEngine.getStatus();
  assert.strictEqual(status.providers['qwen-local'].available, false);
  assert(
    typeof status.providers['qwen-local'].reason === 'string' &&
      status.providers['qwen-local'].reason.length > 20,
    'la raison doit être explicite, pas un message générique'
  );
  console.log('[TEST] ✓ qwen-local correctement documenté comme réservé\n');

  console.log(
    '[TEST] Test 5: transcribeSegment() avec ASR_PROVIDER=qwen-local rejette avec une erreur claire...'
  );
  process.env.ASR_PROVIDER = 'qwen-local';
  await assert.rejects(
    () => asrEngine.transcribeSegment('/tmp/fake.wav'),
    /qwen-local/,
    "l'erreur doit mentionner qwen-local, pas une erreur générique"
  );
  delete process.env.ASR_PROVIDER;
  console.log('[TEST] ✓ Rejet explicite pour qwen-local\n');

  console.log(
    '[TEST] Test 6: transcribeSegment() avec ASR_PROVIDER=deepgram mais sans clé rejette clairement...'
  );
  delete process.env.DEEPGRAM_API_KEY;
  process.env.ASR_PROVIDER = 'deepgram';
  await assert.rejects(() => asrEngine.transcribeSegment('/tmp/fake.wav'), /DEEPGRAM_API_KEY/);
  delete process.env.ASR_PROVIDER;
  console.log('[TEST] ✓ Rejet explicite sans clé Deepgram\n');

  console.log(
    '[TEST] Test 7: transcribeSegment() transmet sessionState.getTranscriptionLanguage() à Groq...'
  );
  {
    const tmpFile = path.join(os.tmpdir(), 'test-asr-engine-lang.wav');
    fs.writeFileSync(tmpFile, Buffer.from('RIFF....WAVEfmt '));
    process.env.ASR_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'gsk_test';
    delete require.cache[require.resolve('../asr-engine')];
    asrEngine = require('../asr-engine');

    let capturedFormData = null;
    sessionState.setTranscriptionLanguage('en');
    await withMockedFetch(
      async (url, options) => {
        if (hostMatches(url, 'groq.com')) {
          capturedFormData = options && options.body;
          return { ok: true, json: async () => ({ text: 'John 3 16' }) };
        }
        throw new Error('fetch inattendu: ' + url);
      },
      () => asrEngine.transcribeSegment(tmpFile)
    );
    assert.strictEqual(
      capturedFormData.get('language'),
      'en',
      'la langue de session (transcriptionLanguage) doit primer et être transmise à Groq'
    );
    sessionState.setTranscriptionLanguage(null);
    fs.unlinkSync(tmpFile);
  }
  console.log('[TEST] ✓ Langue de session transmise correctement\n');

  console.log(
    '[TEST] Test 8: sans langue de session, TRANSCRIPTION_LANGUAGE (.env) reste le repli...'
  );
  {
    const tmpFile = path.join(os.tmpdir(), 'test-asr-engine-lang2.wav');
    fs.writeFileSync(tmpFile, Buffer.from('RIFF....WAVEfmt '));
    process.env.TRANSCRIPTION_LANGUAGE = 'fr';

    let capturedFormData = null;
    sessionState.setTranscriptionLanguage(null); // pas de préférence de session
    await withMockedFetch(
      async (url, options) => {
        if (hostMatches(url, 'groq.com')) {
          capturedFormData = options && options.body;
          return { ok: true, json: async () => ({ text: 'Jean 3 16' }) };
        }
        throw new Error('fetch inattendu: ' + url);
      },
      () => asrEngine.transcribeSegment(tmpFile)
    );
    assert.strictEqual(
      capturedFormData.get('language'),
      'fr',
      "sans préférence de session, TRANSCRIPTION_LANGUAGE (.env) doit toujours s'appliquer — comportement historique préservé"
    );
    delete process.env.TRANSCRIPTION_LANGUAGE;
    delete process.env.ASR_PROVIDER;
    delete process.env.GROQ_API_KEY;
    fs.unlinkSync(tmpFile);
  }
  console.log('[TEST] ✓ Repli sur TRANSCRIPTION_LANGUAGE préservé\n');

  // ==========================================================================
  // AJOUT (chantier transcription — cross-check parallèle de basse confiance) :
  // transcribeSegment() doit relancer Deepgram SUR LE MÊME SEGMENT quand
  // Groq répond avec une confiance sous le seuil (0.8 par défaut, voir
  // config/features.json#audio.crossCheckConfidenceThreshold), puis arbitrer
  // avec scoreCanonicalMatch() — jamais sur un timeout/échec (déjà couvert
  // par groq-wrapper.js#transcribeWithFallback et ses propres tests).
  // ==========================================================================
  console.log('\n--- Cross-check parallèle de basse confiance (Groq -> Deepgram) ---');

  /**
   * Construit une réponse Groq verbose_json dont confidence = exp(avgLogprob)
   * — même formule que computeGroqSpeechInfo() dans groq-wrapper.js.
   * @param {string} text
   * @param {number} confidence - dans (0, 1]
   */
  function groqResponse(text, confidence) {
    return {
      ok: true,
      json: async () => ({
        text,
        segments: [{ start: 0, end: 1, avg_logprob: Math.log(confidence), no_speech_prob: 0.05 }],
      }),
    };
  }
  function deepgramResponse(text, confidence) {
    return {
      ok: true,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: text, confidence }] }] },
      }),
    };
  }
  function makeTmpWav(name) {
    const p = path.join(os.tmpdir(), name);
    fs.writeFileSync(p, Buffer.from('RIFF....WAVEfmt '));
    return p;
  }

  console.log(
    '[TEST] Test 9: confiance Groq basse + Deepgram meilleure correspondance canonique -> Deepgram retenu...'
  );
  {
    process.env.ASR_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'gsk_test';
    process.env.DEEPGRAM_API_KEY = 'dg_test';
    delete require.cache[require.resolve('../asr-engine')];
    asrEngine = require('../asr-engine');
    const tmpFile = makeTmpWav('test-asr-engine-crosscheck-1.wav');

    let deepgramCalled = false;
    const result = await withMockedFetch(
      async (url) => {
        if (hostMatches(url, 'groq.com')) {
          // Confiance basse (0.5 < 0.8) ET aucun terme canonique reconnaissable.
          return groqResponse('un message tres interessant ce matin', 0.5);
        }
        if (hostMatches(url, 'deepgram.com')) {
          deepgramCalled = true;
          // Meilleure correspondance canonique (jesus, jerusalem) ET confiance plus haute.
          return deepgramResponse('jesus etait a jerusalem', 0.9);
        }
        throw new Error('fetch inattendu: ' + url);
      },
      () => asrEngine.transcribeSegment(tmpFile)
    );

    assert.strictEqual(
      deepgramCalled,
      true,
      'Deepgram doit avoir été consulté (cross-check déclenché)'
    );
    assert.strictEqual(
      result.engine,
      'deepgram',
      'Deepgram doit être retenu (meilleure correspondance canonique)'
    );
    assert.strictEqual(result.text, 'jesus etait a jerusalem');
    assert.strictEqual(result.crossChecked, true);
    fs.unlinkSync(tmpFile);
  }
  console.log('[TEST] ✓ Deepgram retenu par le cross-check\n');

  console.log(
    '[TEST] Test 10: confiance Groq basse mais MEILLEURE correspondance canonique que Deepgram -> Groq conservé...'
  );
  {
    delete require.cache[require.resolve('../asr-engine')];
    asrEngine = require('../asr-engine');
    const tmpFile = makeTmpWav('test-asr-engine-crosscheck-2.wav');

    const result = await withMockedFetch(
      async (url) => {
        if (hostMatches(url, 'groq.com')) {
          // Confiance basse mais texte déjà biblique (jesus, jerusalem).
          return groqResponse('jesus etait a jerusalem', 0.5);
        }
        if (hostMatches(url, 'deepgram.com')) {
          // Confiance plus haute mais AUCUNE correspondance canonique.
          return deepgramResponse('un message tres interessant ce matin', 0.9);
        }
        throw new Error('fetch inattendu: ' + url);
      },
      () => asrEngine.transcribeSegment(tmpFile)
    );

    assert.strictEqual(
      result.engine,
      'groq',
      'Groq doit être conservé (meilleure correspondance canonique malgré une confiance acoustique plus basse)'
    );
    assert.strictEqual(result.text, 'jesus etait a jerusalem');
    assert.strictEqual(result.crossChecked, true);
    fs.unlinkSync(tmpFile);
  }
  console.log(
    '[TEST] ✓ Groq conservé malgré une confiance Deepgram plus haute (score canonique décisif)\n'
  );

  console.log(
    '[TEST] Test 11: confiance Groq HAUTE -> aucun cross-check déclenché (Deepgram jamais consulté)...'
  );
  {
    delete require.cache[require.resolve('../asr-engine')];
    asrEngine = require('../asr-engine');
    const tmpFile = makeTmpWav('test-asr-engine-crosscheck-3.wav');

    const result = await withMockedFetch(
      async (url) => {
        if (hostMatches(url, 'groq.com')) {
          return groqResponse('un message tres interessant ce matin', 0.95);
        }
        throw new Error('fetch inattendu (Deepgram ne doit pas être consulté): ' + url);
      },
      () => asrEngine.transcribeSegment(tmpFile)
    );

    assert.strictEqual(result.engine, 'groq');
    assert.strictEqual(
      result.crossChecked,
      undefined,
      'pas de cross-check déclenché : le champ ne doit même pas apparaître'
    );
    fs.unlinkSync(tmpFile);
  }
  console.log('[TEST] ✓ Confiance haute : Deepgram jamais consulté\n');

  console.log(
    '[TEST] Test 12: confiance Groq basse mais DEEPGRAM NON CONFIGURÉ -> résultat Groq conservé tel quel...'
  );
  {
    delete process.env.DEEPGRAM_API_KEY;
    delete require.cache[require.resolve('../asr-engine')];
    delete require.cache[require.resolve('../deepgram-wrapper')];
    asrEngine = require('../asr-engine');
    const tmpFile = makeTmpWav('test-asr-engine-crosscheck-4.wav');

    const result = await withMockedFetch(
      async (url) => {
        if (hostMatches(url, 'groq.com')) {
          return groqResponse('un message tres interessant ce matin', 0.5);
        }
        throw new Error(
          'fetch inattendu (Deepgram non configuré, ne doit jamais être appelé): ' + url
        );
      },
      () => asrEngine.transcribeSegment(tmpFile)
    );

    assert.strictEqual(result.engine, 'groq');
    assert.strictEqual(result.text, 'un message tres interessant ce matin');
    fs.unlinkSync(tmpFile);
    process.env.DEEPGRAM_API_KEY = 'dg_test';
  }
  console.log(
    '[TEST] ✓ Sans Deepgram configuré, le résultat Groq basse confiance reste utilisable\n'
  );

  console.log(
    '[TEST] Test 13: getCrossCheckConfidenceThreshold() respecte config/features.json...'
  );
  {
    assert.strictEqual(
      asrEngine.getCrossCheckConfidenceThreshold(),
      0.8,
      'valeur par défaut du dépôt (config/features.json#audio.crossCheckConfidenceThreshold)'
    );
  }
  console.log('[TEST] ✓ Seuil de cross-check conforme à la configuration\n');

  delete process.env.ASR_PROVIDER;
  delete process.env.GROQ_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;

  console.log('\n=== Tous les tests asr-engine sont passés ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
