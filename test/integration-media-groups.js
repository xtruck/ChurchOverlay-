/**
 * ============================================================================
 *  integration-media-groups.js — groupes de médias déclenchables à la voix
 *  (Partie 2.3, Mur Média)
 * ----------------------------------------------------------------------------
 *  DÉCISION DE SCOPE (aucune autre lecture univoque du cahier des charges) :
 *  un groupe nommé a ses PROPRES phrases déclencheuses ; les dire affiche le
 *  PROCHAIN membre du groupe (rotation round-robin), pas tous les membres à
 *  la fois — sert le cas d'usage réel "j'ai 5 photos, une seule phrase à
 *  retenir, chacune apparaît à son tour au fil du culte".
 *
 *  Vérifie, via un VRAI server.js (mêmes mocks réseau/micro que les autres
 *  tests integration-*.js) :
 *   1. le pipeline réel (processTranscript) déclenche bien la rotation d'un
 *      groupe à partir d'un texte transcrit, pas seulement l'action WS de
 *      gestion (addMediaGroup/setMediaItemGroup fonctionnent réellement de
 *      bout en bout, pas juste en test unitaire isolé de media-library.js).
 *   2. deleteMediaGroup/setMediaItemGroup diffusent bien mediaGroupsUpdated/
 *      mediaLibraryUpdated pour resynchroniser tous les tableaux de bord
 *      ouverts.
 *  Écrit dans le VRAI dossier userData (même convention que
 *  integration-trigger-phrase-test.js) — nettoyé en fin de test.
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

const fs = require('fs');
const os = require('os');
process.env.PORT = process.env.PORT || '8783'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const mediaLibrary = require('../media-library');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function makeSourceFile(filename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-media-groups-test-'));
  const p = path.join(dir, filename);
  fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  return p;
}
async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-media-groups-${Date.now()}-${Math.random()}.wav`);
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
  function send(msg) {
    ws.send(JSON.stringify(msg));
  }
  function waitForActionFrom(fromIndex, action, timeoutMs = 1500) {
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
  // Un seul message attendu : capturer `received.length` juste avant
  // waitForAction() suffit. Quand DEUX broadcasts distincts partent du même
  // handler serveur (ex. deleteMediaGroup ci-dessous, qui diffuse
  // mediaGroupsUpdated PUIS mediaLibraryUpdated), les attendre l'un après
  // l'autre avec deux waitForAction() séparés serait faux : le second
  // recalculerait `fromIndex` APRÈS que les deux soient déjà arrivés,
  // ratant le premier des deux — voir waitForActionFrom, capturé une seule
  // fois avant le send() correspondant.
  function waitForAction(action, timeoutMs = 1500) {
    return waitForActionFrom(received.length, action, timeoutMs);
  }

  const suffix = Date.now();
  let itemA, itemB, group;

  try {
    console.log('\n=== Préparation : 2 médias + 1 groupe, via les VRAIES actions WS ===\n');
    send({
      action: 'addMediaItem',
      sourcePath: makeSourceFile('groupe-a.png'),
      label: `Groupe test A ${suffix}`,
      triggerPhrases: [`test groupe a distincte ${suffix}`],
    });
    await waitForAction('mediaLibraryUpdated');
    itemA = mediaLibrary.listItems().find((i) => i.label === `Groupe test A ${suffix}`);

    send({
      action: 'addMediaItem',
      sourcePath: makeSourceFile('groupe-b.png'),
      label: `Groupe test B ${suffix}`,
      triggerPhrases: [`test groupe b distincte ${suffix}`],
    });
    await waitForAction('mediaLibraryUpdated');
    itemB = mediaLibrary.listItems().find((i) => i.label === `Groupe test B ${suffix}`);

    check('les 2 médias existent bien dans le vrai index', !!itemA && !!itemB);

    send({
      action: 'addMediaGroup',
      name: `Photos test ${suffix}`,
      triggerPhrases: [`montre une photo test ${suffix}`],
    });
    await waitForAction('mediaGroupsUpdated');
    group = mediaLibrary.listGroups().find((g) => g.name === `Photos test ${suffix}`);
    check('le groupe existe bien dans le vrai index', !!group);

    send({ action: 'setMediaItemGroup', itemId: itemA.id, groupId: group.id });
    await waitForAction('mediaGroupsUpdated');
    send({ action: 'setMediaItemGroup', itemId: itemB.id, groupId: group.id });
    await waitForAction('mediaGroupsUpdated');
    check(
      'les 2 médias sont bien rattachés au groupe',
      mediaLibrary.listGroups().find((g) => g.id === group.id).memberIds.length === 2
    );

    console.log('\n=== Le VRAI pipeline (processTranscript) déclenche la rotation ===\n');
    await simulateSegment(`montre une photo test ${suffix}`);
    const first = await waitForAction('showMedia');
    check(
      '1er énoncé -> showMedia du 1er membre, detectedBy=voice-cue-group',
      first.id === itemA.id && first.detectedBy === 'voice-cue-group',
      JSON.stringify(first)
    );

    await simulateSegment(`montre une photo test ${suffix}`);
    const second = await waitForAction('showMedia');
    check(
      '2e énoncé -> showMedia du 2e membre (rotation, jamais le même deux fois)',
      second.id === itemB.id,
      JSON.stringify(second)
    );

    console.log('\n=== getMediaGroups reflète le vrai état ===\n');
    send({ action: 'getMediaGroups' });
    const listed = await waitForAction('mediaGroupsUpdated');
    check(
      'getMediaGroups renvoie le groupe créé',
      listed.groups.some((g) => g.id === group.id),
      JSON.stringify(listed.groups.map((g) => g.id))
    );

    console.log('\n=== deleteMediaGroup détache proprement ses membres ===\n');
    const deleteBaseline = received.length;
    send({ action: 'deleteMediaGroup', id: group.id });
    await waitForActionFrom(deleteBaseline, 'mediaGroupsUpdated');
    const afterDelete = await waitForActionFrom(deleteBaseline, 'mediaLibraryUpdated');
    const itemAAfter = afterDelete.items.find((i) => i.id === itemA.id);
    check(
      "l'item ne pointe plus vers le groupe supprimé",
      itemAAfter && itemAAfter.group === null,
      JSON.stringify(itemAAfter)
    );
  } catch (err) {
    console.log(`❌ Erreur inattendue: ${err.message}`);
    failed++;
  }

  // Nettoyage : ne rien laisser derrière dans le VRAI dossier userData.
  if (itemA) mediaLibrary.deleteItem(itemA.id);
  if (itemB) mediaLibrary.deleteItem(itemB.id);
  if (group && mediaLibrary.listGroups().some((g) => g.id === group.id)) {
    mediaLibrary.deleteGroup(group.id);
  }

  ws.close();
  console.log(`\n=== Résultat groupes de médias : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
