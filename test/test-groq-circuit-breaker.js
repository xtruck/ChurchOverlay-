'use strict';
/**
 * Test unitaire — groq-wrapper.js, circuit breaker Groq (§6b.1).
 *
 * Ne re-teste PAS ce que test-groq-health-tracking.js couvre déjà (compteur
 * consecutiveFailures, remise à zéro sur succès) — seulement le
 * COMPORTEMENT NOUVEAU : Groq sauté après CIRCUIT_FAILURE_THRESHOLD (5)
 * échecs consécutifs tant que Deepgram est configuré, jamais sauté sinon,
 * `circuitOpen` correctement reflété dans getGroqHealthState().
 *
 * Date.now() mocké pour avancer le "temps" sans attendre le vrai cooldown
 * (30s) en conditions réelles.
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
process.env.DEEPGRAM_API_KEY = 'fake-deepgram-key-for-test';

let groqCallCount = 0;
let deepgramCallCount = 0;
let groqShouldFail = true;
const originalFetch = global.fetch;
global.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.includes('groq.com')) {
    groqCallCount++;
    if (groqShouldFail) {
      return {
        ok: false,
        status: 500,
        text: async () => '{"error":{"message":"Internal error"}}',
      };
    }
    return { ok: true, json: async () => ({ text: 'ok groq', segments: [] }) };
  }
  deepgramCallCount++;
  return {
    ok: true,
    json: async () => ({
      results: { channels: [{ alternatives: [{ transcript: 'ok deepgram', confidence: 0.9 }] }] },
    }),
  };
};

const groq = require('../groq-wrapper');

const tmpFile = path.join(os.tmpdir(), `test-groq-circuit-${Date.now()}.wav`);
fs.writeFileSync(tmpFile, Buffer.from([0x52, 0x49, 0x46, 0x46]));

const originalDateNow = Date.now;
let fakeNow = originalDateNow();
Date.now = () => fakeNow;

(async () => {
  const initial = groq.getGroqHealthState();
  assert(initial.circuitOpen === false, 'circuit fermé initialement');
  assert(initial.circuitOpenedAt === null, 'circuitOpenedAt null initialement');

  // 4 échecs consécutifs : sous le seuil (5) — Groq doit être tenté à
  // chaque fois, jamais sauté, exactement comme avant ce chantier (voir
  // test-groq-health-tracking.js, qui exerce précisément 3 échecs + 1
  // succès sans jamais s'attendre à ce que Groq soit sauté).
  for (let i = 0; i < 4; i++) {
    await groq.transcribeWithFallback(tmpFile);
  }
  assert(groqCallCount === 4, `Groq tenté 4/4 fois sous le seuil (obtenu: ${groqCallCount})`);
  assert(groq.getGroqHealthState().circuitOpen === false, 'circuit toujours fermé à 4 échecs');

  // 5e échec : atteint le seuil, ouvre le circuit.
  await groq.transcribeWithFallback(tmpFile);
  assert(
    groqCallCount === 5,
    `Groq tenté au 5e appel (seuil atteint pile à ce moment, obtenu: ${groqCallCount})`
  );
  const afterThreshold = groq.getGroqHealthState();
  assert(afterThreshold.circuitOpen === true, 'circuit ouvert après 5 échecs consécutifs');
  assert(afterThreshold.consecutiveFailures === 5, 'compteur à 5');

  // 6e appel : circuit ouvert, Deepgram configuré -> Groq doit être SAUTÉ
  // entièrement (pas de nouvel appel réseau vers groq.com).
  const skipped = await groq.transcribeWithFallback(tmpFile);
  assert(
    groqCallCount === 5,
    `Groq PAS retenté pendant le cooldown (toujours 5, obtenu: ${groqCallCount})`
  );
  assert(skipped.source === 'deepgram', 'repli Deepgram direct pendant le circuit ouvert');
  assert(deepgramCallCount > 0, 'Deepgram bien appelé pendant le circuit ouvert');

  // Le compteur ne doit PAS continuer à grimper pendant que Groq est sauté
  // (rien de nouveau à compter tant qu'aucun appel réel n'est tenté).
  assert(
    groq.getGroqHealthState().consecutiveFailures === 5,
    "compteur inchangé (5) pendant le circuit ouvert, pas d'incrément fantôme"
  );

  // Avance le temps jusqu'après le cooldown (30s) : le prochain appel doit
  // retenter Groq (semi-ouvert). On simule ici un Groq redevenu fonctionnel.
  fakeNow += 31000;
  groqShouldFail = false;
  const recovered = await groq.transcribeWithFallback(tmpFile);
  assert(groqCallCount === 6, `Groq retenté après le cooldown (obtenu: ${groqCallCount})`);
  assert(
    recovered.source === 'groq',
    'Groq redevenu fonctionnel reprend la main après le cooldown'
  );
  const afterRecovery = groq.getGroqHealthState();
  assert(afterRecovery.circuitOpen === false, 'circuit refermé après succès post-cooldown');
  assert(afterRecovery.consecutiveFailures === 0, 'compteur remis à 0 après succès post-cooldown');

  // Sans Deepgram configuré, le circuit ne doit JAMAIS sauter Groq — c'est
  // la seule chance de transcrire, même faible, mieux vaut retenter que
  // garantir un échec.
  delete process.env.DEEPGRAM_API_KEY;
  groqShouldFail = true;
  groqCallCount = 0;
  for (let i = 0; i < 6; i++) {
    try {
      await groq.transcribeWithFallback(tmpFile);
    } catch (_e) {
      // attendu : ni Groq ni Deepgram (non configuré) ne peuvent réussir ici
    }
  }
  assert(
    groqCallCount === 6,
    `sans Deepgram configuré, Groq est retenté à chaque appel même après 5+ échecs (obtenu: ${groqCallCount})`
  );
  process.env.DEEPGRAM_API_KEY = 'fake-deepgram-key-for-test';

  console.log('\n=== Tous les tests groq-circuit-breaker sont passés ===');
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
