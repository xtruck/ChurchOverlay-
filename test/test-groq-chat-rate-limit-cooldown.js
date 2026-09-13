'use strict';
/**
 * Test unitaire — groq-wrapper.js#chatCompletion() / isChatRateLimited()
 *
 * RÉGRESSION COUVERTE (audit — usage réel en direct) : semantic-detector.js
 * et ai-enricher.js partagent la MÊME clé/quota Groq que la transcription
 * (via ce même chatCompletion(), "SEUL point de passage de tout appel LLM").
 * Observé en session live : un 429 Groq quasi permanent sur
 * /v1/chat/completions, réessayé à CHAQUE transcript (toutes les 2-3s),
 * sans jamais laisser respirer le quota réel du compte — leur propre
 * limiteur LOCAL (semantic-detector.js#MAX_CALLS_PER_MINUTE=24) ignorait
 * totalement ce que la transcription consommait déjà. Ce test vérifie que :
 *   1. un premier 429 arme un cooldown (isChatRateLimited() devient true) ;
 *   2. un appel PENDANT le cooldown échoue SANS toucher le réseau (fetch
 *      non rappelé) — le "debounce" demandé ;
 *   3. le cooldown expire après CHAT_RATE_LIMIT_COOLDOWN_MS et un appel
 *      redevient possible (retente réellement le réseau) ;
 *   4. ce cooldown ne bloque JAMAIS transcribeFile()/transcribeWithFallback()
 *      (endpoint/quota distinct) — "la transcription ASR reste toujours
 *      prioritaire" n'a pas besoin d'arbitrage explicite, elle est
 *      structurellement épargnée par ce garde-fou.
 *
 * Même approche que test-groq-circuit-breaker.js : Date.now() mocké pour
 * avancer le "temps" sans attendre le vrai cooldown (15s).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

process.env.GROQ_API_KEY = 'fake-groq-key-for-test';
delete process.env.GEMINI_API_KEY; // force la branche Groq de chatCompletion()
delete process.env.DEEPGRAM_API_KEY;

let chatCallCount = 0;
let transcribeCallCount = 0;
let chatShouldFail429 = true;

const originalFetch = global.fetch;
global.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.includes('/chat/completions')) {
    chatCallCount++;
    if (chatShouldFail429) {
      return {
        ok: false,
        status: 429,
        text: async () => '{"error":{"message":"Rate limit reached","type":"rate_limit_exceeded"}}',
      };
    }
    return {
      ok: true,
      json: async () => ({
        model: 'fake-model',
        choices: [{ message: { content: 'ok' } }],
        usage: {},
      }),
    };
  }
  if (urlStr.includes('/audio/transcriptions')) {
    transcribeCallCount++;
    return { ok: true, json: async () => ({ text: 'ok groq transcription', segments: [] }) };
  }
  // deepgram.com (non configuré ici, mais gardé inoffensif si jamais appelé)
  return {
    ok: true,
    json: async () => ({ results: { channels: [{ alternatives: [{ transcript: '' }] }] } }),
  };
};

const groq = require('../groq-wrapper');

const tmpFile = path.join(os.tmpdir(), `test-groq-chat-cooldown-${Date.now()}.wav`);
fs.writeFileSync(tmpFile, Buffer.from([0x52, 0x49, 0x46, 0x46]));

const originalDateNow = Date.now;
let fakeNow = originalDateNow();
Date.now = () => fakeNow;

(async () => {
  assert(groq.isChatRateLimited() === false, 'aucun cooldown avant le premier appel');

  // 1er appel : 429 réel, arme le cooldown.
  try {
    await groq.chatCompletion('Un prompt de test');
    assert(false, 'aurait dû lever une erreur (429)');
  } catch (e) {
    assert(
      /Rate limit Groq atteint/.test(e.message),
      `erreur de rate limit propagée (obtenu: ${e.message})`
    );
  }
  assert(chatCallCount === 1, `1 vrai appel réseau pour ce premier 429 (obtenu: ${chatCallCount})`);
  assert(groq.isChatRateLimited() === true, 'le cooldown est armé après ce premier 429');

  // 2e appel, immédiatement après : doit échouer SANS toucher le réseau.
  try {
    await groq.chatCompletion('Un second prompt, pendant le cooldown');
    assert(false, 'aurait dû lever une erreur (cooldown actif)');
  } catch (e) {
    assert(
      /Rate limit Groq atteint/.test(e.message),
      `échec immédiat pendant le cooldown (obtenu: ${e.message})`
    );
  }
  assert(
    chatCallCount === 1,
    `AUCUN nouvel appel réseau pendant le cooldown (toujours 1, obtenu: ${chatCallCount})`
  );

  // La transcription (endpoint/quota distinct) ne doit JAMAIS être affectée
  // par ce cooldown, même pendant qu'il est actif.
  const transcribed = await groq.transcribeFile(tmpFile);
  assert(
    transcribed.text === 'ok groq transcription',
    'transcribeFile() fonctionne normalement pendant le cooldown chat (endpoint distinct)'
  );
  assert(transcribeCallCount === 1, 'transcribeFile() a bien atteint le réseau (jamais bloqué)');

  // Avance le temps jusqu'après le cooldown (15s) : un appel doit à nouveau
  // atteindre le réseau — on simule ici un Groq redevenu disponible.
  fakeNow += 15001;
  chatShouldFail429 = false;
  assert(groq.isChatRateLimited() === false, 'le cooldown a expiré');
  const res = await groq.chatCompletion('Un prompt après expiration du cooldown');
  assert(res.text === 'ok', 'chatCompletion() réussit à nouveau après expiration du cooldown');
  assert(chatCallCount === 2, `2e vrai appel réseau après expiration (obtenu: ${chatCallCount})`);

  console.log('\n=== Tous les tests groq-chat-rate-limit-cooldown sont passés ===');
})()
  .catch((err) => {
    console.error('[TEST] ÉCHEC INATTENDU:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    Date.now = originalDateNow;
    global.fetch = originalFetch;
    fs.unlinkSync(tmpFile);
  });
