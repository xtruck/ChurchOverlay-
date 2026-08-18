/**
 * ============================================================================
 *  test-rundown-actions.js — Actions WS de la feuille de route (chantier 4.3)
 * ----------------------------------------------------------------------------
 *  server.js tourne réellement (comme integration-scene-crud.js), avec le
 *  VRAI rundown-store.js/media-library.js/scene-store.js — bible-lookup-
 *  with-api.js est mocké (comme test-ws-auth.js) pour que le scénario
 *  "déclencher un repère verset" ne dépende pas d'un accès réseau réel.
 *
 *  Couvre les 7 actions WS ajoutées (getRundown/addRundownCue/
 *  removeRundownCue/reorderRundownCues/triggerRundownCue/nextRundownCue/
 *  clearRundown), y compris la diffusion showVerse/showMedia/showScene
 *  réelle au déclenchement d'un repère de chaque type, et l'avancement
 *  séquentiel de nextRundownCue() à travers les trois types mélangés.
 *
 *  Même discipline que integration-scene-crud.js : écrit dans le VRAI
 *  dossier userData de la machine, snapshot/restauration complète en fin de
 *  test (la feuille de route est une fonctionnalité neuve, quasi certainement
 *  vide sur cette machine avant ce test — restaurée quand même par principe).
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

process.env.PORT = process.env.PORT || '8777'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test
require('../server.js');
const rundownStore = require('../rundown-store');
const mediaLibrary = require('../media-library');
const sceneStore = require('../scene-store');

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

  // Snapshot de l'état réel de la machine (feuille de route neuve, quasi
  // certainement vide, mais restaurée par principe comme le reste des tests
  // d'intégration de ce dépôt).
  const originalCues = rundownStore.listCues();
  rundownStore.clearCues();

  const mediaSource = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'churchoverlay-rundown-test-')
  );
  const mediaSourcePath = require('path').join(mediaSource, 'photo.png');
  require('fs').writeFileSync(mediaSourcePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const testMedia = mediaLibrary.addItem({ sourcePath: mediaSourcePath, label: 'Photo test' });
  const testScene = sceneStore.addScene({ name: 'Scène test rundown' });

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

  function waitForAction(action, timeoutMs = 1500) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = received.find((m) => m.action === action);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${action}`));
        setTimeout(check, 20);
      };
      check();
    });
  }

  try {
    console.log('\n=== Scénario : getRundown() renvoie une liste vide au départ ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'getRundown' }));
    const initial = await waitForAction('rundownUpdated');
    check(
      'rundownUpdated renvoyé, cues=[] et activeIndex=-1',
      Array.isArray(initial.cues) && initial.cues.length === 0 && initial.activeIndex === -1
    );

    console.log('\n=== Scénario : addRundownCue() type verse ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addRundownCue',
        type: 'verse',
        label: 'Jean 3:16',
        reference: 'Jean 3:16',
      })
    );
    let msg = await waitForAction('rundownUpdated');
    check(
      'le repère verset apparaît dans la diffusion',
      msg.cues.some((c) => c.type === 'verse')
    );
    check('le repère verset a bien été persisté côté store', rundownStore.listCues().length === 1);

    console.log('\n=== Scénario : addRundownCue() type media ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addRundownCue',
        type: 'media',
        label: testMedia.label,
        mediaId: testMedia.id,
      })
    );
    msg = await waitForAction('rundownUpdated');
    check(
      'le repère média apparaît dans la diffusion',
      msg.cues.some((c) => c.type === 'media' && c.mediaId === testMedia.id)
    );

    console.log('\n=== Scénario : addRundownCue() type scene ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addRundownCue',
        type: 'scene',
        label: testScene.name,
        sceneId: testScene.id,
      })
    );
    msg = await waitForAction('rundownUpdated');
    check(
      'le repère scène apparaît dans la diffusion',
      msg.cues.some((c) => c.type === 'scene' && c.sceneId === testScene.id)
    );
    check('3 repères en tout côté store', rundownStore.listCues().length === 3);

    console.log('\n=== Scénario : addRundownCue() invalide renvoie une erreur, pas de crash ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'addRundownCue', type: 'verse', label: 'Sans référence' }));
    await sleep(300);
    check(
      "un message d'erreur est renvoyé pour un repère verset sans référence",
      received.some((m) => m.action === 'error')
    );
    check(
      'aucun 4e repère ajouté malgré la tentative invalide',
      rundownStore.listCues().length === 3
    );

    const [verseCue, mediaCue, sceneCue] = rundownStore.listCues();

    console.log('\n=== Scénario : reorderRundownCues() ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'reorderRundownCues',
        orderedIds: [sceneCue.id, mediaCue.id, verseCue.id],
      })
    );
    msg = await waitForAction('rundownUpdated');
    check(
      'ordre reflété dans la diffusion',
      msg.cues.map((c) => c.id).join(',') === [sceneCue.id, mediaCue.id, verseCue.id].join(',')
    );
    check(
      'ordre bien persisté côté store',
      rundownStore
        .listCues()
        .map((c) => c.id)
        .join(',') === [sceneCue.id, mediaCue.id, verseCue.id].join(',')
    );

    console.log(
      '\n=== Scénario : triggerRundownCue() déclenche le bon repère (scène, 1er de la liste réordonnée) ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'triggerRundownCue', id: sceneCue.id }));
    const showSceneMsg = await waitForAction('showScene');
    check('showScene diffusé pour le bon id de scène', showSceneMsg.id === testScene.id);
    const activeMsg1 = await waitForAction('rundownActiveCue');
    check(
      'rundownActiveCue diffusé avec index=0 (position réordonnée)',
      activeMsg1.id === sceneCue.id && activeMsg1.index === 0
    );

    console.log(
      '\n=== Scénario : nextRundownCue() avance au repère suivant (média, position 1) ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'nextRundownCue' }));
    const showMediaMsg = await waitForAction('showMedia');
    check('showMedia diffusé pour le bon média', showMediaMsg.id === testMedia.id);
    const activeMsg2 = await waitForAction('rundownActiveCue');
    check('rundownActiveCue diffusé avec index=1', activeMsg2.index === 1);

    console.log(
      '\n=== Scénario : nextRundownCue() avance au dernier repère (verset, position 2) ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'nextRundownCue' }));
    const showVerseMsg = await waitForAction('showVerse');
    check(
      'showVerse diffusé (via le VRAI pipeline detector.parseReference + bibleLookup mocké)',
      showVerseMsg.book === 'jean' && showVerseMsg.chapter === 3
    );
    const activeMsg3 = await waitForAction('rundownActiveCue');
    check('rundownActiveCue diffusé avec index=2 (dernier repère)', activeMsg3.index === 2);

    console.log('\n=== Scénario : nextRundownCue() en fin de liste renvoie une erreur ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'nextRundownCue' }));
    await sleep(300);
    check(
      "un message d'erreur « fin de la feuille de route » est renvoyé, pas de crash",
      received.some((m) => m.action === 'error')
    );

    console.log('\n=== Scénario : triggerRundownCue() sur un id inconnu renvoie une erreur ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'triggerRundownCue', id: 'id-inexistant' }));
    await sleep(300);
    check(
      "un message d'erreur est renvoyé pour un id inconnu",
      received.some((m) => m.action === 'error')
    );

    console.log('\n=== Scénario : removeRundownCue() ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'removeRundownCue', id: mediaCue.id }));
    msg = await waitForAction('rundownUpdated');
    check(
      'le repère retiré ne figure plus dans la diffusion',
      !msg.cues.some((c) => c.id === mediaCue.id)
    );
    check('2 repères restants côté store', rundownStore.listCues().length === 2);

    console.log('\n=== Scénario : clearRundown() vide toute la feuille de route ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'clearRundown' }));
    msg = await waitForAction('rundownUpdated');
    check('rundownUpdated diffusé avec cues=[]', Array.isArray(msg.cues) && msg.cues.length === 0);
    check('feuille de route bien vidée côté store', rundownStore.listCues().length === 0);
  } finally {
    // Nettoyage — ne rien laisser derrière sur la machine.
    try {
      mediaLibrary.deleteItem(testMedia.id);
    } catch (_) {}
    try {
      sceneStore.deleteItem(testScene.id);
    } catch (_) {}
    rundownStore.clearCues();
    for (const cue of originalCues) {
      try {
        rundownStore.addCue(cue);
      } catch (_) {}
    }
    ws.close();
  }

  console.log(`\n=== Résultat actions feuille de route : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
