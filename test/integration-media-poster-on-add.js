/**
 * ============================================================================
 *  integration-media-poster-on-add.js — "Poster" au moment de l'ajout média
 * ----------------------------------------------------------------------------
 *  RÉGRESSION COUVERTE (signalé — "le poster ne revient pas après un
 *  verset") : une image ajoutée à la médiathèque SANS durée explicite reçoit
 *  silencieusement DEFAULT_IMAGE_DURATION_MS (15s, voir
 *  media-library.js#addItem) — un opérateur qui uploade un nouveau poster
 *  chaque semaine et clique juste "Afficher" obtenait donc un média qui
 *  disparaissait tout seul après 15 secondes, sans jamais revenir (rien
 *  n'était marqué isDefault, le seul état que maybeShowDefaultMedia()
 *  ramène à l'écran — voir overlay.html). Confirmé par l'opérateur : il
 *  n'utilisait jamais l'étoile ⭐ après l'ajout.
 *
 *  Ce test verrouille le correctif : `addMediaItem` avec `setAsPoster: true`
 *  doit, en UN SEUL message WS, créer l'item ET le marquer poster principal
 *  (isDefault: true, displayDurationMs: null), démarquer l'ancien poster
 *  principal s'il y en avait un, et diffuser à la fois `mediaLibraryUpdated`
 *  et `defaultMediaChanged` — exactement ce qu'exigeait avant un second
 *  message `setDefaultMediaItem` séparé (facile à oublier).
 *
 *  server.js tourne réellement, avec le VRAI media-library.js (comme
 *  test-media-library.js — aucun réseau impliqué, juste un index JSON local
 *  et une copie de fichier). Seuls l'ASR/le micro sont mockés (non pertinents
 *  ici). Écrit dans le VRAI dossier userData de la machine (même convention
 *  que integration-session-stats.js) — nettoyage complet en fin de test pour
 *  ne rien laisser derrière (items ajoutés supprimés, ancien poster restauré
 *  s'il y en avait un).
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

process.env.PORT = process.env.PORT || '8769'; // distinct des autres tests
require('../server.js');
const mediaLibrary = require('../media-library');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSourceFile(filename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-poster-add-test-'));
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

  // Préserve l'état réel de la machine : restauré en fin de test.
  const originalDefault = mediaLibrary.getDefaultItem();
  const addedIds = [];

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

  try {
    console.log(
      "\n=== Scénario : ajout d'un média avec setAsPoster=true (correctif poster principal) ===\n"
    );

    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath: makeSourceFile('poster-semaine-1.png'),
        label: 'Poster Semaine 1',
        setAsPoster: true,
      })
    );
    await sleep(400);

    const posterItem = mediaLibrary.listItems().find((i) => i.label === 'Poster Semaine 1');
    if (posterItem) addedIds.push(posterItem.id);

    check("l'item a bien été créé", !!posterItem, JSON.stringify(mediaLibrary.listItems()));
    check(
      "setAsPoster=true marque l'item isDefault=true en un seul message WS (pas besoin d'un second setDefaultMediaItem)",
      !!posterItem && posterItem.isDefault === true
    );
    check(
      'la durée est forcée à null (jamais de minuterie auto pour un poster — sinon il disparaîtrait puis reviendrait en boucle)',
      !!posterItem && posterItem.displayDurationMs === null
    );
    check(
      'mediaLibraryUpdated a bien été diffusé',
      received.some((m) => m.action === 'mediaLibraryUpdated')
    );
    const defaultChangedMsg = received.find((m) => m.action === 'defaultMediaChanged');
    check(
      "defaultMediaChanged a bien été diffusé, avec le nouvel item (l'overlay.html doit savoir IMMÉDIATEMENT qu'un poster est actif)",
      !!defaultChangedMsg && defaultChangedMsg.item && defaultChangedMsg.item.id === posterItem.id,
      JSON.stringify(defaultChangedMsg)
    );

    console.log(
      '\n=== Scénario : un second poster ajouté remplace le premier (un seul poster à la fois) ===\n'
    );

    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath: makeSourceFile('poster-semaine-2.png'),
        label: 'Poster Semaine 2',
        setAsPoster: true,
      })
    );
    await sleep(400);

    const poster2Item = mediaLibrary.listItems().find((i) => i.label === 'Poster Semaine 2');
    if (poster2Item) addedIds.push(poster2Item.id);
    const poster1Refetched = mediaLibrary.getItem(posterItem.id);

    check('le second item a bien été créé', !!poster2Item);
    check(
      'le second poster est bien isDefault=true',
      !!poster2Item && poster2Item.isDefault === true
    );
    check(
      "l'ancien poster (semaine 1) est bien démarqué automatiquement (un seul poster principal à la fois)",
      !!poster1Refetched && poster1Refetched.isDefault === false
    );

    console.log(
      '\n=== Scénario témoin : ajout SANS setAsPoster garde le comportement historique (durée par défaut, PAS de poster) ===\n'
    );

    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath: makeSourceFile('annonce-ponctuelle.png'),
        label: 'Annonce ponctuelle',
      })
    );
    await sleep(400);

    const oneShotItem = mediaLibrary.listItems().find((i) => i.label === 'Annonce ponctuelle');
    if (oneShotItem) addedIds.push(oneShotItem.id);

    check(
      'un ajout normal (sans setAsPoster) reste un média ponctuel, PAS un poster',
      !!oneShotItem && oneShotItem.isDefault === false
    );
    check(
      "la durée par défaut silencieuse (15s pour une image) s'applique toujours quand aucune n'est précisée — comportement historique inchangé",
      !!oneShotItem && oneShotItem.displayDurationMs === mediaLibrary.DEFAULT_IMAGE_DURATION_MS
    );
    check(
      'aucun defaultMediaChanged diffusé pour un ajout ordinaire (le poster de semaine 2 reste actif)',
      !received.some((m) => m.action === 'defaultMediaChanged')
    );
  } finally {
    // Nettoyage — ne rien laisser derrière sur la machine.
    for (const id of addedIds) {
      try {
        mediaLibrary.deleteItem(id);
      } catch (_) {}
    }
    if (originalDefault) {
      try {
        mediaLibrary.setDefaultItem(originalDefault.id);
      } catch (_) {}
    }
    ws.close();
  }

  console.log(
    `\n=== Résultat poster-au-moment-de-l'ajout : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
