'use strict';
/**
 * live-tests/resample-compare.js — compare le ré-échantillonnage linéaire
 * actuel (live-tests/resample.js, interpolation naïve) à un ré-échantillonnage
 * de qualité via ffmpeg (swresample, sinc — déjà présent sur cette machine,
 * voir `Get-Command ffmpeg`, aucune nouvelle dépendance installée), puis
 * lance Silero sur les deux versions pour voir si la qualité du
 * ré-échantillonnage explique l'absence de détection de parole (§5 du
 * rapport demandé).
 *
 * USAGE : node live-tests/resample-compare.js <fichier_raw.wav>
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const { inspectWav } = require('./wav-inspect');
const { analyzeFile } = require('./silero-probability-timeline');

function linearResample(inFile, outFile) {
  const fsmod = require('fs');
  const buf = fsmod.readFileSync(inFile);
  const sampleRate = buf.readUInt32LE(24);
  const dataStart = buf.indexOf('data') + 8;
  const samples = new Int16Array(
    buf.buffer,
    buf.byteOffset + dataStart,
    (buf.length - dataStart) / 2
  );
  const ratio = sampleRate / 16000;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    out[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  const dataSize = out.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fsmod.writeFileSync(outFile, Buffer.concat([header, Buffer.from(out.buffer)]));
}

function ffmpegResample(inFile, outFile) {
  // -ar 16000 mono s16 PCM, ré-échantillonnage sinc de qualité (swresample,
  // moteur par défaut de ffmpeg — nettement plus propre qu'une interpolation
  // linéaire, sans lib externe : ffmpeg est déjà présent sur cette machine).
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  execFileSync(
    'ffmpeg',
    ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', outFile],
    {
      stdio: 'pipe',
    }
  );
}

async function main() {
  const rawFile = process.argv[2];
  if (!rawFile) {
    console.error('Usage: node live-tests/resample-compare.js <fichier_raw.wav>');
    process.exit(1);
  }
  const dir = path.dirname(rawFile);
  const base = path.basename(rawFile, path.extname(rawFile));
  const linearOut = path.join(dir, `${base}_cmp_linear16k.wav`);
  const ffmpegOut = path.join(dir, `${base}_cmp_ffmpeg16k.wav`);

  console.log('=== Ré-échantillonnage ===');
  linearResample(rawFile, linearOut);
  console.log(`Linéaire (actuel) -> ${linearOut}`);
  ffmpegResample(rawFile, ffmpegOut);
  console.log(`ffmpeg (qualité)  -> ${ffmpegOut}`);

  const origInfo = inspectWav(rawFile);
  console.log(
    `\nOriginal : ${origInfo.sampleRate}Hz, ${origInfo.channels} canal/aux, ${origInfo.durationSec.toFixed(2)}s`
  );

  const linearResult = await analyzeFile('Ré-échantillonnage LINÉAIRE (actuel)', linearOut);
  const ffmpegResult = await analyzeFile('Ré-échantillonnage FFMPEG (qualité)', ffmpegOut);

  console.log('\n\n================ COMPARAISON ================');
  console.log(
    'Linéaire  — max=%s mean=%s p95=%s',
    linearResult.statefulSummary.max.toFixed(4),
    linearResult.statefulSummary.mean.toFixed(4),
    linearResult.statefulSummary.p95.toFixed(4)
  );
  console.log(
    'ffmpeg    — max=%s mean=%s p95=%s',
    ffmpegResult.statefulSummary.max.toFixed(4),
    ffmpegResult.statefulSummary.mean.toFixed(4),
    ffmpegResult.statefulSummary.p95.toFixed(4)
  );

  process.exit(0);
}

main().catch((err) => {
  console.error('ÉCHEC:', err.message);
  console.error(err.stack);
  process.exit(1);
});
