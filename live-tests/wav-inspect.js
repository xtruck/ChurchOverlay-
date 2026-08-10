'use strict';
/**
 * live-tests/wav-inspect.js — inspection programmatique d'un fichier WAV
 * (jamais de modification du fichier original). Lit l'en-tête réel plutôt
 * que de supposer un format PCM16 mono 16kHz — un WAV peut être stéréo, à
 * un autre sample rate, en 24/32 bits, etc.
 */
const fs = require('fs');

/**
 * @param {string} filePath
 * @returns {{
 *   sampleRate: number, channels: number, bitDepth: number, audioFormat: number,
 *   dataSize: number, durationSec: number,
 *   samplesPerChannel: Int16Array[]  // un tableau par canal, entrelacement défait
 * }}
 */
function inspectWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${filePath} : pas un fichier WAV RIFF valide`);
  }

  // Parcourt les chunks réels au lieu de supposer un header 44 octets fixe
  // (un WAV peut avoir des chunks additionnels avant 'data' — LIST, fact, etc.)
  let offset = 12;
  let fmt = null;
  let dataOffset = null;
  let dataSize = null;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(chunkStart),
        channels: buf.readUInt16LE(chunkStart + 2),
        sampleRate: buf.readUInt32LE(chunkStart + 4),
        byteRate: buf.readUInt32LE(chunkStart + 8),
        blockAlign: buf.readUInt16LE(chunkStart + 12),
        bitDepth: buf.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2); // chunks alignés sur 2 octets
  }
  if (!fmt) throw new Error(`${filePath} : chunk 'fmt ' introuvable`);
  if (dataOffset === null) throw new Error(`${filePath} : chunk 'data' introuvable`);
  if (fmt.audioFormat !== 1) {
    throw new Error(
      `${filePath} : audioFormat=${fmt.audioFormat} non supporté par ce diagnostic (seul PCM entier =1 est lu ; probablement IEEE float ou compressé)`
    );
  }
  if (fmt.bitDepth !== 16) {
    throw new Error(
      `${filePath} : bitDepth=${fmt.bitDepth} non supporté par ce diagnostic (seul 16 bits géré)`
    );
  }

  // Découpe data en un tableau interleaved, puis désentrelace par canal.
  const totalSamples = Math.floor(dataSize / 2);
  const interleaved = new Int16Array(buf.buffer, buf.byteOffset + dataOffset, totalSamples);
  const channels = fmt.channels;
  const perChannel = [];
  for (let c = 0; c < channels; c++) {
    const chanSamples = new Int16Array(Math.floor(totalSamples / channels));
    for (let i = 0; i < chanSamples.length; i++) {
      chanSamples[i] = interleaved[i * channels + c];
    }
    perChannel.push(chanSamples);
  }

  return {
    sampleRate: fmt.sampleRate,
    channels,
    bitDepth: fmt.bitDepth,
    audioFormat: fmt.audioFormat,
    dataSize,
    durationSec: totalSamples / channels / fmt.sampleRate,
    samplesPerChannel: perChannel,
  };
}

/** @param {Int16Array} samples @returns {{rms:number, peak:number, dcOffset:number, min:number, max:number}} */
function stats(samples) {
  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s;
    sumSq += s * s;
    peak = Math.max(peak, Math.abs(s));
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const mean = sum / samples.length;
  return {
    rms: Math.sqrt(sumSq / samples.length) / 32768,
    peak: peak / 32768,
    dcOffset: mean / 32768,
    min: min / 32768,
    max: max / 32768,
  };
}

function printReport(label, filePath) {
  const info = inspectWav(filePath);
  console.log(`\n=== ${label} (${filePath}) ===`);
  console.log(`  sample rate : ${info.sampleRate} Hz`);
  console.log(`  channels    : ${info.channels}`);
  console.log(`  bit depth   : ${info.bitDepth}`);
  console.log(`  duration    : ${info.durationSec.toFixed(3)}s`);
  info.samplesPerChannel.forEach((ch, i) => {
    const s = stats(ch);
    console.log(
      `  canal ${i} — RMS=${s.rms.toFixed(4)} peak=${s.peak.toFixed(4)} dcOffset=${s.dcOffset.toFixed(5)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)}`
    );
  });
  return info;
}

module.exports = { inspectWav, stats, printReport };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node live-tests/wav-inspect.js <fichier.wav>');
    process.exit(1);
  }
  printReport('Inspection', file);
}
