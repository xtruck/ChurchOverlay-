/**
 * ============================================================================
 *  integration-pptx-import.js — import PowerPoint de bout en bout (server.js réel)
 * ----------------------------------------------------------------------------
 *  AJOUT (Partie 7.1.1) : verrouille le handler WS importPptxSlides ajouté à
 *  server.js — un vrai .pptx minimal (voir buildZip ci-dessous, même
 *  écrivain que test/test-pptx-importer.js, qui couvre déjà en détail
 *  l'extraction pure) est écrit sur disque, importé via le VRAI pipeline
 *  (main.js#pick-pptx-file n'est pas dans le worker, donc simulé ici par un
 *  sourcePath direct — exactement ce que fait aussi
 *  integration-media-poster-on-add.js pour addMediaItem), et les scènes
 *  RÉELLEMENT créées dans scene-store.js sont vérifiées (contenu ET ordre).
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

process.env.PORT = process.env.PORT || '8792'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const sceneStore = require('../scene-store');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Mini-écrivain ZIP (STORED) — même approche que test-pptx-importer.js ---
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }
  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralChunks);
  offset += centralDir.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function slideXml(...texts) {
  const paragraphs = texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('');
  return `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${paragraphs}</p:spTree></p:cSld></p:sld>`;
}

const PRESENTATION_XML = (rIds) =>
  `<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${rIds
    .map((id) => `<p:sldId id="256" r:id="${id}"/>`)
    .join('')}</p:sldIdLst></p:presentation>`;

const RELS_XML = (pairs) =>
  `<?xml version="1.0"?><Relationships xmlns="rels">${pairs
    .map(([id, target]) => `<Relationship Id="${id}" Type="slide" Target="${target}"/>`)
    .join('')}</Relationships>`;

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

  const scenesBefore = sceneStore.listItems().map((s) => s.id);
  let tmpPptxPath = null;

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
    console.log(
      "\n=== Import d'un .pptx réel (3 diapositives, une vide) via le VRAI pipeline WS ===\n"
    );
    const zip = buildZip([
      ['ppt/presentation.xml', PRESENTATION_XML(['rId1', 'rId2', 'rId3'])],
      [
        'ppt/_rels/presentation.xml.rels',
        RELS_XML([
          ['rId1', 'slides/slide1.xml'],
          ['rId2', 'slides/slide2.xml'],
          ['rId3', 'slides/slide3.xml'],
        ]),
      ],
      ['ppt/slides/slide1.xml', slideXml('Grand est le Seigneur')],
      ['ppt/slides/slide2.xml', slideXml()], // diapositive sans texte — doit être ignorée
      ['ppt/slides/slide3.xml', slideXml("Digne est l'Agneau", 'Alléluia')],
    ]);
    tmpPptxPath = path.join(os.tmpdir(), `churchoverlay-test-${Date.now()}.pptx`);
    fs.writeFileSync(tmpPptxPath, zip);

    received.length = 0;
    ws.send(JSON.stringify({ action: 'importPptxSlides', sourcePath: tmpPptxPath }));
    const result = await waitForAction('pptxImportResult');
    check('slidesFound = 3', result.slidesFound === 3, JSON.stringify(result));
    check(
      'scenesCreated = 2 (la diapositive vide est ignorée)',
      result.scenesCreated === 2,
      JSON.stringify(result)
    );

    await waitForAction('sceneLibraryUpdated');
    const newScenes = sceneStore.listItems().filter((s) => !scenesBefore.includes(s.id));
    check('2 nouvelles scènes réellement créées côté store', newScenes.length === 2);

    const scene1 = newScenes.find((s) => s.name === 'Diapositive 1');
    const scene3 = newScenes.find((s) => s.name === 'Diapositive 3');
    check(
      'scène "Diapositive 1" créée avec le bon texte',
      !!scene1 && scene1.elements[0].text === 'Grand est le Seigneur'
    );
    check(
      'scène "Diapositive 3" créée avec les 2 paragraphes, dans l\'ordre',
      !!scene3 && scene3.elements[0].text === "Digne est l'Agneau\nAlléluia"
    );
    check(
      'aucune scène "Diapositive 2" (texte vide, ignorée)',
      !newScenes.some((s) => s.name === 'Diapositive 2')
    );

    console.log('\n=== Un sourcePath vers un fichier inexistant renvoie une erreur propre ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'importPptxSlides',
        sourcePath: path.join(os.tmpdir(), 'churchoverlay-fichier-inexistant.pptx'),
      })
    );
    const errMsg = await waitForAction('error');
    check('un message error est renvoyé, pas un crash', !!errMsg.error);

    // Nettoyage des scènes créées par le premier scénario.
    for (const s of newScenes) {
      try {
        sceneStore.deleteItem(s.id);
      } catch (_) {}
    }
  } finally {
    if (tmpPptxPath) {
      try {
        fs.unlinkSync(tmpPptxPath);
      } catch (_) {}
    }
    ws.close();
  }

  console.log(`\n=== Résultat import PowerPoint : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
