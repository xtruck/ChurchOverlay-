'use strict';
/**
 * Sonde temporaire : rejoue UN bloc TTS via le vrai pipeline (audio-capture +
 * deepgram-streaming) et affiche TOUS les partials/finals avec horodatage.
 * Ne modifie aucun fichier de production. USAGE :
 *   node live-tests/probe-block.js bloc1.wav
 */
const fs = require('fs');
const path = require('path');
const { loadDotEnvInto } = require('../dotenv-loader');
loadDotEnvInto(process.env, [path.join(__dirname, '..', '.env')]);
process.env.ASR_PROVIDER = 'deepgram';

const file = process.argv[2] || 'bloc1.wav';
const audioCapture = require('../audio-capture');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(pred, t) {
  const s = Date.now();
  while (Date.now() - s < t) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
}
function readWavPcm(p) {
  const buf = fs.readFileSync(p);
  return buf.subarray(buf.indexOf('data') + 8);
}

const t0 = Date.now();
let partialCount = 0;
let finalCount = 0;

audioCapture.on({
  onAudioSegment: (seg) => console.log(`[SEG] +${Date.now() - t0}ms "${seg && seg.text}"`),
  onPartialTranscript: (text, meta) => {
    partialCount++;
    console.log(
      `[PART +${Date.now() - t0}ms] "${text}" (conf ${(meta.confidence || 0).toFixed(2)})`
    );
  },
  onFinalTranscript: (text, meta) => {
    finalCount++;
    console.log(
      `[FINAL +${Date.now() - t0}ms] "${text}" (conf ${(meta.confidence || 0).toFixed(2)})`
    );
  },
  onAsrFallback: (info) => console.log(`[FALLBACK +${Date.now() - t0}ms] ${info.reason}`),
  onError: (err) => console.log(`[ERR +${Date.now() - t0}ms] ${err.message}`),
});

(async () => {
  await audioCapture.stopRecording();
  await sleep(500);
  await audioCapture.startBrowserCapture();
  const opened = await waitFor(() => audioCapture.isDeepgramStreamingActive(), 6000);
  console.log(`session ouverte: ${opened} (t0=0)`);
  const pcm = readWavPcm(path.join(__dirname, 'samples', file));
  const FRAME_BYTES = 640;
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    audioCapture.feedPcmChunk(pcm.subarray(offset, offset + FRAME_BYTES));
    await sleep(20);
  }
  const SILENCE = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < 60; i++) {
    audioCapture.feedPcmChunk(SILENCE);
    await sleep(20);
  }
  await audioCapture.stopRecording();
  await sleep(2500);
  console.log(`\npartials=${partialCount} finals=${finalCount} durée=${(Date.now() - t0) / 1000}s`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
