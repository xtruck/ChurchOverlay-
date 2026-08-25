/**
 * ============================================================================
 *  integration-service-export.js — export du service de bout en bout (server.js réel)
 * ----------------------------------------------------------------------------
 *  AJOUT (Partie 7.1.2, export uniquement — voir service-export.js) :
 *  verrouille le handler WS exportService ajouté à server.js. Un vrai média
 *  est ajouté via addMediaItem (VRAI pipeline, mediaLibrary.js copie
 *  réellement le fichier dans ~/.churchoverlay/media — même convention que
 *  integration-scene-crud.js/integration-media-groups.js : écrit dans le
 *  VRAI dossier userData de la machine, nettoyé en fin de test), puis
 *  exportService produit un .zip réel dont le contenu est vérifié.
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

process.env.PORT = process.env.PORT || '8793'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const mediaLibrary = require('../media-library');

const WebSocket = require('ws');
const { readZipEntries } = require('../pptx-importer');

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

  let addedMediaId = null;
  let tmpSourcePath = null;
  let zipOutPath = null;

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
      const poll = () => {
        const found = received.find((m) => m.action === action);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${action}`));
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  try {
    console.log('\n=== Préparation : un vrai média, via addMediaItem (VRAI pipeline) ===\n');
    tmpSourcePath = path.join(os.tmpdir(), `churchoverlay-export-test-${Date.now()}.jpg`);
    fs.writeFileSync(tmpSourcePath, 'contenu-image-de-test');

    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath: tmpSourcePath,
        label: `Export test ${Date.now()}`,
      })
    );
    await sleep(300);
    const added = mediaLibrary
      .listItems()
      .find((m) => m.label && m.label.startsWith('Export test'));
    addedMediaId = added ? added.id : null;
    check('le média existe bien dans le vrai index', !!added);

    console.log('\n=== exportService produit un vrai .zip avec ce média dedans ===\n');
    zipOutPath = path.join(os.tmpdir(), `churchoverlay-export-out-${Date.now()}.zip`);
    received.length = 0;
    ws.send(JSON.stringify({ action: 'exportService', destPath: zipOutPath }));
    const result = await waitForAction('serviceExportResult');
    check('mediaCount >= 1', result.mediaCount >= 1, JSON.stringify(result));
    check('le fichier .zip existe réellement sur disque', fs.existsSync(zipOutPath));

    const entries = readZipEntries(fs.readFileSync(zipOutPath));
    const manifest = entries.has('manifest.json')
      ? JSON.parse(entries.get('manifest.json').toString('utf8'))
      : null;
    check(
      'manifest.json présent et contient bien notre média',
      !!manifest && manifest.media.some((m) => m.id === addedMediaId)
    );
    check(
      'le fichier binaire du média est bien dans le .zip (media/<filename>)',
      !!manifest &&
        entries.has(`media/${manifest.media.find((m) => m.id === addedMediaId).filename}`)
    );

    console.log('\n=== Un destPath dans un dossier inexistant renvoie une erreur propre ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'exportService',
        destPath: path.join(os.tmpdir(), 'dossier-inexistant-xyz', 'out.zip'),
      })
    );
    const errMsg = await waitForAction('error');
    check('un message error est renvoyé, pas un crash', !!errMsg.error);
  } finally {
    if (addedMediaId) {
      try {
        mediaLibrary.deleteItem(addedMediaId);
      } catch (_) {}
    }
    if (tmpSourcePath) {
      try {
        fs.unlinkSync(tmpSourcePath);
      } catch (_) {}
    }
    if (zipOutPath) {
      try {
        fs.unlinkSync(zipOutPath);
      } catch (_) {}
    }
    ws.close();
  }

  console.log(`\n=== Résultat export du service : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
