'use strict';
// Diagnostic ponctuel : même chose que debug-local-finalize.js mais avec de
// la VRAIE voix (TTS) plutôt qu'une onde carrée synthétique — pour savoir
// si Silero classe correctement l'onde carrée comme "pas de la parole"
// (comportement voulu) plutôt que d'être un vrai bug.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

process.env.DEEPGRAM_API_KEY = 'fake-key-for-debug';
process.env.ASR_PROVIDER = 'deepgram';

const audioCapture = require('../audio-capture');
const deepgramStreaming = require('../deepgram-streaming');

class FakeWebSocket extends EventEmitter {
  constructor() {
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
deepgramStreaming.setWsFactoryForTesting(() => new FakeWebSocket());

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function readWavPcm(p) {
  const buf = fs.readFileSync(p);
  const dataStart = buf.indexOf('data') + 8;
  return buf.subarray(dataStart);
}

async function main() {
  const finals = [];
  audioCapture.on({
    onFinalTranscript: (text, meta) => {
      finals.push({ text, meta, at: Date.now() });
      console.log(
        `[debug] onFinalTranscript @ ${Date.now()}: "${text}" (finalizedBy=${meta.finalizedBy || 'deepgram'})`
      );
    },
    onPartialTranscript: () => {},
    onAudioSegment: () => console.log('[debug] onAudioSegment (unexpected)'),
  });

  await audioCapture.startBrowserCapture();
  const fake = FakeWebSocket.lastInstance;
  fake.emit('open');
  await sleep(500);
  console.log('[debug] VAD:', audioCapture.getVadProvider());

  fake.emit(
    'message',
    JSON.stringify({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'Jean chapitre 3 verset 16', confidence: 0.9 }] },
    })
  );

  const pcm = readWavPcm(path.join(__dirname, 'samples', 'testA_16k.wav'));
  const FRAME_BYTES = 640;
  const t0 = Date.now();
  console.log('[debug] feeding real audio, real-time paced...');
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    audioCapture.feedPcmChunk(pcm.subarray(offset, offset + FRAME_BYTES));
    await sleep(20);
  }
  console.log(
    `[debug] audio done after ${Date.now() - t0}ms wall-clock (audio itself is ~3.36s), now feeding silence up to 5s...`
  );
  const SILENCE = Buffer.alloc(FRAME_BYTES);
  const silenceStart = Date.now();
  for (let i = 0; i < 250; i++) {
    audioCapture.feedPcmChunk(SILENCE);
    await sleep(20);
    if (finals.length > 0) {
      console.log(
        `[debug] *** finalized after ${Date.now() - silenceStart}ms of silence-feeding (wall clock) ***`
      );
      break;
    }
  }
  if (finals.length === 0) console.log('[debug] *** never fired after 5s of silence ***');

  await audioCapture.stopRecording();
  deepgramStreaming.setWsFactoryForTesting(null);
  process.exit(finals.length > 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
