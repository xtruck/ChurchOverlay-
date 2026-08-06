'use strict';
/**
 * Test unitaire pour deepgram-wrapper.js — vérifie que la requête envoyée
 * à l'API Deepgram batch (/v1/listen avec un fichier complet) ne contient
 * jamais `endpointing`, un paramètre réservé à l'API streaming temps réel.
 *
 * RÉGRESSION COUVERTE (audit) : `endpointing=300` était envoyé sur chaque
 * appel, ce qui fait échouer TOUTE requête Deepgram avec une erreur 400
 * ("Endpointing not supported for batch requests") — confirmé en usage
 * réel. Comme Deepgram est censé être le filet de sécurité si Groq est
 * lent/échoue (voir groq-wrapper.transcribeWithFallback), ce bug
 * supprimait ce filet en pratique : silencieusement, sur chaque segment.
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

process.env.DEEPGRAM_API_KEY = 'fake-key-for-test';

let capturedUrl = null;
const originalFetch = global.fetch;
global.fetch = async (url) => {
  capturedUrl = String(url);
  return {
    ok: true,
    json: async () => ({
      results: { channels: [{ alternatives: [{ transcript: 'ok', confidence: 1 }] }] },
    }),
  };
};

const deepgram = require('../deepgram-wrapper');

const tmpFile = path.join(os.tmpdir(), `test-deepgram-${Date.now()}.wav`);
fs.writeFileSync(tmpFile, Buffer.from([0x52, 0x49, 0x46, 0x46])); // contenu factice, jamais lu par le fetch mocké

(async () => {
  await deepgram.transcribeFile(tmpFile);

  assert(!!capturedUrl, "l'URL Deepgram a bien été capturée");
  assert(
    !capturedUrl.includes('endpointing'),
    "l'URL Deepgram NE contient PAS `endpointing` (paramètre streaming, invalide en batch)"
  );
  assert(
    capturedUrl.includes('model=nova-2'),
    "l'URL Deepgram contient toujours le modèle attendu"
  );
  assert(
    capturedUrl.includes('smart_format=true'),
    "l'URL Deepgram contient toujours les autres paramètres batch valides"
  );

  fs.unlinkSync(tmpFile);
  global.fetch = originalFetch;
  console.log('\n=== Tous les tests deepgram-wrapper sont passés ===');
})().catch((err) => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
