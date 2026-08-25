/**
 * ============================================================================
 *  integration-service-import.js — export PUIS import de bout en bout (server.js réel)
 * ----------------------------------------------------------------------------
 *  AJOUT (Partie 7.1.2, IMPORT) : verrouille le handler WS importService
 *  ajouté à server.js. Round-trip complet contre le VRAI serveur : un média
 *  + une scène qui le référence + un chant + un repère de feuille de route
 *  sont créés via les VRAIES actions WS, exportés en un vrai .zip
 *  (exportService), puis ce .zip est réimporté (importService) — vérifie que
 *  le résultat réimporté existe bien, avec un NOUVEL id différent de
 *  l'original (la scène réimportée doit pointer vers le nouveau média
 *  réimporté, pas l'original ni un id fantôme).
 * ============================================================================
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
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

process.env.PORT = process.env.PORT || '8794'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const mediaLibrary = require('../media-library');
const sceneStore = require('../scene-store');
const songLibrary = require('../song-library');
const rundownStore = require('../rundown-store');

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

  const mediaBefore = new Set(mediaLibrary.listItems().map((m) => m.id));
  const scenesBefore = new Set(sceneStore.listItems().map((s) => s.id));
  const songsBefore = new Set(songLibrary.listSongs().map((s) => s.id));
  const cuesBefore = new Set(rundownStore.listCues().map((c) => c.id));

  let tmpSourcePath = null;
  let zipPath = null;
  const cleanupMediaIds = [];
  const cleanupSceneIds = [];
  const cleanupSongIds = [];

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

  function waitForActionFrom(fromIndex, action, timeoutMs = 1500) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        const found = received.slice(fromIndex).find((m) => m.action === action);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${action}`));
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  try {
    console.log(
      '\n=== Préparation : média + scène + chant + repère, via les VRAIES actions WS ===\n'
    );
    const uniq = Date.now();
    tmpSourcePath = path.join(os.tmpdir(), `churchoverlay-roundtrip-${uniq}.jpg`);
    fs.writeFileSync(tmpSourcePath, 'contenu-image-roundtrip');

    let base = received.length;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath: tmpSourcePath,
        label: `Roundtrip media ${uniq}`,
      })
    );
    await waitForActionFrom(base, 'mediaLibraryUpdated');
    const originalMedia = mediaLibrary
      .listItems()
      .find((m) => m.label === `Roundtrip media ${uniq}`);
    check('le média original existe', !!originalMedia);
    cleanupMediaIds.push(originalMedia.id);

    base = received.length;
    ws.send(
      JSON.stringify({
        action: 'addScene',
        name: `Roundtrip scene ${uniq}`,
        background: { type: 'media', mediaId: originalMedia.id },
        elements: [{ type: 'image', mediaId: originalMedia.id, position: 'center', widthPct: 20 }],
      })
    );
    await waitForActionFrom(base, 'sceneLibraryUpdated');
    const originalScene = sceneStore.listItems().find((s) => s.name === `Roundtrip scene ${uniq}`);
    check('la scène originale existe et référence le média original', !!originalScene);
    cleanupSceneIds.push(originalScene.id);

    base = received.length;
    ws.send(
      JSON.stringify({
        action: 'addSong',
        title: `Roundtrip song ${uniq}`,
        lyrics: 'Grand est le Seigneur',
      })
    );
    await waitForActionFrom(base, 'songLibraryUpdated');
    const originalSong = songLibrary.listSongs().find((s) => s.title === `Roundtrip song ${uniq}`);
    check('le chant original existe', !!originalSong);
    cleanupSongIds.push(originalSong.id);

    console.log('\n=== exportService puis importService, via le VRAI pipeline ===\n');
    zipPath = path.join(os.tmpdir(), `churchoverlay-roundtrip-out-${uniq}.zip`);
    base = received.length;
    ws.send(JSON.stringify({ action: 'exportService', destPath: zipPath }));
    await waitForActionFrom(base, 'serviceExportResult');
    check('le fichier exporté existe', fs.existsSync(zipPath));

    base = received.length;
    ws.send(JSON.stringify({ action: 'importService', sourcePath: zipPath }));
    const importResult = await waitForActionFrom(base, 'serviceImportResult');
    check('mediaImported >= 1', importResult.mediaImported >= 1, JSON.stringify(importResult));
    check('scenesImported >= 1', importResult.scenesImported >= 1, JSON.stringify(importResult));
    check('songsImported >= 1', importResult.songsImported >= 1, JSON.stringify(importResult));

    const importedMedia = mediaLibrary
      .listItems()
      .find(
        (m) =>
          m.label === `Roundtrip media ${uniq}` &&
          !mediaBefore.has(m.id) &&
          m.id !== originalMedia.id
      );
    check('un DEUXIÈME média (réimporté, id différent) existe', !!importedMedia);
    if (importedMedia) cleanupMediaIds.push(importedMedia.id);

    const importedScene = sceneStore
      .listItems()
      .find(
        (s) =>
          s.name === `Roundtrip scene ${uniq}` &&
          !scenesBefore.has(s.id) &&
          s.id !== originalScene.id
      );
    check('une DEUXIÈME scène (réimportée) existe', !!importedScene);
    check(
      "la scène réimportée référence le média RÉIMPORTÉ, pas l'original",
      !!importedScene && !!importedMedia && importedScene.background.mediaId === importedMedia.id
    );
    if (importedScene) cleanupSceneIds.push(importedScene.id);

    const importedSong = songLibrary
      .listSongs()
      .find((s) => s.title === `Roundtrip song ${uniq}` && !songsBefore.has(s.id));
    check('un DEUXIÈME chant (réimporté) existe', !!importedSong);
    if (importedSong) cleanupSongIds.push(importedSong.id);

    console.log('\n=== Un sourcePath invalide renvoie une erreur propre, pas un crash ===\n');
    base = received.length;
    ws.send(
      JSON.stringify({
        action: 'importService',
        sourcePath: path.join(os.tmpdir(), 'fichier-inexistant-xyz.zip'),
      })
    );
    const errMsg = await waitForActionFrom(base, 'error');
    check('un message error est renvoyé', !!errMsg.error);
  } finally {
    for (const id of cleanupMediaIds) {
      try {
        mediaLibrary.deleteItem(id);
      } catch (_) {}
    }
    for (const id of cleanupSceneIds) {
      try {
        sceneStore.deleteItem(id);
      } catch (_) {}
    }
    for (const id of cleanupSongIds) {
      try {
        songLibrary.deleteSong(id);
      } catch (_) {}
    }
    for (const cue of rundownStore.listCues()) {
      if (!cuesBefore.has(cue.id)) {
        try {
          rundownStore.removeCue(cue.id);
        } catch (_) {}
      }
    }
    if (tmpSourcePath) {
      try {
        fs.unlinkSync(tmpSourcePath);
      } catch (_) {}
    }
    if (zipPath) {
      try {
        fs.unlinkSync(zipPath);
      } catch (_) {}
    }
    ws.close();
  }

  console.log(`\n=== Résultat export+import du service : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
