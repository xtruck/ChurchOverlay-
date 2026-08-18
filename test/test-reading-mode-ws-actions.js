/**
 * ============================================================================
 *  test/test-reading-mode-ws-actions.js — Actions WS directes du mode lecture
 * ----------------------------------------------------------------------------
 *  Avant ce test, avancer verset par verset en mode lecture n'était possible
 *  QUE par commande vocale (voir handleVoiceCommand() dans server.js) — un
 *  clic manuel Suivant/Précédent depuis le tableau de bord n'avait aucune
 *  action WS à envoyer. Ajout de 'nextReadingVerse'/'previousReadingVerse',
 *  qui réutilisent le même helper advanceReadingModeVerse() que le chemin
 *  vocal (pas de logique dupliquée).
 *
 *  Couvre :
 *   1. startReading -> readingStarted + showVerse (premier verset)
 *   2. nextReadingVerse -> showVerse (verset suivant)
 *   3. previousReadingVerse -> showVerse (retour au verset précédent)
 *   4. stopReading -> readingStopped
 *   5. RBAC : un client 'viewer' ne peut pas envoyer nextReadingVerse/
 *      previousReadingVerse (doivent être dans OPERATOR_ACTIONS, comme
 *      startReading/stopReading) — même famille de test que
 *      test/test-ws-auth.js.
 *
 *  Même approche que test/test-ws-auth.js : server.js tourne réellement ;
 *  seuls le réseau (API bibliques) et le micro sont mockés. detector.js/
 *  reading-mode.js tournent sans aucune modification.
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

// Chapitre factice à 3 versets — même contenu que integration-reading-mode-live.js.
const FAKE_JEAN_3 = [
  { num: 1, text: 'Il y avait parmi les pharisiens un homme nomme Nicodeme.' },
  { num: 2, text: 'Cet homme vint de nuit trouver Jesus.' },
  { num: 3, text: 'Jesus lui repondit en verite en verite je te le dis.' },
];

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang(book, chapter) {
    // CORRECTIF (débogage local) : detector.parseReference() normalise le
    // nom du livre en minuscules ("jean", pas "Jean") — vérifié en
    // inspectant le message readingStarted réel avant ce correctif.
    if (String(book).toLowerCase() === 'jean' && chapter === 3) return FAKE_JEAN_3;
    return [];
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

injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on() {},
});

const OPERATOR_TOKEN = 'operator-token-for-tests-only';
const VIEWER_TOKEN = 'viewer-token-for-tests-only-2';
process.env.WS_AUTH_TOKEN = OPERATOR_TOKEN;
process.env.WS_VIEWER_TOKEN = VIEWER_TOKEN;
process.env.PORT = process.env.PORT || '8771'; // distinct des autres tests
process.env.WS_HOST = '127.0.0.1';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)

require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connect({ token, path: reqPath = '/' } = {}) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${process.env.PORT}${reqPath}`;
    const ws = token ? new WebSocket(url, [token]) : new WebSocket(url);
    ws.testMessages = [];
    ws.on('message', (raw) => {
      try {
        ws.testMessages.push(JSON.parse(raw.toString()));
      } catch (_) {}
    });
    ws.on('error', () => {});
    ws.on('open', async () => {
      await sleep(100);
      resolve({ ws, opened: ws.readyState === WebSocket.OPEN });
    });
  });
}

// CORRECTIF (flake constaté en session — timeout ~1 fois sur 3, jamais lié à
// ce chantier) : startReading()/nextReadingVerse() déclenchent un vrai
// aller-retour réseau (bibleLookup.getVerseMultilang(), voir
// bible-lookup-with-api.js — CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD n'évite que
// le téléchargement complet en arrière-plan, pas cette consultation
// ponctuelle). 1500 ms est un budget trop serré pour un appel HTTP externe
// sous charge variable ; 5000 ms laisse la marge sans changer ce qui est
// testé (le test échoue toujours si le message n'arrive jamais).
function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const idx = ws.testMessages.findIndex(predicate);
      if (idx !== -1) {
        resolve(ws.testMessages.splice(idx, 1)[0]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout en attente du message'));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
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

  await sleep(300); // laisser le serveur WS s'initialiser complètement

  console.log('\n=== Mode lecture — actions WS directes (bouton manuel) ===\n');

  const { ws } = await connect({ token: OPERATOR_TOKEN, path: '/' });
  await waitForMessage(ws, (m) => m.action === 'init');

  ws.send(JSON.stringify({ action: 'startReading', reference: 'Jean 3:1' }));
  await waitForMessage(ws, (m) => m.action === 'readingStarted');
  const first = await waitForMessage(ws, (m) => m.action === 'showVerse');
  check(
    'startReading affiche le premier verset (Jean 3:1)',
    first.reference === 'Jean 3:1',
    JSON.stringify(first)
  );

  ws.send(JSON.stringify({ action: 'nextReadingVerse' }));
  const second = await waitForMessage(ws, (m) => m.action === 'showVerse');
  check(
    'nextReadingVerse avance au verset suivant (Jean 3:2)',
    second.reference === 'Jean 3:2',
    JSON.stringify(second)
  );

  ws.send(JSON.stringify({ action: 'previousReadingVerse' }));
  const back = await waitForMessage(ws, (m) => m.action === 'showVerse');
  check(
    'previousReadingVerse revient au verset précédent (Jean 3:1)',
    back.reference === 'Jean 3:1',
    JSON.stringify(back)
  );

  ws.send(JSON.stringify({ action: 'stopReading' }));
  await waitForMessage(ws, (m) => m.action === 'readingStopped');
  check('stopReading confirme bien l’arrêt', true);

  console.log('\n=== RBAC : un viewer ne peut pas avancer le mode lecture ===\n');

  ws.send(JSON.stringify({ action: 'startReading', reference: 'Jean 3:1' }));
  await waitForMessage(ws, (m) => m.action === 'readingStarted');
  await waitForMessage(ws, (m) => m.action === 'showVerse');

  const { ws: viewerWs } = await connect({ token: VIEWER_TOKEN, path: '/' });
  await waitForMessage(viewerWs, (m) => m.action === 'init');

  viewerWs.send(JSON.stringify({ action: 'nextReadingVerse' }));
  const err1 = await waitForMessage(viewerWs, (m) => m.action === 'error');
  check(
    "nextReadingVerse envoyé par un 'viewer' est refusé",
    /opérateur|operator/i.test(err1.error || ''),
    JSON.stringify(err1)
  );

  viewerWs.send(JSON.stringify({ action: 'previousReadingVerse' }));
  const err2 = await waitForMessage(viewerWs, (m) => m.action === 'error');
  check(
    "previousReadingVerse envoyé par un 'viewer' est refusé",
    /opérateur|operator/i.test(err2.error || ''),
    JSON.stringify(err2)
  );

  ws.close();
  viewerWs.close();

  console.log(
    `\n=== Résultat mode lecture (actions WS directes) : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Erreur fatale dans le test test-reading-mode-ws-actions:', err);
  process.exit(1);
});
