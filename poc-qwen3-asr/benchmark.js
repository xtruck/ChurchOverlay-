// POC isolé — feasibility Qwen3-ASR (sherpa-onnx, build WASM) — PAS lié au
// pipeline de production. Basé sur l'exemple officiel
// nodejs-examples/test-offline-qwen3-asr.js du dépôt k2-fsa/sherpa-onnx.
'use strict';
const sherpa_onnx = require('sherpa-onnx');

const MODEL_DIR = './sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25';

function memMB() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function createOfflineRecognizer() {
  const config = {
    modelConfig: {
      qwen3Asr: {
        convFrontend: `${MODEL_DIR}/conv_frontend.onnx`,
        encoder: `${MODEL_DIR}/encoder.int8.onnx`,
        decoder: `${MODEL_DIR}/decoder.int8.onnx`,
        tokenizer: `${MODEL_DIR}/tokenizer`,
        hotwords: '',
      },
      tokens: '',
    },
  };
  return sherpa_onnx.createOfflineRecognizer(config);
}

function transcribe(recognizer, waveFilename) {
  const stream = recognizer.createStream();
  const wave = sherpa_onnx.readWave(waveFilename);
  stream.acceptWaveform(wave.sampleRate, wave.samples);

  const t0 = Date.now();
  recognizer.decode(stream);
  const decodeMs = Date.now() - t0;
  const text = recognizer.getResult(stream).text;
  stream.free();
  return { text, decodeMs };
}

async function main() {
  console.log('[POC] RAM avant chargement du modèle:', memMB(), 'MB');
  const cpuStart = process.cpuUsage();
  const loadStart = Date.now();
  const recognizer = createOfflineRecognizer();
  const loadMs = Date.now() - loadStart;
  const cpuLoad = process.cpuUsage(cpuStart);
  console.log(`[POC] Modèle chargé en ${loadMs}ms`);
  console.log('[POC] RAM après chargement du modèle:', memMB(), 'MB');
  console.log(
    `[POC] CPU pendant le chargement — user ${(cpuLoad.user / 1000).toFixed(0)}ms, system ${(cpuLoad.system / 1000).toFixed(0)}ms`
  );

  const samples = [
    { file: './samples/sample1_16k.wav', expected: 'Nous allons lire Jean chapitre trois verset seize.' },
    { file: './samples/sample2_16k.wav', expected: 'Premier Corinthiens chapitre treize verset quatre.' },
  ];

  for (const { file, expected } of samples) {
    console.log(`\n[POC] --- ${file} ---`);
    console.log(`[POC] Attendu (voix de synthèse TTS, PAS une voix humaine) : "${expected}"`);
    const cpuBefore = process.cpuUsage();
    const { text, decodeMs } = transcribe(recognizer, file);
    const cpuAfter = process.cpuUsage(cpuBefore);
    console.log(`[POC] Transcrit : "${text}"`);
    console.log(`[POC] Latence de décodage : ${decodeMs}ms`);
    console.log(
      `[POC] CPU pendant le décodage — user ${(cpuAfter.user / 1000).toFixed(0)}ms, system ${(cpuAfter.system / 1000).toFixed(0)}ms`
    );
    console.log('[POC] RAM après ce décodage:', memMB(), 'MB');
  }

  recognizer.free();
  console.log('\n[POC] RAM finale (après libération):', memMB(), 'MB');
}

main().catch((err) => {
  console.error('[POC] ÉCHEC:', err);
  process.exit(1);
});
