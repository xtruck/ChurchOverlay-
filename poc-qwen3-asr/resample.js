'use strict';
// Rééchantillonnage simple (interpolation linéaire) 22050Hz -> 16000Hz mono
// PCM16 — suffisant pour un test de POC, pas un usage broadcast.
const fs = require('fs');

function readWav(path) {
  const buf = fs.readFileSync(path);
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

function writeWav(path, samples, sampleRate) {
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
  fs.writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

for (const [inFile, outFile] of [
  ['samples/sample1_raw.wav', 'samples/sample1_16k.wav'],
  ['samples/sample2_raw.wav', 'samples/sample2_16k.wav'],
]) {
  const { sampleRate, samples } = readWav(inFile);
  const resampled = resampleLinear(samples, sampleRate, 16000);
  writeWav(outFile, resampled, 16000);
  console.log(`${inFile} (${sampleRate}Hz, ${samples.length} samples) -> ${outFile} (16000Hz, ${resampled.length} samples, ${(resampled.length / 16000).toFixed(2)}s)`);
}
