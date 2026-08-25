/**
 * ============================================================================
 *  integration-trust-mode.js — Mode confiance (Partie 2 : auto/semi-auto/manuel)
 * ----------------------------------------------------------------------------
 *  RÈGLE MISSION : un bénévole débutant doit pouvoir commencer en manuel et
 *  gagner en confiance progressivement (auto -> semi-auto -> manuel, ou
 *  l'inverse). En 'auto' (défaut, comportement HISTORIQUE inchangé), un
 *  verset détecté automatiquement s'affiche directement. En 'semi-auto'/
 *  'manual', il doit être retenu (candidateVerse-like) et n'apparaître QUE
 *  si l'opérateur confirme (barre d'espace côté dashboard -> action WS
 *  confirmPendingVerse).
 *
 *  Ce test vérifie, via un VRAI server.js (mêmes mocks réseau/micro que
 *  integration-chapter-only-verse1.js) :
 *   1. mode 'auto' (défaut) : showVerse immédiat, comme avant ce chantier.
 *   2. mode 'semi-auto' : PAS de showVerse immédiat, mais pendingVerseConfirmation
 *      diffusé ; confirmPendingVerse déclenche ENSUITE le vrai showVerse.
 *   3. dismissPendingVerse : le verset en attente est abandonné, jamais affiché.
 *   4. changer de mode pendant qu'un verset est en attente le rejette proprement
 *      (pendingVerseDismissed), au lieu de le laisser orphelin.
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

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang(reference) {
    return {
      reference: `Jean ${reference.chapter}:${reference.verseStart}`,
      text: 'Car Dieu a tant aimé le monde...',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'Car Dieu a tant aimé le monde...',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}:${reference.verseStart}`;
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

process.env.PORT = process.env.PORT || '8779'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-trust-mode-${Date.now()}-${Math.random()}.wav`);
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
  let received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch (_) {}
  });
  function send(msg) {
    ws.send(JSON.stringify(msg));
  }

  // --- 1. Mode 'auto' (défaut) : comportement historique inchangé ---------
  console.log("\n=== Mode 'auto' (défaut) : showVerse immédiat ===\n");
  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'auto : showVerse diffusé immédiatement (Jean 3:16)',
    received.some((m) => m.action === 'showVerse' && m.reference === 'Jean 3:16'),
    JSON.stringify(received)
  );
  check(
    'auto : aucun pendingVerseConfirmation en mode auto',
    !received.some((m) => m.action === 'pendingVerseConfirmation'),
    undefined
  );

  // --- 2. Mode 'semi-auto' : en attente, puis confirmé -------------------
  console.log("\n=== Mode 'semi-auto' : en attente puis confirmation ===\n");
  received = [];
  send({ action: 'setTrustMode', mode: 'semi-auto' });
  await sleep(100);
  check(
    'trustModeChanged diffusé après setTrustMode',
    received.some((m) => m.action === 'trustModeChanged' && m.trustMode === 'semi-auto'),
    JSON.stringify(received)
  );

  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'semi-auto : PAS de showVerse immédiat (attend confirmation opérateur)',
    !received.some((m) => m.action === 'showVerse'),
    JSON.stringify(received)
  );
  const pending = received.find((m) => m.action === 'pendingVerseConfirmation');
  check(
    'semi-auto : pendingVerseConfirmation diffusé avec la bonne référence',
    !!pending && pending.reference === 'Jean 3:16' && pending.trustMode === 'semi-auto',
    JSON.stringify(pending)
  );

  received = [];
  send({ action: 'confirmPendingVerse' });
  await sleep(300);
  const confirmed = received.find((m) => m.action === 'showVerse');
  check(
    'semi-auto : confirmPendingVerse déclenche ENSUITE le vrai showVerse',
    !!confirmed && confirmed.reference === 'Jean 3:16',
    JSON.stringify(received)
  );

  // --- 3. dismissPendingVerse : jamais affiché -----------------------------
  console.log('\n=== dismissPendingVerse : verset en attente jamais affiché ===\n');
  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'un nouveau verset est bien en attente avant le dismiss',
    received.some((m) => m.action === 'pendingVerseConfirmation'),
    JSON.stringify(received)
  );

  received = [];
  send({ action: 'dismissPendingVerse' });
  await sleep(300);
  check(
    'dismissPendingVerse : pendingVerseDismissed diffusé',
    received.some((m) => m.action === 'pendingVerseDismissed' && m.reference === 'Jean 3:16'),
    JSON.stringify(received)
  );
  check(
    'dismissPendingVerse : aucun showVerse ne suit jamais',
    !received.some((m) => m.action === 'showVerse'),
    JSON.stringify(received)
  );

  // --- 4. Changer de mode pendant une attente rejette proprement ----------
  console.log('\n=== Changement de mode avec un verset en attente ===\n');
  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'un verset est de nouveau en attente avant le changement de mode',
    received.some((m) => m.action === 'pendingVerseConfirmation'),
    JSON.stringify(received)
  );

  received = [];
  send({ action: 'setTrustMode', mode: 'auto' });
  await sleep(300);
  check(
    'basculer vers auto avec un verset en attente le rejette (pendingVerseDismissed), ne le laisse pas orphelin',
    received.some((m) => m.action === 'pendingVerseDismissed' && m.reference === 'Jean 3:16'),
    JSON.stringify(received)
  );

  // Restaure 'auto' pour ne pas polluer un run suivant sur le même process.
  send({ action: 'setTrustMode', mode: 'auto' });

  ws.close();
  console.log(`\n=== Résultat mode confiance : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
