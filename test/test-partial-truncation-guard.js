/**
 * ============================================================================
 *  test-partial-truncation-guard.js — garde anti-affichage d'un partial
 *  tronqué (Étape 5) — régression du bug smoke-A, mesuré en conditions réelles.
 * ----------------------------------------------------------------------------
 *  Scénario réel prouvé par le banc (live-tests/corpus-bench.js, provider
 *  deepgram) : le VAD local finalise le partial TRONQUÉ « Jean chapitre 3
 *  verset » (le « 16 » n'est pas encore sorti de Deepgram) dès qu'il détecte
 *  le silence de fin de phrase. En promeuvent ce texte en "final", l'ancien
 *  pipeline affichait la référence résolue « chapitre seul » avec le repli
 *  verse 1 → « Jean 3:1 » (FAUX), puis le vrai final Deepgram (« ... verset
 *  16. ») arrivait soit dédoublonné (suppression silencieuse), soit après —
 *  l'overlay finissait TOUJOURS sur le mauvais verset, de façon non
 *  déterministe.
 *
 *  Le correctif : un texte finalisé localement (meta.finalizedBy ===
 *  'local-vad-silence') dont la référence résolue est « chapitre seul »
 *  (verseStart indéfini) n'est JAMAIS affiché — on diffuse une
 *  candidateVerse spéculative et on attend le final officiel Deepgram, seule
 *  source autoritaire du texte. Une référence EXPLICITE (verset entier)
 *  reste affichée immédiatement, y compris venue d'une finalisation locale
 *  (pas de régression de latence pour les énoncés complets).
 *
 *  Le test pilote le VRAI server.js (pipeline réel : startPipeline ->
 *  audio-capture -> processTranscript -> WS), avec une WebSocket Deepgram
 *  simulée (deepgram-streaming.setWsFactoryForTesting — pas de vraie clé
 *  dans cet environnement), et observe les évènements comme un vrai client
 *  WS (même architecture que corpus-bench.js).
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const path = require('path');

const { loadDotEnvInto } = require('../dotenv-loader');
loadDotEnvInto(process.env, [path.join(__dirname, '..', '.env')], () => {});

process.env.DEEPGRAM_API_KEY = 'fake-key-for-test';
process.env.ASR_PROVIDER = 'deepgram';
process.env.VAD_PROVIDER = 'rms';
process.env.PORT = '8791';
process.env.MIC_SILENCE_THRESHOLD = '0';

console.log('=== Test garde anti-partial tronqué (smoke-A) ===\n');

class FakeWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.lastInstance = this;
  }
  send(data) {
    this.sent.push(data);
    if (typeof data === 'string' && data.includes('CloseStream')) {
      setImmediate(() => this.close());
    }
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
  terminate() {
    this.closed = true;
    this.emit('close');
  }
}

const deepgramStreaming = require('../deepgram-streaming');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

deepgramStreaming.setWsFactoryForTesting((url, options) => new FakeWebSocket(url, options));

// On lance le VRAI serveur : startPipeline() démarre une capture au boot,
// qui ouvre une session Deepgram via la fabrique simulée ci-dessus.
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)
require('../server.js');
const audioCapture = require('../audio-capture');
const detector = require('../detector-compat');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

function resultMessage({ transcript, isFinal = false, confidence = 0.9 }) {
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript, confidence }] },
  });
}

/** Chunk PCM16LE voisé — fait progresser le VAD (markVadOnset / segmentHasSpeech). */
function makeVoicedChunk(byteLength) {
  const buf = Buffer.alloc(byteLength - (byteLength % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    buf.writeInt16LE(i % 4 === 0 ? 12000 : -12000, i);
  }
  return buf;
}

function parseRef(str) {
  try {
    return detector.parseReference(str);
  } catch (_e) {
    return null;
  }
}

function refKeyOf(ref) {
  if (!ref || !ref.book) return null;
  return `${ref.book}:${ref.chapter}:${ref.verseStart || ''}`;
}

async function run() {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const events = [];
  const onMessage = (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_e) {
      return;
    }
    if (
      msg.action === 'transcript' ||
      msg.action === 'transcriptPartial' ||
      msg.action === 'transcriptRejected' ||
      msg.action === 'showVerse' ||
      msg.action === 'candidateVerse'
    ) {
      events.push({ at: Date.now(), msg });
    }
  };
  ws.on('message', onMessage);

  const fake = FakeWebSocket.lastInstance;
  assert(fake, 'une WebSocket simulée aurait dû être créée au boot du serveur');
  fake.emit('open');
  assert(
    await waitFor(() => audioCapture.isDeepgramStreamingActive()),
    'session streaming active attendue'
  );

  // -------------------------------------------------------------------------
  // Scénario A (régression smoke-A) : partial TRONQUÉ puis vrai final.
  // -------------------------------------------------------------------------
  console.log(
    '[TEST] A: partial tronqué "Jean chapitre 3 verset" finalisé localement ' +
      'ne doit PAS afficher "Jean 3:1"...'
  );

  // ~3s de voix : pose segmentHasSpeech (minSpeechDuration=500ms) et le tracker.
  for (let i = 0; i < 30; i++) {
    audioCapture.feedPcmChunk(makeVoicedChunk(3200));
  }
  await sleep(50);

  // Deepgram renvoie un partial toujours en cours (le « 16 » n'est pas encore là).
  fake.emit('message', resultMessage({ transcript: 'Jean chapitre 3 verset', isFinal: false }));
  await sleep(100);

  // Silence VAD local >= trailingSilenceMs (600ms) : déclenche
  // finalizeStreamingUtteranceLocally() avec finalizedBy='local-vad-silence'.
  // NB: VAD_FRAME_MS=100ms => une trame VAD = 3200 octets ; la finalisation
  // passe par le correcteur (échec d'appel IA -> repli) ; la candidateVerse
  // spéculative arrive donc après ce détour — on l'attend. On envoie 40
  // chunks (800ms de silence) pour couvrir le décalage d'alignement de trame
  // laissé par l'énoncé précédent (1280 octets en attente dans l'accumulateur).
  const silenceFrame = Buffer.alloc(640);
  for (let i = 0; i < 40; i++) {
    audioCapture.feedPcmChunk(silenceFrame);
  }
  assert(
    await waitFor(
      () => events.some((e) => e.msg.action === 'candidateVerse' && e.msg.speculative === true),
      8000
    ),
    'la candidateVerse spéculative devrait finir par être diffusée'
  );

  const showVerseBeforeFinal = events.filter((e) => e.msg.action === 'showVerse');
  assert.strictEqual(
    showVerseBeforeFinal.length,
    0,
    'aucun showVerse ne doit partir pendant la finalisation locale d’un partial tronqué'
  );
  const candidate = events.find(
    (e) => e.msg.action === 'candidateVerse' && e.msg.speculative === true
  );
  assert(candidate, 'une candidateVerse spéculative devrait être diffusée à la place');
  assert.strictEqual(candidate.msg.reference.chapter, 3);
  console.log('[TEST] A ✓ aucun showVerse, candidateVerse spéculative diffusée\n');

  console.log(
    '[TEST] B: le vrai final Deepgram "Jean chapitre 3 verset 16." doit alors afficher Jean 3:16...'
  );
  fake.emit(
    'message',
    resultMessage({ transcript: 'Jean chapitre 3 verset 16.', isFinal: true, confidence: 0.7 })
  );
  assert(
    await waitFor(() => events.some((e) => e.msg.action === 'showVerse')),
    'un showVerse devrait arriver après le final officiel'
  );
  const shown = events.filter((e) => e.msg.action === 'showVerse');
  const keys = shown.map((e) => refKeyOf(parseRef(e.msg.reference))).filter(Boolean);
  assert(
    keys.includes('jean:3:16'),
    `la référence affichée devrait être jean:3:16 (vu: ${JSON.stringify(keys)})`
  );
  assert(
    !keys.includes('jean:3:1'),
    `"Jean 3:1" ne doit JAMAIS être affiché (vu: ${JSON.stringify(keys)})`
  );
  console.log(`[TEST] B ✓ Jean 3:16 affiché, jamais Jean 3:1 (${JSON.stringify(keys)})\n`);

  // -------------------------------------------------------------------------
  // Scénario C (pas de régression) : une référence EXPLICITE complète venue
  // d'une finalisation locale est affichée immédiatement, sans attendre le
  // final officiel (latence préservée — cas smoke-C).
  // -------------------------------------------------------------------------
  console.log(
    '[TEST] C: une référence complète finalisée localement reste affichée immédiatement ' +
      '(pas de régression de latence)...'
  );
  const beforeC = events.length;
  for (let i = 0; i < 30; i++) {
    audioCapture.feedPcmChunk(makeVoicedChunk(3200));
  }
  await sleep(50);
  fake.emit(
    'message',
    resultMessage({ transcript: 'Lisons dans 1 Corinthiens 13 verset 4.', isFinal: false })
  );
  await sleep(100);
  for (let i = 0; i < 40; i++) {
    audioCapture.feedPcmChunk(silenceFrame);
  }
  assert(
    await waitFor(() => events.slice(beforeC).some((e) => e.msg.action === 'showVerse')),
    'la référence complète devrait être affichée dès la finalisation locale'
  );
  const shownC = events.slice(beforeC).filter((e) => e.msg.action === 'showVerse');
  const keysC = shownC.map((e) => refKeyOf(parseRef(e.msg.reference))).filter(Boolean);
  assert(
    keysC.includes('1corinthiens:13:4'),
    `la référence complète doit s’afficher via la finalisation locale (vu: ${JSON.stringify(keysC)})`
  );
  console.log(`[TEST] C ✓ 1 Corinthiens 13:4 affiché sans attendre le final officiel\n`);

  // -------------------------------------------------------------------------
  // Scénario D (Étape 5c/5d — stabilité) : une référence HIGH n'est affichée
  // sur un partial que si elle est DÉJÀ confirmée par un partial précédent du
  // même énoncé. Première occurrence : candidateVerse spéculative seule.
  // Seconde occurrence identique : affichage direct via le partial.
  // -------------------------------------------------------------------------
  console.log(
    "[TEST] D: une référence n'est affichée sur partial que si elle est stable " +
      '(≥2 partials consécutifs identiques)...'
  );
  const beforeD = events.length;
  for (let i = 0; i < 30; i++) {
    audioCapture.feedPcmChunk(makeVoicedChunk(3200));
  }
  await sleep(50);
  const partialActs = 'Lisons dans Actes 2 verset 38.';
  fake.emit('message', resultMessage({ transcript: partialActs, isFinal: false }));
  await sleep(200);
  const candidateD = events
    .slice(beforeD)
    .find((e) => e.msg.action === 'candidateVerse' && e.msg.speculative === true);
  assert(
    candidateD,
    'la première occurrence d’une référence sur un partial doit rester spéculative'
  );
  assert.strictEqual(candidateD.msg.reference.verseStart, 38);
  const shownAfterFirstPartial = events.slice(beforeD).filter((e) => e.msg.action === 'showVerse');
  assert.strictEqual(
    shownAfterFirstPartial.length,
    0,
    'aucun affichage avant confirmation (stabilité ≥2 partials)'
  );
  console.log('[TEST] D ✓ première occurrence spéculative, aucun affichage');

  fake.emit('message', resultMessage({ transcript: partialActs, isFinal: false }));
  assert(
    await waitFor(() => events.slice(beforeD).some((e) => e.msg.action === 'showVerse')),
    'la seconde occurrence identique devrait confirmer et afficher le verset'
  );
  const shownD = events.slice(beforeD).filter((e) => e.msg.action === 'showVerse');
  const keysD = shownD.map((e) => refKeyOf(parseRef(e.msg.reference))).filter(Boolean);
  assert(
    keysD.includes('actes:2:38'),
    `la référence confirmée doit être affichée (vu: ${JSON.stringify(keysD)})`
  );
  console.log(`[TEST] D ✓ seconde occurrence → affichage direct (${JSON.stringify(keysD)})\n`);

  await audioCapture.stopRecording();
  ws.close();
  deepgramStreaming.setWsFactoryForTesting(null);
  delete process.env.ASR_PROVIDER;
  console.log('=== Garde anti-partial tronqué : tous les tests passent ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  console.error(err.stack);
  deepgramStreaming.setWsFactoryForTesting(null);
  process.exit(1);
});
