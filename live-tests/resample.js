'use strict';
// Rééchantillonnage 22050Hz -> 16000Hz mono PCM16 (interpolation linéaire),
// même recette que poc-qwen3-asr/resample.js — le format exact attendu par
// deepgram-streaming.js/audio-capture.js (linear16, 16000Hz, 1 canal).
const fs = require('fs');
const path = require('path');

function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  const sampleRate = buf.readUInt32LE(24);
  const dataStart = buf.indexOf('data') + 8;
  const samples = new Int16Array(
    buf.buffer,
    buf.byteOffset + dataStart,
    (buf.length - dataStart) / 2
  );
  return { sampleRate, samples };
}

function resampleLinear(samples, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    out[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out;
}

function writeWav(filePath, samples, sampleRate) {
  const dataSize = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

const dir = path.join(__dirname, 'samples');
for (const key of ['testA', 'testB', 'testC', 'testD']) {
  const inFile = path.join(dir, `${key}_raw.wav`);
  const outFile = path.join(dir, `${key}_16k.wav`);
  const { sampleRate, samples } = readWav(inFile);
  const resampled = resampleLinear(samples, sampleRate, 16000);
  writeWav(outFile, resampled, 16000);
  console.log(
    `${key}: ${inFile} (${sampleRate}Hz, ${samples.length} samples) -> ${outFile} (16000Hz, ${resampled.length} samples, ${(resampled.length / 16000).toFixed(2)}s)`
  );
}
