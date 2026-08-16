'use strict';
/**
 * Test unitaire — groq-wrapper.js#getGroqHealthState()
 *
 * RÉGRESSION COUVERTE (trouvée en conditions réelles, Chantier 2/Chantier 1a) :
 * transcribeWithFallback() masque délibérément un Groq cassé tant que
 * Deepgram répond (course à 2 niveaux) — la transcription globale réussit,
 * `consecutiveTranscriptionFailures` (server.js) ne s'incrémente donc JAMAIS
 * pour un Groq en échec systématique. GROQ_API_KEY invalide en silence
 * (401 sur Groq, transcription entièrement portée par Deepgram) est resté
 * invisible jusqu'à un test manuel — ce compteur séparé, purement passif,
 * rend ce cas visible dans /api/health (voir buildHealthReport(), server.js).
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

let groqShouldFail = true;
const originalFetch = global.fetch;
global.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.includes('groq.com')) {
    if (groqShouldFail) {
      return {
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"Invalid API Key","type":"invalid_request_error"}}',
      };
    }
    return {
      ok: true,
      json: async () => ({ text: 'ok groq', segments: [] }),
    };
  }
  // deepgram.com — toujours OK, c'est le repli qui doit masquer Groq côté
  // résultat global (mais pas côté compteur dédié, voir ci-dessous).
  return {
    ok: true,
    json: async () => ({
      results: { channels: [{ alternatives: [{ transcript: 'ok deepgram', confidence: 0.9 }] }] },
    }),
  };
};

const groq = require('../groq-wrapper');

const tmpFile = path.join(os.tmpdir(), `test-groq-health-${Date.now()}.wav`);
fs.writeFileSync(tmpFile, Buffer.from([0x52, 0x49, 0x46, 0x46]));

(async () => {
  const initial = groq.getGroqHealthState();
  assert(initial.consecutiveFailures === 0, 'compteur initial à 0');
  assert(initial.lastError === null, 'aucune erreur initiale');

  // 3 segments réels d'un culte où Groq est cassé mais Deepgram sauve la
  // transcription globale — le compteur DÉDIÉ doit quand même progresser.
  for (let i = 0; i < 3; i++) {
    const result = await groq.transcribeWithFallback(tmpFile);
    assert(
      result.source === 'deepgram',
      `appel ${i + 1}/3 : repli Deepgram réussi malgré Groq cassé (masquage attendu du résultat global)`
    );
  }

  const afterFailures = groq.getGroqHealthState();
  assert(
    afterFailures.consecutiveFailures === 3,
    `compteur Groq dédié à 3 après 3 échecs Groq masqués par le repli (obtenu: ${afterFailures.consecutiveFailures})`
  );
  assert(
    afterFailures.lastError && afterFailures.lastError.includes('401'),
    `dernière erreur Groq capturée (obtenu: ${afterFailures.lastError})`
  );

  // Un Groq qui redevient valide doit remettre le compteur à zéro — pas de
  // faux "toujours dégradé" après une clé corrigée en cours de culte.
  groqShouldFail = false;
  const recovered = await groq.transcribeWithFallback(tmpFile);
  assert(recovered.source === 'groq', 'Groq redevenu fonctionnel reprend la main (source=groq)');
  const afterRecovery = groq.getGroqHealthState();
  assert(
    afterRecovery.consecutiveFailures === 0,
    `compteur remis à 0 après succès Groq (obtenu: ${afterRecovery.consecutiveFailures})`
  );
  assert(afterRecovery.lastError === null, 'lastError effacé après succès');

  global.fetch = originalFetch;
  fs.unlinkSync(tmpFile);

  console.log('\n=== Tous les tests groq-health-tracking sont passés ===');
  process.exit(0);
})().catch((err) => {
  console.error('[TEST] ÉCHEC INATTENDU:', err.message);
  console.error(err.stack);
  process.exit(1);
});
