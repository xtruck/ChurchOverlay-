/**
 * ============================================================================
 *  integration-scene-crud.js — CRUD studio de scènes (server.js réel)
 * ----------------------------------------------------------------------------
 *  AJOUT (studio de scènes, lot 3/6) : verrouille les handlers WS
 *  addScene/updateScene/deleteScene/setDefaultScene/getSceneLibrary
 *  ajoutés à server.js — aucun branchement dashboard/overlay.html pour
 *  l'instant (lots 4-6, voir le plan approuvé), ces messages sont donc
 *  construits à la main ici, exactement comme le ferait un futur panneau
 *  dashboard/features/scene-studio.js.
 *
 *  Couvre aussi l'ARBITRAGE CROISÉ poster principal (lot 2) DE BOUT EN BOUT
 *  sur le réseau, pas seulement au niveau du store (déjà testé dans
 *  test-scene-store.js) : désigner une scène par défaut doit diffuser À LA
 *  FOIS sceneLibraryUpdated/defaultSceneChanged ET mediaLibraryUpdated/
 *  defaultMediaChanged si un média était déjà le poster principal — sinon un
 *  tableau de bord resterait persuadé qu'un média déjà démarqué côté serveur
 *  est toujours actif.
 *
 *  Même approche que integration-media-poster-on-add.js : server.js tourne
 *  réellement, avec le VRAI scene-store.js et le VRAI media-library.js
 *  (aucun réseau impliqué, juste des index JSON locaux). Seuls l'ASR/le
 *  micro sont mockés. Écrit dans le VRAI dossier userData de la machine —
 *  nettoyage complet en fin de test.
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

process.env.PORT = process.env.PORT || '8772'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)
require('../server.js');
const sceneStore = require('../scene-store');
const mediaLibrary = require('../media-library');

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

  // Préserve l'état réel de la machine : restauré en fin de test.
  const originalDefaultScene = sceneStore.getDefaultScene();
  const originalDefaultMedia = mediaLibrary.getDefaultItem();
  const addedSceneIds = [];
  let addedMediaId = null;

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

  function waitForAction(action, timeoutMs = 1000) {
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
    console.log('\n=== Scénario : getSceneLibrary() renvoie la liste courante ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'getSceneLibrary' }));
    const listMsg = await waitForAction('sceneLibraryUpdated');
    check('sceneLibraryUpdated renvoyé, scenes est un tableau', Array.isArray(listMsg.scenes));

    console.log('\n=== Scénario : addScene() crée une scène et diffuse sceneLibraryUpdated ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addScene',
        name: 'Bienvenue — test',
        elements: [{ type: 'text', text: 'Bienvenue !' }],
      })
    );
    await sleep(300);
    const created = sceneStore.listItems().find((s) => s.name === 'Bienvenue — test');
    if (created) addedSceneIds.push(created.id);
    check('la scène a bien été créée côté store', !!created);
    check(
      'sceneLibraryUpdated diffusé après addScene',
      received.some((m) => m.action === 'sceneLibraryUpdated')
    );

    console.log(
      '\n=== Scénario : addScene()/updateScene() font transiter triggerPhrases (déclenchement vocal) ===\n'
    );
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addScene',
        name: 'Scène vocale — test',
        triggerPhrases: ['montre la scène de bienvenue', 'scène accueil'],
      })
    );
    await sleep(300);
    const voiceScene = sceneStore.listItems().find((s) => s.name === 'Scène vocale — test');
    if (voiceScene) addedSceneIds.push(voiceScene.id);
    check(
      'triggerPhrases enregistrées côté store après addScene',
      !!voiceScene &&
        JSON.stringify(voiceScene.triggerPhrases) ===
          JSON.stringify(['montre la scène de bienvenue', 'scène accueil'])
    );
    const addBroadcast = received.find((m) => m.action === 'sceneLibraryUpdated');
    const addedInBroadcast =
      addBroadcast && addBroadcast.scenes.find((s) => s.id === voiceScene.id);
    check(
      'triggerPhrases exposées dans la diffusion sceneLibraryUpdated (pas seulement côté store)',
      !!addedInBroadcast &&
        JSON.stringify(addedInBroadcast.triggerPhrases) ===
          JSON.stringify(['montre la scène de bienvenue', 'scène accueil'])
    );
    check(
      'la scène est bien déclenchable à la voix via scene-store.js#matchTriggerPhrase',
      sceneStore.matchTriggerPhrase('scène accueil') !== null
    );

    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'updateScene',
        id: voiceScene.id,
        triggerPhrases: ['nouvelle phrase unique'],
      })
    );
    await sleep(300);
    check(
      'triggerPhrases remplacées côté store après updateScene',
      JSON.stringify(sceneStore.getItem(voiceScene.id).triggerPhrases) ===
        JSON.stringify(['nouvelle phrase unique'])
    );
    check(
      "l'ancienne phrase déclencheuse ne matche plus après remplacement",
      sceneStore.matchTriggerPhrase('scène accueil') === null
    );

    console.log('\n=== Scénario : addScene() sans nom renvoie une erreur, pas de crash ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'addScene', elements: [] }));
    await sleep(300);
    check(
      "un message d'erreur est renvoyé pour un nom manquant",
      received.some((m) => m.action === 'error')
    );

    console.log('\n=== Scénario : updateScene() modifie une scène existante ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({ action: 'updateScene', id: created.id, name: 'Bienvenue — renommée' })
    );
    await sleep(300);
    check(
      'le nom a bien été mis à jour côté store',
      sceneStore.getItem(created.id).name === 'Bienvenue — renommée'
    );
    check(
      'sceneLibraryUpdated diffusé après updateScene',
      received.some((m) => m.action === 'sceneLibraryUpdated')
    );

    console.log('\n=== Scénario : updateScene() sur un id inconnu renvoie une erreur ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'updateScene', id: 'id-inexistant', name: 'x' }));
    await sleep(300);
    check(
      "un message d'erreur est renvoyé pour un id inconnu",
      received.some((m) => m.action === 'error')
    );

    console.log(
      '\n=== Scénario : setDefaultScene() marque le poster principal et diffuse les deux stores ===\n'
    );
    // Précondition : un média est déjà le poster principal — vérifie que le
    // marquer démarque aussi le média (arbitrage croisé de bout en bout).
    const mediaSource = require('fs').mkdtempSync(
      require('path').join(require('os').tmpdir(), 'churchoverlay-scene-crud-test-')
    );
    const mediaSourcePath = require('path').join(mediaSource, 'poster.png');
    require('fs').writeFileSync(mediaSourcePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const addedMedia = mediaLibrary.addItem({ sourcePath: mediaSourcePath, label: 'Poster test' });
    addedMediaId = addedMedia.id;
    mediaLibrary.setDefaultItem(addedMedia.id);
    check(
      'précondition : le média est bien le poster principal avant le test',
      mediaLibrary.getDefaultItem() && mediaLibrary.getDefaultItem().id === addedMedia.id
    );

    received.length = 0;
    ws.send(JSON.stringify({ action: 'setDefaultScene', id: created.id }));
    await sleep(300);
    check(
      'la scène est bien devenue le poster principal côté store',
      sceneStore.getDefaultScene() && sceneStore.getDefaultScene().id === created.id
    );
    check(
      'le média précédemment par défaut a bien été démarqué côté store (arbitrage croisé)',
      mediaLibrary.getDefaultItem() === null
    );
    check(
      'sceneLibraryUpdated diffusé',
      received.some((m) => m.action === 'sceneLibraryUpdated')
    );
    const sceneChangedMsg = received.find((m) => m.action === 'defaultSceneChanged');
    check(
      'defaultSceneChanged diffusé avec la scène désormais active',
      !!sceneChangedMsg && sceneChangedMsg.item && sceneChangedMsg.item.id === created.id
    );
    check(
      'mediaLibraryUpdated AUSSI diffusé (arbitrage croisé de bout en bout, pas seulement côté store)',
      received.some((m) => m.action === 'mediaLibraryUpdated')
    );
    const mediaChangedMsg = received.find((m) => m.action === 'defaultMediaChanged');
    check(
      'defaultMediaChanged diffusé avec item=null (le média a bien été démarqué)',
      !!mediaChangedMsg && mediaChangedMsg.item === null,
      JSON.stringify(mediaChangedMsg)
    );

    console.log(
      '\n=== Scénario : setDefaultMediaItem() démarque symétriquement la scène par défaut ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'setDefaultMediaItem', id: addedMedia.id }));
    await sleep(300);
    check(
      'le média redevient le poster principal côté store',
      mediaLibrary.getDefaultItem() && mediaLibrary.getDefaultItem().id === addedMedia.id
    );
    check(
      'la scène précédemment par défaut a bien été démarquée côté store',
      sceneStore.getDefaultScene() === null
    );
    check(
      'sceneLibraryUpdated AUSSI diffusé (symétrique au scénario précédent)',
      received.some((m) => m.action === 'sceneLibraryUpdated')
    );
    const sceneChangedMsg2 = received.find((m) => m.action === 'defaultSceneChanged');
    check(
      'defaultSceneChanged diffusé avec item=null',
      !!sceneChangedMsg2 && sceneChangedMsg2.item === null
    );

    console.log('\n=== Scénario : setDefaultScene() sans id retire le poster principal ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'setDefaultScene', id: created.id }));
    await sleep(200);
    received.length = 0;
    ws.send(JSON.stringify({ action: 'setDefaultScene' }));
    await sleep(300);
    check('aucune scène par défaut restante côté store', sceneStore.getDefaultScene() === null);
    check(
      'defaultSceneChanged diffusé avec item=null',
      received.some((m) => m.action === 'defaultSceneChanged' && m.item === null)
    );

    console.log('\n=== Scénario : deleteScene() supprime une scène ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'deleteScene', id: created.id }));
    await sleep(300);
    check('la scène a bien disparu côté store', sceneStore.getItem(created.id) === null);
    check(
      'sceneLibraryUpdated diffusé après deleteScene',
      received.some((m) => m.action === 'sceneLibraryUpdated')
    );
    addedSceneIds.length = 0; // déjà supprimée, pas la re-supprimer au nettoyage

    console.log('\n=== Scénario : deleteScene() sur un id inconnu renvoie une erreur ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'deleteScene', id: 'id-inexistant' }));
    await sleep(300);
    check(
      "un message d'erreur est renvoyé pour un id inconnu",
      received.some((m) => m.action === 'error')
    );
  } finally {
    // Nettoyage — ne rien laisser derrière sur la machine.
    for (const id of addedSceneIds) {
      try {
        sceneStore.deleteItem(id);
      } catch (_) {}
    }
    if (addedMediaId) {
      try {
        mediaLibrary.deleteItem(addedMediaId);
      } catch (_) {}
    }
    if (originalDefaultScene) {
      try {
        sceneStore.setDefaultScene(originalDefaultScene.id);
      } catch (_) {}
    } else {
      try {
        sceneStore.clearDefaultScene();
      } catch (_) {}
    }
    if (originalDefaultMedia) {
      try {
        mediaLibrary.setDefaultItem(originalDefaultMedia.id);
      } catch (_) {}
    }
    ws.close();
  }

  console.log(`\n=== Résultat CRUD studio de scènes : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
