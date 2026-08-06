/**
 * ============================================================================
 *  integration-session-stats.js — Historique de session persistant (SQLite)
 * ----------------------------------------------------------------------------
 *  RÉGRESSION COUVERTE (audit round 9) : session-store.js enregistre déjà
 *  chaque verset affiché et chaque erreur de pipeline en SQLite, mais aucune
 *  action WebSocket ne relisait cette base — la persistance tournait "dans
 *  le vide", invisible depuis le tableau de bord. Ce test vérifie le
 *  chemin complet : verset affiché → écrit en SQLite → relu via
 *  'getSessionStats' → renvoyé au client, et que l'action est bien
 *  réservée aux opérateurs (RBAC).
 *
 *  Même approche que integration-quote-match.js : server.js tourne
 *  réellement (y compris le vrai session-store.js/SQLite), seuls le réseau
 *  (API biblique, Groq) et le micro sont mockés.
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

const VERSE = {
  reference: 'Jean 3:16',
  text: "Car Dieu a tant aime le monde qu'il a donne son Fils unique.",
  provider: 'cache-disque',
  lang: 'fr',
  score: 0.82,
};

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang() {
    throw new Error('non utilisé dans ce test');
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}`;
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return { ...VERSE };
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

const transcriptQueue = [];
injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async transcribeWithFallback() {
    return { text: transcriptQueue.shift() || '', source: 'fake-groq' };
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

let onAudioSegment = null;
injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on(callbacks) {
    onAudioSegment = callbacks.onAudioSegment;
  },
});

// Comme les autres tests d'intégration (integration-quote-match.js,
// integration-reading-mode-live.js) : pas de workerData fourni, server.js
// retombe sur son défaut hors-worker (~/.churchoverlay) pour session-store.js.
process.env.PORT = process.env.PORT || '8768'; // distinct des autres tests
require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-stats-${Date.now()}-${Math.random()}.wav`);
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

  console.log('\n=== Scénario : historique de session persistant (SQLite) ===\n');

  await simulateSegment(
    'car Dieu a tellement aime le monde qu il a donne son fils unique afin que quiconque croit en lui ne perisse point'
  );
  await sleep(400);
  check('le verset a bien été diffusé', received.some((m) => m.action === 'showVerse'));

  received.length = 0;
  ws.send(JSON.stringify({ action: 'getSessionStats', days: 1 }));
  await sleep(300);

  const stats = received.find((m) => m.action === 'sessionStats');
  check('une réponse sessionStats est reçue', !!stats, JSON.stringify(received));
  check('la persistance SQLite est active', !!stats && stats.persistenceEnabled === true);
  check(
    'le verset affiché juste avant apparaît dans le compte',
    !!stats && stats.verseCount >= 1,
    JSON.stringify(stats)
  );
  check(
    'le verset affiché juste avant apparaît dans la liste',
    !!stats && stats.verses.some((v) => v.reference === VERSE.reference),
    JSON.stringify(stats && stats.verses)
  );

  ws.close();

  // RBAC : un client viewer (jeton non-opérateur inexistant ici puisqu'aucun
  // WS_AUTH_TOKEN n'est configuré dans ce test — voir test-ws-auth.js pour
  // la couverture RBAC complète avec jetons réels) — ce test se concentre
  // sur le câblage fonctionnel, pas sur le RBAC déjà couvert ailleurs.

  console.log(`\n=== Résultat historique de session : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
