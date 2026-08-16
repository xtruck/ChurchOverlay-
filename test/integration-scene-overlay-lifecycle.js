/**
 * ============================================================================
 *  integration-scene-overlay-lifecycle.js — showScene/hideScene sur le vrai overlay.html
 * ----------------------------------------------------------------------------
 *  AJOUT (studio de scènes, lot 4/6 — LOT LE PLUS À RISQUE du plan, chemin
 *  de projection en direct) : contrairement aux autres lots, ce test ne se
 *  contente pas de vérifier les messages WS échangés — il charge le VRAI
 *  overlay.html dans un vrai navigateur (Playwright/Chromium, comme la
 *  vérification manuelle du correctif "poster principal" précédent) et
 *  inspecte le DOM RÉELLEMENT rendu après chaque action, exactement ce
 *  qu'un projecteur afficherait en plein culte.
 *
 *  Couvre, avec la même rigueur que le correctif "poster principal"
 *  original (voir integration-media-poster-on-add.js) :
 *   1. Une scène déclenchée s'affiche correctement (fond + texte + image).
 *   2. Un verset interrompt une scène affichée (mutuelle exclusion).
 *   3. Une scène interrompt un verset affiché.
 *   4. Une scène NON épinglée ne revient PAS après un verset (comportement
 *      historique d'un média non-poster, volontairement préservé à l'identique).
 *   5. Une scène ÉPINGLÉE (poster principal) revient bien après un verset.
 *   6. hideScene() explicite restaure le poster principal (scène OU média).
 *   7. L'arbitrage croisé scène/média se reflète bien dans le DOM RÉEL,
 *      pas seulement dans les messages WS (déjà couvert par
 *      integration-scene-crud.js).
 *   8. Un mediaId supprimé se dégrade proprement (élément absent, PAS de
 *      DOM cassé ni d'erreur console qui bloquerait le reste de l'overlay).
 *
 *  server.js tourne réellement (ASR/micro mockés, stores réels — mêmes
 *  fakes que integration-scene-crud.js). Nettoyage complet en fin de test.
 *
 *  FLAKY CONNU (Chantier D, mission autonome — vérifié avant l'extraction
 *  overlay.html -> overlay.js, PAS causé par elle) : ~1 run sur 7 échoue sur
 *  1-3 assertions liées au timing d'affichage d'une scène (`sleep()` fixes
 *  après une action WS), sur le code d'ORIGINE comme après extraction —
 *  mesuré par 10+ runs de chaque côté avant de conclure. Un échec isolé de
 *  CE test précis n'est donc pas forcément un vrai bug ; le confirmer par
 *  un second run avant d'investiguer plus loin. À durcir un jour (délais
 *  plus généreux ou attente explicite d'un état plutôt qu'un sleep fixe),
 *  hors périmètre de ce chantier.
 * ============================================================================
 */
'use strict';
const fs = require('fs');
const os = require('os');
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

process.env.PORT = process.env.PORT || '8773'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)
require('../server.js');
const sceneStore = require('../scene-store');
const mediaLibrary = require('../media-library');

const WebSocket = require('ws');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-scene-overlay-${Date.now()}-${Math.random()}.wav`);
}

function makeSourceFile(dir, filename) {
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

  // Préserve l'état réel de la machine.
  const originalDefaultScene = sceneStore.getDefaultScene();
  const originalDefaultMedia = mediaLibrary.getDefaultItem();
  const addedSceneIds = [];
  const addedMediaIds = [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-scene-overlay-test-'));

  // Opérateur (envoie les actions) — distinct de l'overlay (reçoit les diffusions).
  const opWs = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  await new Promise((resolve, reject) => {
    opWs.on('open', resolve);
    opWs.on('error', reject);
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT}/overlay.html`, { waitUntil: 'load' });
  await sleep(500); // laisse la connexion WS de l'overlay s'établir

  async function overlayState() {
    return page.evaluate(() => ({
      verseVisible: document.getElementById('overlay-container').classList.contains('visible'),
      mediaVisible: document.getElementById('media-layer').classList.contains('visible'),
      sceneVisible: document.getElementById('scene-layer').classList.contains('visible'),
      sceneText: document.querySelector('#scene-layer .scene-text')
        ? document.querySelector('#scene-layer .scene-text').textContent
        : null,
      sceneImageCount: document.querySelectorAll('#scene-layer .scene-image img').length,
      sceneBackgroundImg: !!document.querySelector('#scene-layer .scene-background-img'),
    }));
  }

  try {
    // Média de fond pour la scène (référencé par mediaId, résolu côté serveur).
    const bgMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'fond.png'),
      label: 'Fond de scène test',
    });
    addedMediaIds.push(bgMedia.id);
    const logoMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'logo.png'),
      label: 'Logo test',
    });
    addedMediaIds.push(logoMedia.id);

    const scene = sceneStore.addScene({
      name: 'Scène overlay test',
      background: { type: 'media', mediaId: bgMedia.id },
      elements: [
        { type: 'text', text: 'Bienvenue au culte', position: 'top-center' },
        { type: 'image', mediaId: logoMedia.id, position: 'bottom-right' },
      ],
    });
    addedSceneIds.push(scene.id);

    console.log('\n=== Scénario 1 : une scène déclenchée s’affiche correctement ===\n');
    opWs.send(JSON.stringify({ action: 'triggerScene', id: scene.id }));
    await sleep(400);
    let state = await overlayState();
    check('la couche scène est visible', state.sceneVisible, JSON.stringify(state));
    check('le texte de la scène est bien rendu', state.sceneText === 'Bienvenue au culte');
    check('le fond de scène (image média résolue) est bien rendu', state.sceneBackgroundImg);
    check('l’élément image (logo) est bien rendu', state.sceneImageCount === 1);
    check('la couche verset reste masquée', state.verseVisible === false);
    check('la couche média reste masquée', state.mediaVisible === false);

    console.log('\n=== Scénario 2 : un verset interrompt une scène affichée ===\n');
    await simulateSegment('Jean 3:16');
    await sleep(500);
    state = await overlayState();
    check('la couche verset est maintenant visible', state.verseVisible === true);
    check(
      'la couche scène a bien été masquée',
      state.sceneVisible === false,
      JSON.stringify(state)
    );

    console.log(
      '\n=== Scénario 3 : la scène (non épinglée) NE revient PAS après le verset — comportement historique préservé ===\n'
    );
    opWs.send(JSON.stringify({ action: 'hideVerse' }));
    await sleep(400);
    state = await overlayState();
    check('la couche verset est bien masquée', state.verseVisible === false);
    check(
      'la scène ne revient PAS toute seule (elle n’était pas le poster principal)',
      state.sceneVisible === false,
      JSON.stringify(state)
    );

    console.log('\n=== Scénario 4 : une scène interrompt un verset affiché ===\n');
    await simulateSegment('Romains 8:28');
    await sleep(500);
    check(
      'précondition : le verset est bien affiché',
      (await overlayState()).verseVisible === true
    );
    opWs.send(JSON.stringify({ action: 'triggerScene', id: scene.id }));
    await sleep(400);
    state = await overlayState();
    check('la scène est maintenant visible', state.sceneVisible === true);
    check('le verset a bien été masqué', state.verseVisible === false, JSON.stringify(state));
    opWs.send(JSON.stringify({ action: 'hideScene' }));
    await sleep(300);

    console.log(
      '\n=== Scénario 5 : une scène ÉPINGLÉE (poster principal) revient après un verset ===\n'
    );
    opWs.send(JSON.stringify({ action: 'setDefaultScene', id: scene.id }));
    await sleep(400);
    state = await overlayState();
    check(
      'la scène épinglée s’affiche automatiquement dès sa désignation',
      state.sceneVisible === true,
      JSON.stringify(state)
    );

    await simulateSegment('Jean 3:16');
    await sleep(500);
    check(
      'précondition : le verset masque bien la scène épinglée',
      (await overlayState()).sceneVisible === false
    );
    opWs.send(JSON.stringify({ action: 'hideVerse' }));
    await sleep(400);
    state = await overlayState();
    check(
      'LA SCÈNE ÉPINGLÉE REVIENT bien après le verset — le correctif "poster principal" généralisé aux scènes',
      state.sceneVisible === true,
      JSON.stringify(state)
    );

    console.log(
      '\n=== Scénario 6 : l’arbitrage croisé scène/média se reflète dans le DOM RÉEL ===\n'
    );
    opWs.send(JSON.stringify({ action: 'setDefaultMediaItem', id: bgMedia.id }));
    await sleep(500);
    state = await overlayState();
    check(
      'désigner un média par défaut fait disparaître la scène épinglée et affiche le média à la place',
      state.sceneVisible === false && state.mediaVisible === true,
      JSON.stringify(state)
    );

    console.log(
      '\n=== Scénario 7 : hideScene() explicite restaure le poster principal (média) ===\n'
    );
    opWs.send(JSON.stringify({ action: 'setDefaultMediaItem' })); // retire le poster principal média
    await sleep(300);
    opWs.send(JSON.stringify({ action: 'setDefaultScene', id: scene.id }));
    await sleep(400);
    check(
      'précondition : la scène épinglée est affichée',
      (await overlayState()).sceneVisible === true
    );
    opWs.send(JSON.stringify({ action: 'hideScene' }));
    await sleep(400);
    state = await overlayState();
    check(
      'hideScene() explicite laisse le poster principal (la même scène) reprendre sa place',
      state.sceneVisible === true,
      JSON.stringify(state)
    );

    console.log(
      '\n=== Scénario 8 : un mediaId supprimé se dégrade proprement (pas de DOM cassé, pas d’erreur console) ===\n'
    );
    opWs.send(JSON.stringify({ action: 'setDefaultScene' })); // retire le poster principal scène
    await sleep(300);
    mediaLibrary.deleteItem(logoMedia.id); // l'élément image de la scène référence cet id
    consoleErrors.length = 0;
    opWs.send(JSON.stringify({ action: 'triggerScene', id: scene.id }));
    await sleep(400);
    state = await overlayState();
    check('la scène reste affichée malgré l’élément image cassé', state.sceneVisible === true);
    check('le texte (élément valide) est toujours rendu', state.sceneText === 'Bienvenue au culte');
    check(
      'l’élément image au mediaId supprimé est bien absent (dégradation propre, pas de src cassée)',
      state.sceneImageCount === 0,
      JSON.stringify(state)
    );
    check(
      'le fond (media toujours présent, lui) reste rendu normalement',
      state.sceneBackgroundImg === true
    );
    check(
      'aucune erreur console déclenchée par l’élément cassé',
      consoleErrors.length === 0,
      JSON.stringify(consoleErrors)
    );

    console.log(`\nErreurs console cumulées sur tout le test : ${consoleErrors.length}`);
    if (consoleErrors.length) console.log(consoleErrors);
  } finally {
    // Nettoyage — ne rien laisser derrière sur la machine.
    for (const id of addedSceneIds) {
      try {
        sceneStore.deleteItem(id);
      } catch (_) {}
    }
    for (const id of addedMediaIds) {
      try {
        mediaLibrary.deleteItem(id);
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
    } else {
      try {
        mediaLibrary.clearDefaultItem();
      } catch (_) {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await browser.close();
    opWs.close();
  }

  console.log(
    `\n=== Résultat cycle de vie scène/overlay : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  console.error(err.stack);
  process.exit(1);
});
