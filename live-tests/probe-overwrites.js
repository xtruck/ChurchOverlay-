'use strict';
const fs = require('fs');
const path = require('path');
const { loadDotEnvInto } = require('../dotenv-loader');
loadDotEnvInto(process.env, [path.join(__dirname, '..', '.env')], () => {});
process.env.PORT = process.env.PORT || '8781';
process.env.ASR_PROVIDER = 'deepgram';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const audioCapture = require('../audio-capture');
const detector = require('../detector-compat');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function waitFor(pred, t) {
  return new Promise((res) => {
    const s = Date.now();
    const tick = () => {
      if (pred() || Date.now() - s >= t) return res(pred());
      setTimeout(tick, 20);
    };
    tick();
  });
}
function readWav(fp) {
  const b = fs.readFileSync(fp);
  return b.subarray(b.indexOf('data') + 8);
}

(async () => {
  await sleep(400);
  await audioCapture.stopRecording();
  await sleep(500);
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  const events = [];
  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (['transcript', 'transcriptPartial', 'showVerse', 'candidateVerse'].includes(m.action)) {
      events.push({ at: Date.now(), msg: m });
    }
  });
  for (const file of ['bloc1.wav', 'bloc2.wav', 'bloc3.wav']) {
    const pcm = readWav(path.join(__dirname, 'samples', file));
    await audioCapture.startBrowserCapture();
    await waitFor(() => audioCapture.isDeepgramStreamingActive(), 6000);
    const start = Date.now();
    const FRAME = 640;
    for (let o = 0; o < pcm.length; o += FRAME) {
      audioCapture.feedPcmChunk(pcm.subarray(o, o + FRAME));
      await sleep(20);
    }
    const SIL = Buffer.alloc(FRAME);
    for (let i = 0; i < 60; i++) {
      audioCapture.feedPcmChunk(SIL);
      await sleep(20);
    }
    await audioCapture.stopRecording();
    await sleep(2000);
    console.log(`\n===== ${file} (session start +${start}ms) =====`);
    for (const e of events) {
      if (e.msg.action === 'transcript' || e.msg.action === 'transcriptPartial') {
        let ref = null;
        try {
          ref = detector.detectBilingual(e.msg.text) || detector.detectExact(e.msg.text);
        } catch {}
        const tag = ref ? ` → ${ref.book}:${ref.chapter}:${ref.verseStart || ''}` : '';
        console.log(`  [${e.at - start}ms] ${e.msg.action} "${e.msg.text}"${tag}`);
      } else if (e.msg.action === 'showVerse') {
        console.log(`  [${e.at - start}ms] ★SHOWVERSE "${e.msg.reference}"`);
      } else if (e.msg.action === 'candidateVerse') {
        console.log(`  [${e.at - start}ms] ◈candidate "${JSON.stringify(e.msg.reference)}"`);
      }
    }
    events.length = 0;
  }
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
