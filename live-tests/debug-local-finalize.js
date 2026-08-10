'use strict';
// Diagnostic ponctuel : vérifie finalizeStreamingUtteranceLocally() en
// isolation, WebSocket simulée (déterministe, pas de vrai réseau), pour
// séparer "la state machine est buggée" de "le test live n'attend pas assez
// longtemps / la file Silero prend du retard".
const EventEmitter = require('events');

process.env.DEEPGRAM_API_KEY = 'fake-key-for-debug';
process.env.ASR_PROVIDER = 'deepgram';
// VAD_PROVIDER non forcé : Silero réel (auto), comme en production.

const audioCapture = require('../audio-capture');
const deepgramStreaming = require('../deepgram-streaming');

class FakeWebSocket extends EventEmitter {
  constructor(_url, _options) {
    super();
    this.sent = [];
    FakeWebSocket.lastInstance = this;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.emit('close');
  }
  terminate() {
    this.emit('close');
  }
}
deepgramStreaming.setWsFactoryForTesting((url, options) => new FakeWebSocket(url, options));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function voicedChunk(bytes) {
  const buf = Buffer.alloc(bytes - (bytes % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    buf.writeInt16LE(i % 4 === 0 ? 12000 : -12000, i);
  }
  return buf;
}

async function main() {
  const finals = [];
  audioCapture.on({
    onFinalTranscript: (text, meta) => {
      finals.push({ text, meta });
      console.log(
        `[debug] onFinalTranscript: "${text}" (finalizedBy=${meta.finalizedBy || 'deepgram'})`
      );
    },
    onPartialTranscript: (text) => console.log(`[debug] onPartialTranscript: "${text}"`),
    onAudioSegment: () => console.log('[debug] ⚠ onAudioSegment (ne devrait pas arriver)'),
  });

  await audioCapture.startBrowserCapture();
  const fake = FakeWebSocket.lastInstance;
  fake.emit('open');

  // Laisse Silero charger (asynchrone, fire-and-forget côté audio-capture.js).
  await sleep(500);
  console.log('[debug] VAD actif après 500ms :', audioCapture.getVadProvider());

  // Simule un "partial" Deepgram reçu pendant qu'on parle (comme un vrai serait envoyé).
  fake.emit(
    'message',
    JSON.stringify({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'Jean chapitre trois seize', confidence: 0.9 }] },
    })
  );

  // Envoie ~800ms de voix (16 fenêtres Silero de 32ms via des chunks de 100ms), en pacing réel.
  console.log('[debug] Envoi de voix (~800ms)...');
  for (let i = 0; i < 8; i++) {
    audioCapture.feedPcmChunk(voicedChunk(3200)); // 100ms à 16kHz mono 16-bit
    await sleep(100);
  }
  console.log(
    '[debug] sileroSegmentHasSpeech après la voix ? (interne, non exposé — on observe le comportement)'
  );

  // Envoie du silence numérique en continu, avec pacing réel, jusqu'à 2s, en
  // vérifiant après CHAQUE frame si onFinalTranscript a fini par se déclencher.
  console.log("[debug] Envoi de silence, jusqu'à 2s, en observant...");
  const SILENCE = Buffer.alloc(3200);
  let firedAtMs = null;
  const silenceStart = Date.now();
  for (let i = 0; i < 20; i++) {
    audioCapture.feedPcmChunk(SILENCE);
    await sleep(100);
    if (finals.length > 0 && firedAtMs === null) {
      firedAtMs = Date.now() - silenceStart;
      console.log(`[debug] *** onFinalTranscript déclenché après ${firedAtMs}ms de silence ***`);
      break;
    }
  }

  if (finals.length === 0) {
    console.log('[debug] *** JAMAIS déclenché après 2s de silence — BUG confirmé ***');
  }

  await audioCapture.stopRecording();
  deepgramStreaming.setWsFactoryForTesting(null);
  process.exit(finals.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[debug] ÉCHEC:', err.message, err.stack);
  process.exit(1);
});
