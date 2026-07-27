/**
 * ============================================================================
 *  integration-quote-match.js — Détection par citation (sans référence dite)
 * ----------------------------------------------------------------------------
 *  RÉGRESSION COUVERTE (audit round 5) : la branche "citation reconnue sans
 *  référence explicite" de server.js utilisait `lastQuoteMatch` sans jamais
 *  le déclarer. server.js tournant en mode strict, le premier verset
 *  reconnu par findByQuotedText() levait un ReferenceError attrapé plus haut
 *  ("Erreur lors de la transcription: lastQuoteMatch is not defined") :
 *  aucun verset n'était jamais diffusé par ce chemin, et l'overlay recevait
 *  un transcriptionError à la place. Les tests existants ne le voyaient pas,
 *  leur mock de findByQuotedText renvoyant toujours null.
 *
 *  Même approche que integration-reading-mode-live.js : server.js tourne
 *  réellement, seuls le réseau (API bibliques, Groq) et le micro sont mockés.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

const QUOTED = {
  reference: 'Jean 3:16',
  text: "Car Dieu a tant aime le monde qu'il a donne son Fils unique, afin que quiconque croit en lui ne perisse point, mais qu'il ait la vie eternelle.",
  provider: 'cache-disque',
  lang: 'fr',
  score: 0.82,
};

let quoteLookups = 0;
injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() { throw new Error('non utilisé dans ce test'); },
  async getVerseMultilang() { throw new Error('non utilisé dans ce test'); },
  buildReferenceLabel(reference) { return `Jean ${reference.chapter}`; },
  resetFailedProviders() {},
  findByQuotedText() { quoteLookups++; return { ...QUOTED }; },
  setCacheDir() {},
  setTranslation() {},
  listTranslations() { return []; },
  getTranslationId() { return 'lsg'; },
  getCacheSize() { return 0; },
  clearCache() {},
  getProviders() { return ['fake-provider']; },
});

const transcriptQueue = [];
injectFakeModule('groq-wrapper.js', {
  async transcribeFile() { throw new Error('non utilisé dans ce test'); },
  async transcribeWithFallback() {
    return { text: transcriptQueue.shift() || '', source: 'fake-groq' };
  },
});

injectFakeModule('deepgram-wrapper.js', {
  isConfigured() { return false; },
  async transcribeFile() { throw new Error('non utilisé dans ce test'); },
});

let onAudioSegment = null;
injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() { return false; },
  on(callbacks) { onAudioSegment = callbacks.onAudioSegment; },
});

process.env.PORT = process.env.PORT || '8767'; // distinct des autres tests
require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-quote-${Date.now()}-${Math.random()}.wav`);
}

(async () => {
  let passed = 0, failed = 0;
  function check(name, cond, detail) {
    if (cond) { console.log(`✅ ${name}`); passed++; }
    else { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
  }

  await sleep(300);

  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  const received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString())); } catch (_) {}
  });

  console.log('\n=== Scénario : verset lu à voix haute sans citer sa référence ===\n');

  await simulateSegment("car Dieu a tellement aime le monde qu il a donne son fils unique afin que quiconque croit en lui ne perisse point");
  await sleep(400);

  const shown = received.find((m) => m.action === 'showVerse');
  check('le verset reconnu par citation est diffusé', !!shown && shown.reference === QUOTED.reference, JSON.stringify(shown));
  check('le payload est marqué matchedByQuote', !!shown && shown.matchedByQuote === true);
  check('aucune erreur de transcription diffusée', !received.some((m) => m.action === 'transcriptionError'),
    JSON.stringify(received.find((m) => m.action === 'transcriptionError')));
  check('la citation est ajoutée à l\'historique', received.some((m) => m.action === 'historyUpdated'));

  // La même citation répétée dans les 30s ne doit PAS être rediffusée.
  received.length = 0;
  await simulateSegment("car Dieu a tellement aime le monde qu il a donne son fils unique afin que quiconque croit en lui ne perisse point");
  await sleep(400);
  check('la même citation répétée sous 30s n\'est pas rediffusée',
    !received.some((m) => m.action === 'showVerse'), JSON.stringify(received.find((m) => m.action === 'showVerse')));
  check('findByQuotedText a bien été consulté sur les deux segments', quoteLookups === 2, `appels=${quoteLookups}`);

  ws.close();
  console.log(`\n=== Résultat détection par citation : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Erreur fatale dans le test d\'intégration:', err);
  process.exit(1);
});
