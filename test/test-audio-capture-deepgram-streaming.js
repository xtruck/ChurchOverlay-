/**
 * ============================================================================
 *  test-audio-capture-deepgram-streaming.js — Deepgram streaming branché sur
 *  audio-capture.js, de bout en bout (ASR_PROVIDER=deepgram).
 * ----------------------------------------------------------------------------
 *  Prouve l'architecture demandée : quand le streaming est actif, AUCUN
 *  segment WAV n'est écrit (onAudioSegment ne se déclenche jamais tant que
 *  le streaming tient) — les chunks PCM partent directement vers la
 *  WebSocket au fil de l'eau. Vérifie aussi le repli : une erreur streaming
 *  fait retomber sur le pipeline segment/WAV classique SANS perdre l'audio
 *  qui suit.
 *
 *  WebSocket simulée (voir deepgram-streaming.setWsFactoryForTesting) — pas
 *  de vraie clé Deepgram disponible dans cet environnement, voir l'en-tête
 *  de deepgram-streaming.js. Ce test valide NOTRE câblage, pas les serveurs
 *  Deepgram réels.
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const EventEmitter = require('events');

process.env.DEEPGRAM_API_KEY = 'fake-key-for-test';
process.env.ASR_PROVIDER = 'deepgram';
// Ce test vérifie le CÂBLAGE (streaming actif -> pas de WAV, erreur -> repli
// -> WAV classique reprend), pas la précision de Silero — force RMS pour
// rester synchrone et déterministe (Silero classifie de façon asynchrone
// par fenêtre de 32ms ; voir test-audio-capture-silero-integration.js pour
// le test dédié à Silero, qui doit lui pacer les chunks en temps réel pour
// laisser sa file le temps de traiter avant le plafond de sécurité).
process.env.VAD_PROVIDER = 'rms';

const audioCapture = require('../audio-capture');
const deepgramStreaming = require('../deepgram-streaming');

console.log('=== Test intégration Deepgram Streaming <-> audio-capture.js ===\n');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultMessage({ transcript, isFinal = false, confidence = 0.9 }) {
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript, confidence }] },
  });
}

/** Chunk PCM16LE voisé (amplitude franche) — sert à faire progresser le VAD. */
function makeVoicedChunk(byteLength) {
  const buf = Buffer.alloc(byteLength - (byteLength % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    buf.writeInt16LE(i % 4 === 0 ? 12000 : -12000, i);
  }
  return buf;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

async function run() {
  deepgramStreaming.setWsFactoryForTesting((url, options) => new FakeWebSocket(url, options));

  const segments = [];
  const partials = [];
  const finals = [];
  const fallbacks = [];
  audioCapture.on({
    onAudioSegment: (file, tracker) => segments.push({ file, tracker }),
    onPartialTranscript: (text, meta, tracker) => partials.push({ text, meta, tracker }),
    onFinalTranscript: (text, meta, tracker) => finals.push({ text, meta, tracker }),
    onAsrFallback: (info) => fallbacks.push(info),
    onError: (err) => console.error('[TEST] onError inattendu:', err.message),
  });

  console.log('[TEST] Test 1: startBrowserCapture() avec ASR_PROVIDER=deepgram ouvre une session streaming...');
  await audioCapture.startBrowserCapture();
  assert.strictEqual(audioCapture.getAsrProvider(), 'deepgram');
  const fake = FakeWebSocket.lastInstance;
  assert(fake, 'une WebSocket simulée aurait dû être créée');
  fake.emit('open');
  const becameActive = await waitFor(() => audioCapture.isDeepgramStreamingActive());
  assert.strictEqual(becameActive, true, 'isDeepgramStreamingActive() devrait devenir true après "open"');
  console.log('[TEST] ✓ Session streaming active\n');

  console.log(
    '[TEST] Test 2: les chunks PCM partent directement vers la WebSocket, ' +
      'AUCUN segment WAV écrit tant que le streaming est sain...'
  );
  const chunk = makeVoicedChunk(3200); // 100ms à 16kHz mono 16-bit — assez pour déclencher markVadOnset
  audioCapture.feedPcmChunk(chunk);
  await sleep(50); // laisse la file Silero/RMS traiter la trame (asynchrone pour Silero)
  assert(fake.sent.includes(chunk), 'le chunk PCM devrait avoir été envoyé tel quel à la WebSocket');
  assert.strictEqual(segments.length, 0, 'aucun segment WAV ne devrait être écrit pendant le streaming');
  console.log('[TEST] ✓ Chunks forwardés en direct, pipeline WAV inactif\n');

  console.log('[TEST] Test 3: un Results partiel (is_final=false) déclenche onPartialTranscript avec un tracker...');
  fake.emit('message', resultMessage({ transcript: 'Jean trois', isFinal: false }));
  assert.strictEqual(partials.length, 1);
  assert.strictEqual(partials[0].text, 'Jean trois');
  assert(partials[0].tracker, 'un tracker de latence devrait accompagner le partial (VAD déjà déclenché au Test 2)');
  assert('asrFirstPartial' in partials[0].tracker.summary().deltas, 'le mark asrFirstPartial doit être posé');
  console.log('[TEST] ✓ Partial routé avec latence VAD->ASR mesurée\n');

  console.log('[TEST] Test 4: un Results final (is_final=true) déclenche onFinalTranscript...');
  fake.emit('message', resultMessage({ transcript: 'Jean trois seize', isFinal: true, confidence: 0.95 }));
  assert.strictEqual(finals.length, 1);
  assert.strictEqual(finals[0].text, 'Jean trois seize');
  assert.strictEqual(finals[0].meta.confidence, 0.95);
  const finalSummary = finals[0].tracker.summary();
  assert('asrFirstPartial' in finalSummary.deltas && 'asrFinal' in finalSummary.deltas);
  console.log(`[TEST] ✓ Final routé, latence bout-en-bout mesurée (${finalSummary.totalMs}ms)\n`);

  console.log('[TEST] Test 5: une erreur streaming déclenche le repli (onAsrFallback) et désactive le streaming...');
  fake.emit('error', new Error('connexion perdue'));
  assert.strictEqual(fallbacks.length, 1);
  assert.strictEqual(audioCapture.isDeepgramStreamingActive(), false);
  console.log('[TEST] ✓ Repli déclenché proprement\n');

  console.log(
    '[TEST] Test 6: après repli, le pipeline segment/WAV classique reprend ' +
      '(un segment WAV finit par être créé pour de l\'audio qui suit)...'
  );
  const config = audioCapture.getConfig();
  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const segmentBytes = (config.segmentDuration / 1000) * samplesPerSecond * bytesPerSample;
  audioCapture.feedPcmChunk(makeVoicedChunk(segmentBytes));
  await sleep(100);
  assert.strictEqual(segments.length, 1, 'un segment WAV aurait dû être créé après le repli');
  console.log('[TEST] ✓ Repli fonctionnel — audio non perdu après la panne streaming\n');

  await audioCapture.stopRecording();
  deepgramStreaming.setWsFactoryForTesting(null);
  delete process.env.ASR_PROVIDER;
  console.log('=== Tous les tests d\'intégration Deepgram streaming sont passés ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  console.error(err.stack);
  deepgramStreaming.setWsFactoryForTesting(null);
  process.exit(1);
});
