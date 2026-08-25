/**
 * ============================================================================
 *  test-service-import.js — Tests pour service-import.js
 * ----------------------------------------------------------------------------
 *  Stores RÉELS (media-library.js/scene-store.js/song-library.js/
 *  rundown-store.js) pointés vers un dossier userData temporaire — même
 *  discipline que test-scene-store.js : on veut la VRAIE validation
 *  (extensions, id générés côté serveur, jamais fait confiance à l'appelant)
 *  pour que les preuves de sécurité ci-dessous portent sur le comportement
 *  réel, pas sur des doublures qui court-circuiteraient ces garanties.
 *
 *  Un .zip réaliste (manifest.json + média) est construit en mémoire avec le
 *  même mini-écrivain ZIP que test-pptx-importer.js/test-service-export.js.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mediaLibrary = require('../media-library');
const sceneStore = require('../scene-store');
const songLibrary = require('../song-library');
const rundownStore = require('../rundown-store');
const { importService } = require('../service-import');

function check(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (e) {
      console.error(`❌ ${name}`);
      console.error(e);
      process.exitCode = 1;
    }
  })();
}

// --- Mini-écrivain ZIP (STORED) — mêmes fixtures que les autres tests ZIP ---
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-import-test-'));
mediaLibrary.setUserDataDir(userDataDir);
sceneStore.setUserDataDir(userDataDir);
songLibrary.setUserDataDir(userDataDir);
rundownStore.setUserDataDir(userDataDir);

const stores = { mediaLibrary, sceneStore, songLibrary, rundownStore };

(async () => {
  await check(
    'import de bout en bout : médias/scènes/chants/repères, id remappés partout',
    async () => {
      const manifest = {
        media: [
          {
            id: 'old-media-1',
            label: 'Photo jeunesse',
            filename: 'old-media-1.jpg',
            triggerPhrases: ['photo jeunesse'],
          },
        ],
        scenes: [
          {
            id: 'old-scene-1',
            name: 'Bienvenue',
            background: { type: 'media', mediaId: 'old-media-1' },
            elements: [{ type: 'image', mediaId: 'old-media-1', position: 'center', widthPct: 20 }],
            triggerPhrases: ['bienvenue'],
          },
        ],
        songs: [
          {
            id: 'old-song-1',
            title: 'Grand est le Seigneur',
            sections: [{ type: 'verse', label: 'Couplet 1', text: 'Grand est le Seigneur' }],
          },
        ],
        rundown: [
          { id: 'c1', type: 'verse', label: 'Ouverture', reference: 'Jean 3:16' },
          { id: 'c2', type: 'media', label: 'Photo', mediaId: 'old-media-1' },
          { id: 'c3', type: 'scene', label: 'Scène', sceneId: 'old-scene-1' },
        ],
      };

      const zip = buildZip([
        ['manifest.json', JSON.stringify(manifest)],
        ['media/old-media-1.jpg', 'contenu-jpeg-de-test'],
      ]);
      const zipPath = path.join(userDataDir, 'roundtrip.zip');
      fs.writeFileSync(zipPath, zip);

      const summary = await importService(zipPath, stores);
      assert.strictEqual(summary.mediaImported, 1);
      assert.strictEqual(summary.mediaSkipped, 0);
      assert.strictEqual(summary.scenesImported, 1);
      assert.strictEqual(summary.scenesSkipped, 0);
      assert.strictEqual(summary.songsImported, 1);
      assert.strictEqual(summary.songsSkipped, 0);
      assert.strictEqual(summary.cuesImported, 3);
      assert.strictEqual(summary.cuesSkipped, 0);

      const media = mediaLibrary.listItems().find((m) => m.label === 'Photo jeunesse');
      assert.ok(media, 'le média importé existe');
      assert.notStrictEqual(
        media.id,
        'old-media-1',
        "l'id est régénéré, jamais fait confiance au manifeste"
      );

      const scene = sceneStore.listItems().find((s) => s.name === 'Bienvenue');
      assert.ok(scene);
      assert.strictEqual(
        scene.background.mediaId,
        media.id,
        'la référence média de la scène est remappée vers le NOUVEL id'
      );
      assert.strictEqual(scene.elements[0].mediaId, media.id, "idem pour l'élément image");

      const song = songLibrary.listSongs().find((s) => s.title === 'Grand est le Seigneur');
      assert.ok(song);
      const fullSong = songLibrary.getSong(song.id);
      assert.strictEqual(
        fullSong.sections[0].text,
        'Grand est le Seigneur',
        'les paroles ont bien survécu au round-trip'
      );

      const cues = rundownStore.listCues();
      const mediaCue = cues.find((c) => c.type === 'media' && c.label === 'Photo');
      const sceneCue = cues.find((c) => c.type === 'scene' && c.label === 'Scène');
      assert.strictEqual(
        mediaCue.mediaId,
        media.id,
        'le repère média pointe vers le NOUVEL id média'
      );
      assert.strictEqual(
        sceneCue.sceneId,
        scene.id,
        'le repère scène pointe vers le NOUVEL id scène'
      );
      assert.ok(cues.some((c) => c.type === 'verse' && c.reference === 'Jean 3:16'));

      fs.unlinkSync(zipPath);
    }
  );

  await check(
    'un média absent du zip est sauté (comptabilisé), le reste importe quand même',
    async () => {
      const manifest = {
        media: [{ id: 'ghost', label: 'Fantôme', filename: 'ghost.jpg' }],
        scenes: [],
        songs: [],
        rundown: [],
      };
      const zip = buildZip([['manifest.json', JSON.stringify(manifest)]]); // pas d'entrée media/ghost.jpg
      const zipPath = path.join(userDataDir, 'ghost.zip');
      fs.writeFileSync(zipPath, zip);

      const summary = await importService(zipPath, stores);
      assert.strictEqual(summary.mediaImported, 0);
      assert.strictEqual(summary.mediaSkipped, 1);
      fs.unlinkSync(zipPath);
    }
  );

  await check(
    "un repère de feuille de route dont la cible n'a pas pu être importée est sauté, pas créé cassé",
    async () => {
      const manifest = {
        media: [],
        scenes: [],
        songs: [],
        rundown: [{ id: 'c1', type: 'media', label: 'Cassé', mediaId: 'id-qui-n-existe-plus' }],
      };
      const zip = buildZip([['manifest.json', JSON.stringify(manifest)]]);
      const zipPath = path.join(userDataDir, 'broken-cue.zip');
      fs.writeFileSync(zipPath, zip);

      const cuesBefore = rundownStore.listCues().length;
      const summary = await importService(zipPath, stores);
      assert.strictEqual(summary.cuesImported, 0);
      assert.strictEqual(summary.cuesSkipped, 1);
      assert.strictEqual(rundownStore.listCues().length, cuesBefore, 'aucun repère cassé ajouté');
      fs.unlinkSync(zipPath);
    }
  );

  await check('manifest.json absent -> erreur explicite, pas de crash silencieux', async () => {
    const zip = buildZip([['autre-chose.txt', 'peu importe']]);
    const zipPath = path.join(userDataDir, 'no-manifest.zip');
    fs.writeFileSync(zipPath, zip);
    await assert.rejects(() => importService(zipPath, stores), /manifest\.json/);
    fs.unlinkSync(zipPath);
  });

  await check('manifest.json corrompu -> erreur explicite', async () => {
    const zip = buildZip([['manifest.json', "{ceci n'est pas du JSON valide"]]);
    const zipPath = path.join(userDataDir, 'bad-manifest.zip');
    fs.writeFileSync(zipPath, zip);
    await assert.rejects(() => importService(zipPath, stores), /illisible/);
    fs.unlinkSync(zipPath);
  });

  // --- Preuves adversariales : "zip slip" (CWE-22) ---------------------------
  await check(
    'nom de fichier hostile ("../evil-marker.jpg") : importe normalement, MAIS n\'écrit jamais au chemin naïvement traversé',
    async () => {
      // Un implémenteur naïf ferait `path.join(destDir, item.filename)` pour
      // écrire le fichier extrait -- ce chemin résoudrait hors de destDir.
      // Preuve qu'on ne le fait PAS : après import, aucun fichier n'existe à
      // cet emplacement naïvement calculé, quel que soit destDir choisi.
      const naiveDestDir = path.join(userDataDir, 'media');
      const naiveEscapedPath = path.resolve(naiveDestDir, '../evil-marker.jpg');
      try {
        fs.unlinkSync(naiveEscapedPath);
      } catch (_) {}

      const manifest = {
        media: [{ id: 'm1', label: 'Marqueur hostile', filename: '../evil-marker.jpg' }],
        scenes: [],
        songs: [],
        rundown: [],
      };
      const zip = buildZip([
        ['manifest.json', JSON.stringify(manifest)],
        ['media/../evil-marker.jpg', 'contenu-de-test'],
      ]);
      const zipPath = path.join(userDataDir, 'slip1.zip');
      fs.writeFileSync(zipPath, zip);

      const summary = await importService(zipPath, stores);
      // basename()+extname() neutralise le chemin : ".jpg" reste une
      // extension valide, donc l'item importe normalement (preuve que le
      // danger a été désamorcé, pas juste rejeté en bloc).
      assert.strictEqual(summary.mediaImported, 1);
      assert.ok(
        !fs.existsSync(naiveEscapedPath),
        `RIEN ne doit exister à ${naiveEscapedPath} — une fuite ici prouverait un zip slip réel`
      );

      fs.unlinkSync(zipPath);
    }
  );

  await check(
    'extension dangereuse dissimulée dans un chemin hostile ("../../evil.exe") : sautée par l\'allowlist',
    async () => {
      const manifest = {
        media: [{ id: 'm1', label: 'Exécutable hostile', filename: '../../evil.exe' }],
        scenes: [],
        songs: [],
        rundown: [],
      };
      const zip = buildZip([
        ['manifest.json', JSON.stringify(manifest)],
        ['media/../../evil.exe', 'MZ...contenu-binaire-de-test'],
      ]);
      const zipPath = path.join(userDataDir, 'slip2.zip');
      fs.writeFileSync(zipPath, zip);

      const summary = await importService(zipPath, stores);
      assert.strictEqual(summary.mediaImported, 0);
      assert.strictEqual(summary.mediaSkipped, 1, 'extension .exe hors allowlist -> sauté');

      fs.unlinkSync(zipPath);
    }
  );

  console.log('\n=== Résultat service-import ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
})();
