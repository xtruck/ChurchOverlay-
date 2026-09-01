/**
 * ============================================================================
 *  test-ws-request-correlation.js — echo de requestId par le VRAI server.js
 * ----------------------------------------------------------------------------
 *  CORRECTIF (Phase 1G) : test-mcp-church-ws-client.js prouve que le CLIENT
 *  (mcp/church-ws-client.js) corrèle correctement par requestId contre un
 *  faux serveur WS générique — celui-ci prouve, contre le VRAI server.js,
 *  que les 9 actions consommées par mcp/server.js (voir son en-tête —
 *  showVerse/hideVerse/searchBible/getMediaLibrary/getSceneLibrary/
 *  triggerMediaItem/hideMedia/triggerScene/hideScene) échoient réellement le
 *  requestId reçu dans leur(s) réponse(s), succès ET erreur, y compris pour
 *  les actions dont le succès passe par broadcast() (pas juste ws.send()
 *  direct) — c'est justement CE chemin-là qui était le plus facile à oublier.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');
const assert = require('assert');

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
  async getVerseMultilang(reference) {
    return {
      book: reference.book,
      chapter: reference.chapter,
      verse: reference.verseStart || 1,
      text: 'Car Dieu a tant aimé le monde... (texte factice de test)',
      reference: `${reference.book} ${reference.chapter}:${reference.verseStart || 1}`,
    };
  },
  buildReferenceLabel(reference) {
    return `${reference.book} ${reference.chapter}`;
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

process.env.PORT = process.env.PORT || '8783'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  console.log('\n=== Echo de requestId par les 9 actions consommées par mcp/server.js ===\n');

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

  function waitForRequestId(id, timeoutMs = 1500) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        const found = received.find((m) => m.requestId === id);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: requestId ${id}`));
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  try {
    // NOTE : validation.js#SCHEMAS.showVerse exige un champ `text` sur le
    // message CLIENT (même si le handler serveur l'ignore et refait sa
    // propre recherche via bibleLookup.getVerseMultilang() — voir son
    // commentaire dans server.js) — placeholder requis pour passer la garde.
    console.log('--- showVerse : succès (via broadcast) ---');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'showVerse',
        reference: 'Jean 3:16',
        text: 'placeholder (ignoré par le handler)',
        requestId: 'req-1',
      })
    );
    const showVerseMsg = await waitForRequestId('req-1');
    check('showVerse succès porte le requestId de la requête', showVerseMsg.action === 'showVerse');

    console.log('--- showVerse : erreur (référence invalide) ---');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'showVerse',
        reference: 'PasUnLivre 99:99',
        text: 'placeholder (ignoré par le handler)',
        requestId: 'req-2',
      })
    );
    const showVerseErr = await waitForRequestId('req-2');
    check('showVerse erreur porte le requestId de la requête', showVerseErr.action === 'error');

    console.log('--- hideVerse (via broadcast) ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'hideVerse', requestId: 'req-3' }));
    const hideVerseMsg = await waitForRequestId('req-3');
    check('hideVerse porte le requestId de la requête', hideVerseMsg.action === 'hideVerse');

    console.log(
      '--- searchBible : réponse directe (searchError si moteur indisponible en test) ---'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'searchBible', query: 'grâce', requestId: 'req-4' }));
    const searchMsg = await waitForRequestId('req-4');
    check(
      'searchBible porte le requestId de la requête (searchResults ou searchError)',
      searchMsg.action === 'searchResults' || searchMsg.action === 'searchError'
    );

    console.log('--- getMediaLibrary : réponse directe ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'getMediaLibrary', requestId: 'req-5' }));
    const mediaLibMsg = await waitForRequestId('req-5');
    check(
      'getMediaLibrary porte le requestId de la requête',
      mediaLibMsg.action === 'mediaLibraryUpdated'
    );

    console.log('--- getSceneLibrary : réponse directe ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'getSceneLibrary', requestId: 'req-6' }));
    const sceneLibMsg = await waitForRequestId('req-6');
    check(
      'getSceneLibrary porte le requestId de la requête',
      sceneLibMsg.action === 'sceneLibraryUpdated'
    );

    console.log('--- triggerMediaItem : erreur (id inconnu) ---');
    received.length = 0;
    ws.send(
      JSON.stringify({ action: 'triggerMediaItem', id: 'id-inexistant', requestId: 'req-7' })
    );
    const triggerMediaErr = await waitForRequestId('req-7');
    check(
      'triggerMediaItem erreur porte le requestId de la requête',
      triggerMediaErr.action === 'error'
    );

    console.log('--- hideMedia (via broadcast) ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'hideMedia', requestId: 'req-8' }));
    const hideMediaMsg = await waitForRequestId('req-8');
    check('hideMedia porte le requestId de la requête', hideMediaMsg.action === 'hideMedia');

    console.log('--- triggerScene : erreur (id inconnu) ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'triggerScene', id: 'id-inexistant', requestId: 'req-9' }));
    const triggerSceneErr = await waitForRequestId('req-9');
    check(
      'triggerScene erreur porte le requestId de la requête',
      triggerSceneErr.action === 'error'
    );

    console.log('--- hideScene (via broadcast) ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'hideScene', requestId: 'req-10' }));
    const hideSceneMsg = await waitForRequestId('req-10');
    check('hideScene porte le requestId de la requête', hideSceneMsg.action === 'hideScene');

    console.log(
      "--- Un client qui n'envoie AUCUN requestId (tout le tableau de bord aujourd'hui) : comportement inchangé ---"
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'hideVerse' }));
    await sleep(300);
    const noIdMsg = received.find((m) => m.action === 'hideVerse');
    check(
      'aucun requestId envoyé -> aucun requestId dans la réponse (pas de champ ajouté à tort)',
      !!noIdMsg && !('requestId' in noIdMsg)
    );

    console.log('--- Deux showVerse concurrents, requestId distincts, résolus indépendamment ---');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'showVerse',
        reference: 'Jean 3:16',
        text: 'placeholder (ignoré par le handler)',
        requestId: 'concur-A',
      })
    );
    ws.send(
      JSON.stringify({
        action: 'showVerse',
        reference: 'Romains 8:28',
        text: 'placeholder (ignoré par le handler)',
        requestId: 'concur-B',
      })
    );
    const [msgA, msgB] = await Promise.all([
      waitForRequestId('concur-A'),
      waitForRequestId('concur-B'),
    ]);
    check(
      "chaque requestId concurrent est associé à SA PROPRE référence, pas celle de l'autre",
      msgA.book === 'jean' && msgB.book === 'romains'
    );
  } finally {
    ws.close();
  }

  console.log(
    `\n=== Résultat corrélation requestId (VRAI server.js) : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
