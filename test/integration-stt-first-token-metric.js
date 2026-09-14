/**
 * ============================================================================
 *  integration-stt-first-token-metric.js — sttFirstToken se peuple bien sur
 *  le chemin batch/segment réel (pas seulement le streaming Deepgram).
 * ----------------------------------------------------------------------------
 *  CORRECTIF (métrique jamais peuplée en usage réel — voir latency-stats.js,
 *  server.js#onAudioSegment) : 'asrFirstPartial' n'était marqué que côté
 *  streaming Deepgram (audio-capture.js#onPartial), un chemin seulement actif
 *  quand ASR_PROVIDER=deepgram/streaming est réglé explicitement.
 *  ASR_PROVIDER=auto (défaut, confirmé par les logs opérateur : "[ASR]
 *  provider=auto mode=batch") emprunte exclusivement le chemin batch/segment
 *  (onAudioSegment → asr-engine.js → groq.transcribeWithFallback), qui ne
 *  marquait QUE 'asrFinal' — sttFirstToken restait donc "(pas encore de
 *  donnée)" pour la quasi-totalité d'une session réelle.
 *
 *  Ce test exerce le VRAI chemin batch (capture les handlers réels via un
 *  faux audio-capture.js, comme integration-chapter-fallback-partial-
 *  fragment-confidence.js) et vérifie que latencyStats.getStats().sttFirstToken
 *  se peuple bien après un segment traité — pas seulement en unité isolée sur
 *  latency-stats.js (déjà couvert par test-latency-stats.js avec des marques
 *  synthétiques, pas le VRAI point d'émission).
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');
const { startTracker } = require('../latency-tracker');
const latencyStats = require('../latency-stats');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang() {
    throw new Error('non simulé dans ce test');
  },
  async getVerseMultilang() {
    return {
      reference: 'Jean 3:16',
      text: 'Car Dieu a tant aimé le monde...',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'Car Dieu a tant aimé le monde...',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel() {
    return 'Jean 3:16';
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null;
  },
  setCacheDir() {},
  setTranslation() {},
  listTranslations() {
    return [];
  },
  getTranslationId() {
    return 'lsg';
  },
  getCacheSize() {
    return 0;
  },
  clearCache() {},
  getProviders() {
    return ['fake-provider'];
  },
});

injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  // Simule le chemin batch réel : une seule réponse d'un coup, confiance
  // haute (transcription claire, pas du bruit — cf. verseDetectionAllowed).
  async transcribeWithFallback() {
    return { text: 'Jean chapitre 3 verset 16', source: 'fake-groq', confidence: 0.9 };
  },
});
injectFakeModule('deepgram-wrapper.js', {
  isConfigured() {
    return false;
  },
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
});

let capturedHandlers = null;
injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on(handlers) {
    capturedHandlers = handlers;
  },
});

process.env.PORT = process.env.PORT || '8799'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('✅', name);
    passed++;
  } else {
    console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

(async () => {
  await sleep(300);

  check(
    'setup: server.js a bien enregistré onAudioSegment',
    !!capturedHandlers && typeof capturedHandlers.onAudioSegment === 'function'
  );

  latencyStats._reset();
  const before = latencyStats.getStats();
  check('avant le segment : sttFirstToken sans donnée (count=0)', before.sttFirstToken.count === 0);

  // Simule EXACTEMENT ce que audio-capture.js fait avant d'appeler
  // onAudioSegment : un tracker créé à l'onset VAD (markVadOnset), avec sa
  // marque 'vad' déjà posée — c'est ce même tracker qui traverse tout le
  // pipeline (batch ASR -> détection -> affichage).
  const tracker = startTracker();
  tracker.mark('vad');
  await sleep(5); // écart mesurable entre 'vad' et l'ASR, comme en conditions réelles

  await capturedHandlers.onAudioSegment('/tmp/fake-segment-does-not-need-to-exist.wav', tracker);

  await sleep(200); // laisse le pipeline (détection, affichage) se terminer

  const summary = tracker.summary();
  check(
    "le tracker porte bien une marque 'asrFirstPartial' sur le chemin batch",
    typeof summary.deltas.asrFirstPartial === 'number'
  );
  check(
    "'asrFirstPartial' et 'asrFinal' tombent au même instant (pas de vrai partial en mode batch — voir le commentaire dans server.js)",
    summary.deltas.asrFinal === 0 || summary.deltas.asrFinal === undefined
  );

  const after = latencyStats.getStats();
  check(
    'après le segment : sttFirstToken EST peuplé (count=1) — le vrai bug est corrigé',
    after.sttFirstToken.count === 1,
    JSON.stringify(after)
  );
  check(
    'la valeur enregistrée correspond au délai réel VAD -> ASR (>= 5ms simulés)',
    typeof after.sttFirstToken.p50 === 'number' && after.sttFirstToken.p50 >= 5
  );

  console.log(
    `\n=== Résultat métrique sttFirstToken (chemin batch réel) : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
