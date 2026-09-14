/**
 * ============================================================================
 *  integration-chapter-fallback-partial-fragment-confidence.js — le repli
 *  chapitre ne s'arme plus via le chemin RÉEL audio (partial-fragment
 *  Deepgram) quand ce fragment porte une confiance basse ou absente.
 * ----------------------------------------------------------------------------
 *  CORRECTIF (bug réel signalé en direct — voir server.js#processTranscript,
 *  server.js#verseDetectionAllowed) : integration-chapter-fallback-
 *  confidence-gate.js couvre déjà le garde-fou via l'action WS 'transcript'
 *  (saisie manuelle/débogage) — mais PAS le chemin réellement emprunté en
 *  production : onPartialTranscript (server.js), source 'partial-fragment',
 *  déclenché quand un même fragment Deepgram apparaît deux fois de suite
 *  dans les partials (voir recentPartialTexts). Ce chemin n'appelait
 *  enqueueTranscript() qu'avec `{ source: 'partial-fragment' }`, SANS
 *  transmettre `meta.confidence` — héritant silencieusement du même défaut
 *  "confiance inconnue = autorisé" que le correctif ferme désormais. C'est
 *  EXACTEMENT le trou par lequel un fragment de charabia (confiance basse ou
 *  Deepgram sans confidence du tout) pouvait armer scheduleChapterFallback()
 *  et afficher une référence jamais prononcée avec certitude — voir le
 *  rapport en direct : "Détection de verset ignorée (confiance 0.35 < 0.6,
 *  probable bruit)" suivi immédiatement de "Chapter fallback: Displayed
 *  Esther 1".
 *
 *  Simule le VRAI chemin (pas l'action WS de débogage) : injecte un faux
 *  audio-capture.js dont on() CAPTURE les handlers réels enregistrés par
 *  server.js, puis invoque directement onPartialTranscript(text, meta,
 *  tracker) — deux fois avec le même texte, pour satisfaire la condition de
 *  stabilité (recentPartialTexts) qui déclenche l'enfilage 'partial-fragment'.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

const FALLBACK_DELAY_MS = 300;
injectFakeModule('features-store.js', {
  setUserDataDir() {},
  readFeatures() {
    return { display: { chapterFallbackDelayMs: FALLBACK_DELAY_MS } };
  },
  writeFeatures() {},
  getWritableFile() {
    return null;
  },
});

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang() {
    throw new Error('non simulé dans ce test');
  },
  async getVerseMultilang(reference) {
    return {
      reference: `Esther ${reference.chapter}`,
      text: 'TEXTE_CHAPITRE_ENTIER_VIA_REPLI',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'TEXTE_CHAPITRE_ENTIER_VIA_REPLI',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel(reference) {
    return `Esther ${reference.chapter}`;
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
  async transcribeWithFallback() {
    return { text: '', source: 'fake-groq' };
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

// AJOUT (différence clé avec integration-chapter-fallback-confidence-gate.js) :
// on() CAPTURE les handlers réels que server.js enregistre (onPartialTranscript
// / onFinalTranscript inclus), au lieu de les ignorer — c'est ce qui permet à
// ce test d'exercer le VRAI chemin audio plutôt que l'action WS de débogage.
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

process.env.PORT = process.env.PORT || '8798'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  const received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch (_) {}
  });
  return { ws, received };
}

(async () => {
  let passed = 0,
    failed = 0;
  function check(name, cond, detail) {
    if (cond) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  await sleep(300);

  check(
    'setup: server.js a bien enregistré ses handlers via audioCapture.on()',
    !!capturedHandlers && typeof capturedHandlers.onPartialTranscript === 'function'
  );

  console.log(
    '\n=== Scénario 1 : fragment "partial-fragment" à confiance BASSE (0.2), stable sur 2 partials — jamais affiché ===\n'
  );
  {
    const { ws, received } = await openWs();
    const text = 'esther chapitre 1';
    const lowConfidenceMeta = { confidence: 0.2 };
    // Deux appels identiques : le premier alimente recentPartialTexts, le
    // second satisfait la condition de stabilité qui déclenche l'enfilage
    // 'partial-fragment' (voir server.js, onPartialTranscript).
    await capturedHandlers.onPartialTranscript(text, lowConfidenceMeta, null);
    await capturedHandlers.onPartialTranscript(text, lowConfidenceMeta, null);
    await sleep(FALLBACK_DELAY_MS + 1500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      "confiance basse (0.2) sur le VRAI chemin partial-fragment : repli chapitre NE s'affiche PAS",
      !shown,
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    '\n=== Scénario 2 : fragment "partial-fragment" à confiance ABSENTE (meta sans confidence) — jamais affiché ===\n'
  );
  {
    // C'est EXACTEMENT le bug réel : Deepgram omet parfois `confidence` sur
    // un partial (voir deepgram-streaming.js, alternative.confidence peut
    // être undefined) — ce cas doit être traité comme "confiance inconnue",
    // pas comme "autorisé".
    const { ws, received } = await openWs();
    const text = 'esther chapitre 2';
    const noConfidenceMeta = {};
    await capturedHandlers.onPartialTranscript(text, noConfidenceMeta, null);
    await capturedHandlers.onPartialTranscript(text, noConfidenceMeta, null);
    await sleep(FALLBACK_DELAY_MS + 1500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      "confiance absente (meta.confidence undefined) sur partial-fragment : repli chapitre NE s'affiche PAS",
      !shown,
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    '\n=== Scénario 3 : fragment "partial-fragment" à confiance HAUTE (0.9), stable — le repli chapitre s’affiche normalement ===\n'
  );
  {
    const { ws, received } = await openWs();
    const text = 'esther chapitre 3';
    const highConfidenceMeta = { confidence: 0.9 };
    await capturedHandlers.onPartialTranscript(text, highConfidenceMeta, null);
    await capturedHandlers.onPartialTranscript(text, highConfidenceMeta, null);
    await sleep(FALLBACK_DELAY_MS + 1500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      'confiance haute (0.9) sur partial-fragment : le repli chapitre s’affiche normalement',
      !!shown && shown.detectedBy === 'chapter-fallback',
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    `\n=== Résultat garde-fou de confiance — chemin réel partial-fragment : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
