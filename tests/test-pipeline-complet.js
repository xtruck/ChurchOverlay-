/**
 * ============================================================================
 *  test-pipeline-complet.js — Test du fallback Groq → Whisper local
 * ----------------------------------------------------------------------------
 *  Appelle directement groq.transcribeWithFallback (sans passer par le
 *  serveur WebSocket) pour vérifier que :
 *    - Groq répond normalement quand tout va bien (source: 'groq')
 *    - Le fallback local se déclenche en cas de timeout/échec réseau
 *      (source: 'local'), en moins de FALLBACK_TIMEOUT_MS + marge
 *    - Le texte n'est jamais vide dans les deux cas
 *
 *  USAGE:
 *    node tests/test-pipeline-complet.js
 * ============================================================================
 */

const path = require('path');
const groq = require('../groq-wrapper');

const FAKE_AUDIO = path.join(__dirname, 'fixtures', 'segment-test.wav');

// Simule whisper.transcribeFile : local "rapide" qui répond toujours
async function fakeLocalOK(audioFilePath) {
  return { text: 'Transcription locale simulée (Whisper).' };
}

// Simule un local qui échoue aussi (cas extrême)
async function fakeLocalFail(audioFilePath) {
  throw new Error('Whisper local indisponible (simulation)');
}

async function testGroqOK() {
  console.log('\n[TEST 1] Cas normal — Groq doit répondre (source: groq)');
  const start = Date.now();
  const result = await groq.transcribeWithFallback(FAKE_AUDIO, fakeLocalOK);
  const elapsed = Date.now() - start;
  console.log('[TEST 1] Résultat:', result, `(${elapsed}ms)`);
  console.log(result.source === 'groq' ? '[TEST 1] ✓ PASS' : '[TEST 1] ✗ FAIL (source attendue: groq)');
}

async function testNetworkCutFallback() {
  console.log('\n[TEST 2] Coupure réseau simulée — fallback local attendu sous 5s');
  console.log('[TEST 2] >>> Coupe le réseau maintenant (ou utilise une clé GROQ_API_KEY invalide/URL injoignable) <<<');

  const start = Date.now();
  const result = await groq.transcribeWithFallback(FAKE_AUDIO, fakeLocalOK, 5000);
  const elapsed = Date.now() - start;

  console.log('[TEST 2] Résultat:', result, `(${elapsed}ms)`);

  const withinBudget = elapsed <= 5500; // 5s timeout + marge
  const isLocal = result.source === 'local';
  const hasText = !!result.text;

  console.log(isLocal ? '[TEST 2] ✓ source = local' : '[TEST 2] ✗ FAIL: source =', result.source);
  console.log(withinBudget ? '[TEST 2] ✓ temps < 5.5s' : '[TEST 2] ✗ FAIL: trop long =', elapsed, 'ms');
  console.log(hasText ? '[TEST 2] ✓ overlay non vide' : '[TEST 2] ✗ FAIL: texte vide');
}

async function testBothFail() {
  console.log('\n[TEST 3] Cas extrême — Groq ET local échouent (doit rejeter proprement)');
  try {
    await groq.transcribeWithFallback(FAKE_AUDIO, fakeLocalFail, 1); // timeout quasi immédiat pour forcer le fallback
    console.log('[TEST 3] ✗ FAIL: aucune erreur levée alors que les deux sources échouent');
  } catch (error) {
    console.log('[TEST 3] ✓ PASS: erreur remontée proprement:', error.message);
  }
}

(async () => {
  console.log('=== Test Pipeline Complet (Groq + fallback local) ===');
  try {
    await testGroqOK();
    await testNetworkCutFallback();
    await testBothFail();
    console.log('\n=== Tests terminés ===');
  } catch (error) {
    console.error('\n[TEST] Erreur inattendue:', error.message);
    process.exit(1);
  }
})();
