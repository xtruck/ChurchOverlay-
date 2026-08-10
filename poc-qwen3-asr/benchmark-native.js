// POC isolé — même test que benchmark.js mais via le paquet natif
// sherpa-onnx-node (binaire N-API réel, pas WASM) — pour vérifier si
// l'échec WASM ("unreachable") est spécifique au build WASM (limite de
// mémoire linéaire probable pour un modèle de 705 Mo) ou plus profond.
'use strict';
const sherpa_onnx = require('sherpa-onnx-node');

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
      numThreads: 2,
      debug: false,
    },
  };
  return new sherpa_onnx.OfflineRecognizer(config);
}

function transcribe(recognizer, waveFilename) {
  const wave = sherpa_onnx.readWave(waveFilename);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });

  const cpuBefore = process.cpuUsage();
  const t0 = Date.now();
  recognizer.decode(stream);
  const decodeMs = Date.now() - t0;
  const cpu = process.cpuUsage(cpuBefore);
  const text = recognizer.getResult(stream).text;
  return { text, decodeMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000 };
}

async function main() {
  console.log('[POC-native] RAM avant chargement du modèle:', memMB(), 'MB');
  const loadStart = Date.now();
  const recognizer = createOfflineRecognizer();
  const loadMs = Date.now() - loadStart;
  console.log(`[POC-native] Modèle chargé en ${loadMs}ms`);
  console.log('[POC-native] RAM après chargement du modèle:', memMB(), 'MB');

  const samples = [
    {
      file: './samples/sample1_16k.wav',
      expected: 'Nous allons lire Jean chapitre trois verset seize.',
    },
    {
      file: './samples/sample2_16k.wav',
      expected: 'Premier Corinthiens chapitre treize verset quatre.',
    },
  ];

  for (const { file, expected } of samples) {
    console.log(`\n[POC-native] --- ${file} ---`);
    console.log(
      `[POC-native] Attendu (voix de synthèse TTS, PAS une voix humaine) : "${expected}"`
    );
    const { text, decodeMs, cpuUserMs, cpuSystemMs } = transcribe(recognizer, file);
    console.log(`[POC-native] Transcrit : "${text}"`);
    console.log(`[POC-native] Latence de décodage : ${decodeMs}ms`);
    console.log(
      `[POC-native] CPU pendant le décodage — user ${cpuUserMs.toFixed(0)}ms, system ${cpuSystemMs.toFixed(0)}ms (numThreads: 2)`
    );
    console.log('[POC-native] RAM après ce décodage:', memMB(), 'MB');
  }
}

main().catch((err) => {
  console.error('[POC-native] ÉCHEC:', err);
  process.exit(1);
});
