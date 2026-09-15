/**
 * ============================================================================
 *  integration-fragment-fusion-word-by-word-confidence.js — une référence
 *  dictée MOT PAR MOT avec des pauses (ex. « Esther... chapitre... 4...
 *  verset... 5 ») se reconstruit par fusion même si chaque mot isolé, pris
 *  individuellement, est en dessous de MIN_VERSE_CONFIDENCE.
 * ----------------------------------------------------------------------------
 *  CORRECTIF (bug réel signalé en direct) : une pause entre chaque mot fait
 *  finaliser le VAD local (voir audio-capture.js#finalizeStreamingUtteranceLocally,
 *  trailingSilenceMs) sur CHAQUE mot séparément — chacun de ces finals arrive
 *  donc à server.js#processTranscript comme un énoncé complet à lui seul, avec
 *  sa propre confiance ASR. Un mot isolé, surtout court (« 4 », « 5 »), reçoit
 *  souvent individuellement une confiance basse faute de contexte. AVANT ce
 *  correctif, sessionState.pushTranscriptFragment() n'était appelé QUE quand
 *  ce mot isolé dépassait déjà MIN_VERSE_CONFIDENCE — un mot bas-confiance
 *  n'entrait donc JAMAIS dans le buffer de fusion, et la reconstruction
 *  n'avait plus jamais assez de fragments pour aboutir : la référence ne
 *  s'affichait jamais, quand bien même le nom du livre avait, lui, été
 *  reconnu avec une confiance élevée.
 *
 *  Ce test exerce le VRAI chemin audio (onFinalTranscript, comme le ferait
 *  finalizeStreamingUtteranceLocally() sur chaque mot) — pas l'action WS de
 *  débogage — via le même mécanisme d'injection de faux modules + capture des
 *  handlers que integration-chapter-fallback-partial-fragment-confidence.js.
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

injectFakeModule('features-store.js', {
  setUserDataDir() {},
  readFeatures() {
    return {};
  },
  writeFeatures() {},
  getWritableFile() {
    return null;
  },
});

// AJOUT : évite tout appel réseau réel (helloao) pour un test hermétique et
// rapide — seule la RECONSTRUCTION de la référence par fusion nous intéresse
// ici, pas la résolution du texte du verset (déjà couverte ailleurs).
injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non simulé dans ce test');
  },
  async getChapterVersesMultilang() {
    throw new Error('non simulé dans ce test');
  },
  async getVerseMultilang(reference) {
    return {
      reference: `Esther ${reference.chapter}:${reference.verseStart}`,
      text: 'TEXTE_FAUX_POUR_TEST',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'TEXTE_FAUX_POUR_TEST',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel(reference) {
    return `Esther ${reference.chapter}:${reference.verseStart}`;
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
    !!capturedHandlers && typeof capturedHandlers.onFinalTranscript === 'function'
  );

  console.log(
    '\n=== Scénario 1 : "Esther" (confiance HAUTE) puis "chapitre 4" et "verset 5" (confiance BASSE), un mot à la fois — la référence se reconstruit ===\n'
  );
  {
    const { ws, received } = await openWs();
    await capturedHandlers.onFinalTranscript('Esther', { confidence: 0.85 }, null);
    await capturedHandlers.onFinalTranscript('chapitre 4', { confidence: 0.3 }, null);
    await capturedHandlers.onFinalTranscript('verset 5', { confidence: 0.25 }, null);
    await sleep(500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      "un seul mot bien reconnu (le nom du livre) suffit à autoriser la fusion : la référence Esther 4:5 s'affiche",
      !!shown && typeof shown.reference === 'string' && /esther\s*4:5/i.test(shown.reference),
      JSON.stringify(received.map((m) => ({ action: m.action, reference: m.reference })))
    );
    ws.close();
  }

  console.log(
    '\n=== Scénario 2 (non-régression) : TOUS les mots à confiance BASSE — la fusion reste refusée ===\n'
  );
  {
    const { ws, received } = await openWs();
    await capturedHandlers.onFinalTranscript('Esther', { confidence: 0.4 }, null);
    await capturedHandlers.onFinalTranscript('chapitre 5', { confidence: 0.3 }, null);
    await capturedHandlers.onFinalTranscript('verset 2', { confidence: 0.35 }, null);
    await sleep(500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      "aucun mot n'atteint MIN_VERSE_CONFIDENCE : la fusion n'affiche RIEN (protection anti-charabia préservée)",
      !shown,
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    `\n=== Résultat fusion de fragments mot-par-mot (confiance agrégée) : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
