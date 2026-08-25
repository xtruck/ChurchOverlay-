/**
 * ============================================================================
 *  integration-trigger-phrase-test.js — bouton "essayer" (Partie 2.3)
 * ----------------------------------------------------------------------------
 *  Vérifie que l'action WS testTriggerPhrase rejoue RÉELLEMENT le même
 *  chemin que la détection vocale (mediaLibrary.matchTriggerPhrase, puis
 *  songLibrary, puis sceneStore — voir processTranscript dans server.js) sur
 *  un texte tapé, pas une logique séparée qui pourrait diverger. server.js
 *  tourne réellement ; seuls le réseau (Groq/Deepgram) et le micro sont
 *  mockés, comme les autres tests integration-*.js de ce dossier.
 *
 *  Écrit dans le VRAI dossier userData de la machine (même convention que
 *  integration-media-poster-on-add.js/integration-session-stats.js — aucun
 *  moyen simple d'isoler ça, server.js résout USER_DATA_DIR depuis
 *  workerData/os.homedir(), pas une variable d'environnement) — l'item de
 *  test créé est supprimé en fin de test pour ne rien laisser derrière.
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

const fs = require('fs');
const os = require('os');
process.env.PORT = process.env.PORT || '8782'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const mediaLibrary = require('../media-library');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSourceFile(filename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-trigger-test-'));
  const p = path.join(dir, filename);
  fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  return p;
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

  // AJOUT (plusieurs testTriggerPhrase successifs, résultats différents
  // attendus à chaque fois) : `fromIndex` restreint la recherche aux
  // messages reçus APRÈS l'envoi de la requête correspondante — un
  // waitForAction() qui regarderait tout l'historique risquerait de
  // retrouver un résultat PÉRIMÉ d'un appel précédent au lieu d'attendre le
  // nouveau.
  function waitForAction(action, timeoutMs = 1500) {
    const fromIndex = received.length;
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const found = received.slice(fromIndex).find((m) => m.action === action);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${action}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  try {
    console.log('\n=== Ajout d’un média avec une phrase déclencheuse ===\n');
    const uniqueLabel = `Photo groupe jeunesse (test essayer, ${Date.now()})`;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath: makeSourceFile('trigger-test.png'),
        label: uniqueLabel,
        triggerPhrases: ['photo du groupe jeunesse (test essayer)'],
      })
    );
    await waitForAction('mediaLibraryUpdated');
    const createdItem = mediaLibrary.listItems().find((i) => i.label === uniqueLabel);
    check("média ajouté, retrouvé dans l'index réel", !!createdItem);

    console.log('\n=== testTriggerPhrase : phrase exacte -> match média ===\n');
    ws.send(
      JSON.stringify({
        action: 'testTriggerPhrase',
        text: 'photo du groupe jeunesse (test essayer)',
      })
    );
    const exact = await waitForAction('triggerPhraseTestResult');
    check(
      'phrase exacte -> matched=true, kind=media, bon label',
      exact.matched === true && exact.kind === 'media' && exact.label === uniqueLabel,
      JSON.stringify(exact)
    );

    console.log(
      '\n=== testTriggerPhrase : phrase noyée dans une longue transcription -> match quand même ===\n'
    );
    ws.send(
      JSON.stringify({
        action: 'testTriggerPhrase',
        text: 'alors on va montrer la photo du groupe jeunesse (test essayer) maintenant',
      })
    );
    const embedded = await waitForAction('triggerPhraseTestResult');
    check(
      'sous-chaîne trouvée dans une phrase plus longue',
      embedded.matched === true && embedded.kind === 'media',
      JSON.stringify(embedded)
    );

    console.log('\n=== testTriggerPhrase : aucune correspondance ===\n');
    ws.send(JSON.stringify({ action: 'testTriggerPhrase', text: 'bonjour à tous ce matin' }));
    const noMatch = await waitForAction('triggerPhraseTestResult');
    check(
      'aucune correspondance -> matched=false',
      noMatch.matched === false && noMatch.kind === null,
      JSON.stringify(noMatch)
    );

    console.log('\n=== testTriggerPhrase : texte vide -> matched=false, pas de crash ===\n');
    ws.send(JSON.stringify({ action: 'testTriggerPhrase', text: '' }));
    const empty = await waitForAction('triggerPhraseTestResult');
    check('texte vide géré proprement', empty.matched === false, JSON.stringify(empty));
  } catch (err) {
    console.log(`❌ Erreur inattendue: ${err.message}`);
    failed++;
  }

  // Nettoyage : ne rien laisser derrière dans le VRAI dossier userData
  // (même discipline que integration-media-poster-on-add.js).
  const leftover = mediaLibrary
    .listItems()
    .find((i) => i.label.startsWith('Photo groupe jeunesse'));
  if (leftover) mediaLibrary.deleteItem(leftover.id);

  ws.close();
  console.log(`\n=== Résultat bouton "essayer" : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
