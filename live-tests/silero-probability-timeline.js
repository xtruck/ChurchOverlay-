'use strict';
/**
 * live-tests/silero-probability-timeline.js — fait tourner le VRAI modèle
 * Silero (models/silero_vad.onnx, via silero-vad.js — le module de
 * production, inchangé) sur un fichier WAV entier, fenêtre par fenêtre
 * (512 échantillons, 32ms, comme audio-capture.js), en mode STATEFUL
 * (état LSTM réinjecté d'une fenêtre à l'autre — comportement de
 * production) ET en mode STATELESS (état réinitialisé à chaque fenêtre,
 * pour comparaison — voir §9 du rapport).
 *
 * N'utilise PAS audio-capture.js (pas de file d'attente asynchrone, pas de
 * pacing temps réel à respecter) — appelle silero-vad.js directement, pour
 * un résultat déterministe et rapide sur un fichier déjà en mémoire.
 *
 * USAGE : node live-tests/silero-probability-timeline.js <fichier.wav> [canal]
 */
const { inspectWav } = require('./wav-inspect');
const sileroVad = require('../silero-vad');

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return NaN;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

function summarize(probs) {
  const sorted = [...probs].sort((a, b) => a - b);
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  const pctAbove = (t) => (probs.filter((p) => p >= t).length / probs.length) * 100;
  return {
    count: probs.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    pctAbove01: pctAbove(0.1),
    pctAbove02: pctAbove(0.2),
    pctAbove03: pctAbove(0.3),
    pctAbove04: pctAbove(0.4),
    pctAbove05: pctAbove(0.5),
  };
}

/**
 * @param {Int16Array} samplesInt16 - échantillons PCM16, DÉJÀ à 16kHz mono
 * @param {boolean} stateful
 * @returns {Promise<number[]>} une probabilité par fenêtre de 512 échantillons
 */
async function runSilero(samplesInt16, stateful) {
  const { ok, error } = await sileroVad.init();
  if (!ok) throw new Error(`Silero indisponible : ${error}`);

  const probs = [];
  let streamState = sileroVad.createStreamState();
  const W = sileroVad.WINDOW_SAMPLES;
  for (let offset = 0; offset + W <= samplesInt16.length; offset += W) {
    const windowInt16 = samplesInt16.subarray(offset, offset + W);
    const floatSamples = new Float32Array(W);
    for (let i = 0; i < W; i++) floatSamples[i] = windowInt16[i] / 32768;

    if (!stateful) streamState = sileroVad.createStreamState(); // état neuf à CHAQUE fenêtre
    const prob = await sileroVad.processWindow(floatSamples, streamState);
    probs.push(prob);
  }
  return probs;
}

function printTimeline(probs, windowMs, bucketSec = 1) {
  const windowsPerBucket = Math.round((bucketSec * 1000) / windowMs);
  for (let i = 0; i < probs.length; i += windowsPerBucket) {
    const bucket = probs.slice(i, i + windowsPerBucket);
    const avg = bucket.reduce((a, b) => a + b, 0) / bucket.length;
    const startSec = (i * windowMs) / 1000;
    const endSec = (Math.min(probs.length, i + windowsPerBucket) * windowMs) / 1000;
    console.log(
      `  ${startSec.toFixed(1)}–${endSec.toFixed(1)}s → moyenne=${avg.toFixed(4)} (max=${Math.max(...bucket).toFixed(4)})`
    );
  }
}

async function analyzeFile(label, filePath, channelIndex = 0) {
  console.log(`\n########## ${label} : ${filePath} (canal ${channelIndex}) ##########`);
  const info = inspectWav(filePath);
  if (info.sampleRate !== sileroVad.SAMPLE_RATE) {
    console.log(
      `  ⚠ ATTENTION : sample rate ${info.sampleRate}Hz ≠ ${sileroVad.SAMPLE_RATE}Hz attendu par Silero — ` +
        `ce diagnostic va quand même faire tourner le modèle dessus TEL QUEL (pas de ré-échantillonnage ici) pour voir l'effet réel d'un mauvais sample rate. Utilisez resample-compare.js pour un ré-échantillonnage correct.`
    );
  }
  const samples = info.samplesPerChannel[channelIndex];
  if (!samples)
    throw new Error(`Canal ${channelIndex} inexistant (fichier a ${info.channels} canal/aux)`);

  const windowMs = (sileroVad.WINDOW_SAMPLES / sileroVad.SAMPLE_RATE) * 1000;

  console.log('\n--- Mode STATEFUL (comportement de production, état LSTM conservé) ---');
  const statefulProbs = await runSilero(samples, true);
  printTimeline(statefulProbs, windowMs);
  const statefulSummary = summarize(statefulProbs);
  console.log('  Résumé STATEFUL:', JSON.stringify(statefulSummary, null, 2));

  console.log('\n--- Mode STATELESS (état réinitialisé à chaque fenêtre, comparaison §9) ---');
  const statelessProbs = await runSilero(samples, false);
  const statelessSummary = summarize(statelessProbs);
  console.log('  Résumé STATELESS:', JSON.stringify(statelessSummary, null, 2));

  return { info, statefulSummary, statelessSummary, statefulProbs, statelessProbs };
}

module.exports = { analyzeFile, runSilero, summarize, printTimeline };

if (require.main === module) {
  const file = process.argv[2];
  const channel = process.argv[3] ? Number.parseInt(process.argv[3], 10) : 0;
  if (!file) {
    console.error('Usage: node live-tests/silero-probability-timeline.js <fichier.wav> [canal]');
    process.exit(1);
  }
  analyzeFile('Analyse', file, channel)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('ÉCHEC:', err.message);
      console.error(err.stack);
      process.exit(1);
    });
}
