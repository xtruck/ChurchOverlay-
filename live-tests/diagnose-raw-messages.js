'use strict';
// Diagnostic ponctuel : proxy transparent autour d'une VRAIE WebSocket
// Deepgram, pour observer les messages bruts (is_final/speech_final) que
// deepgram-streaming.js reçoit réellement. N'altère aucun comportement —
// forward pur, juste avec un console.log au passage.
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const { loadDotEnvInto } = require('../dotenv-loader');
loadDotEnvInto(process.env, [path.join(__dirname, '..', '.env')], () => {});

const deepgramStreaming = require('../deepgram-streaming');

class LoggingProxyWs {
  constructor(url, options) {
    this.real = new WebSocket(url, options);
    this.real.on('open', (...a) => this.emit('open', ...a));
    this.real.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(
          `[RAW] type=${msg.type} is_final=${msg.is_final} speech_final=${msg.speech_final} transcript=${JSON.stringify(msg.channel?.alternatives?.[0]?.transcript)}`
        );
      } catch (_e) {
        console.log('[RAW] non-JSON message');
      }
      this.emit('message', data);
    });
    this.real.on('error', (...a) => this.emit('error', ...a));
    this.real.on('close', (...a) => this.emit('close', ...a));
    this._handlers = {};
  }
  on(event, handler) {
    (this._handlers[event] = this._handlers[event] || []).push(handler);
  }
  emit(event, ...args) {
    (this._handlers[event] || []).forEach((h) => h(...args));
  }
  send(data) {
    this.real.send(data);
  }
  close() {
    this.real.close();
  }
  terminate() {
    this.real.terminate();
  }
}

deepgramStreaming.setWsFactoryForTesting((url, options) => new LoggingProxyWs(url, options));

function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  const dataStart = buf.indexOf('data') + 8;
  return buf.subarray(dataStart);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const session = deepgramStreaming.createSession({
    onOpen: () => console.log('[diag] session ouverte'),
    onPartial: (t) => console.log(`[diag] onPartial: "${t}"`),
    onFinal: (t) => console.log(`[diag] onFinal: "${t}"`),
    onError: (e) => console.log('[diag] onError:', e.message),
    onClose: () => console.log('[diag] session fermée'),
  });

  const pcm = readWavPcm(path.join(__dirname, 'samples', 'testA_16k.wav'));
  await sleep(300); // laisse la connexion s'ouvrir
  const FRAME_BYTES = 640;
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    session.sendAudio(pcm.subarray(offset, offset + FRAME_BYTES));
    await sleep(20);
  }
  console.log('[diag] audio terminé, envoi de 4s de silence...');
  const SILENCE = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < 200; i++) {
    session.sendAudio(SILENCE);
    await sleep(20);
  }
  session.finish();
  await sleep(1000);
  process.exit(0);
}

main();
