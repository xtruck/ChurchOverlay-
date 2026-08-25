/**
 * ============================================================================
 *  test-service-export.js — Tests pour service-export.js
 * ----------------------------------------------------------------------------
 *  Deux niveaux de vérification pour le lecteur ZIP produit :
 *   1. Relu par NOTRE PROPRE lecteur (pptx-importer.js#readZipEntries, déjà
 *      testé séparément) — cohérence interne.
 *   2. Relu par `unzip` et `python3 -m zipfile`/`zipfile` RÉELS, deux
 *      implémentations totalement indépendantes de la nôtre — seule façon de
 *      vérifier que le fichier produit est un VRAI .zip standard, pas
 *      seulement auto-cohérent avec notre propre lecteur.
 *  Aucun état laissé sur la machine (dossier temporaire nettoyé en fin de
 *  fichier).
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { writeZip, buildExportPlan, exportService } = require('../service-export');
const { readZipEntries } = require('../pptx-importer');

function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-export-test-'));

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}

(async () => {
  try {
    // --- writeZip() bas niveau, relu par notre propre lecteur -------------
    const zipPath1 = path.join(tmpDir, 'basic.zip');
    const bigContent = crypto.randomBytes(2 * 1024 * 1024); // 2 Mo — assez pour traverser plusieurs morceaux en streaming, jamais chargé "d'un coup" par writeZip
    const bigFilePath = path.join(tmpDir, 'big.bin');
    fs.writeFileSync(bigFilePath, bigContent);

    await writeZip(zipPath1, [
      { name: 'hello.txt', content: 'Bonjour le monde' },
      { name: 'sub/big.bin', filePath: bigFilePath },
    ]);

    await checkAsync(
      'relu par notre propre lecteur ZIP : les 2 entrées sont présentes',
      async () => {
        const buf = fs.readFileSync(zipPath1);
        const entries = readZipEntries(buf);
        assert.strictEqual(entries.get('hello.txt').toString('utf8'), 'Bonjour le monde');
        assert.ok(
          Buffer.compare(entries.get('sub/big.bin'), bigContent) === 0,
          'contenu binaire identique octet pour octet'
        );
      }
    );

    let unzipAvailable = true;
    try {
      execFileSync('unzip', ['-v']);
    } catch (_) {
      unzipAvailable = false;
    }

    if (unzipAvailable) {
      await checkAsync(
        "relu par 'unzip' (implémentation indépendante) : liste correcte",
        async () => {
          const listing = execFileSync('unzip', ['-l', zipPath1]).toString('utf8');
          assert.ok(listing.includes('hello.txt'));
          assert.ok(listing.includes('sub/big.bin'));
        }
      );

      await checkAsync("extrait par 'unzip' : contenu binaire intact (2 Mo)", async () => {
        const extractDir = path.join(tmpDir, 'unzip-extract');
        fs.mkdirSync(extractDir);
        execFileSync('unzip', ['-q', zipPath1, '-d', extractDir]);
        const extracted = fs.readFileSync(path.join(extractDir, 'sub', 'big.bin'));
        assert.ok(Buffer.compare(extracted, bigContent) === 0);
      });
    } else {
      console.log('⚠ unzip indisponible sur cette machine — vérification croisée sautée');
    }

    let pythonAvailable = true;
    try {
      execFileSync('python3', ['-c', 'import zipfile']);
    } catch (_) {
      pythonAvailable = false;
    }

    if (pythonAvailable) {
      await checkAsync(
        "relu par 'python3 zipfile' (implémentation indépendante) : testzip() OK",
        async () => {
          const script = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
assert bad is None, f"CRC invalide pour {bad}"
assert z.read('hello.txt') == b'Bonjour le monde'
print('OK')
`;
          const scriptPath = path.join(tmpDir, 'verify.py');
          fs.writeFileSync(scriptPath, script);
          const out = execFileSync('python3', [scriptPath, zipPath1]).toString('utf8');
          assert.ok(out.includes('OK'));
        }
      );
    } else {
      console.log('⚠ python3/zipfile indisponible — vérification croisée sautée');
    }

    // --- buildExportPlan()/exportService() : vrais stores factices ---------
    const userDataDir = path.join(tmpDir, 'userdata');
    const mediaDir = path.join(userDataDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'photo-jeunesse.jpg'), 'fake-jpeg-bytes');

    const fakeStores = {
      rundownStore: { listCues: () => [{ id: 'c1', type: 'verse', label: 'Ouverture' }] },
      sceneStore: { listItems: () => [{ id: 's1', name: 'Bienvenue' }] },
      mediaLibrary: {
        listItems: () => [
          { id: 'm1', label: 'Photo jeunesse', filename: 'photo-jeunesse.jpg' },
          { id: 'm2', label: 'Vidéo disparue', filename: 'video-manquante.mp4' }, // fichier absent du disque exprès
        ],
      },
      songLibrary: {
        listSongs: () => [{ id: 'song1', title: 'Grand est le Seigneur', sectionCount: 1 }],
        getSong: (id) =>
          id === 'song1'
            ? {
                id: 'song1',
                title: 'Grand est le Seigneur',
                sections: [{ type: 'verse', label: 'Couplet 1', text: 'Grand est le Seigneur' }],
              }
            : null,
      },
    };

    check(
      'buildExportPlan : le média présent est inclus, le média absent est signalé sans faire échouer le plan',
      () => {
        const { manifest, entries } = buildExportPlan(fakeStores, userDataDir);
        assert.strictEqual(manifest.media.length, 1);
        assert.strictEqual(manifest.media[0].id, 'm1');
        assert.strictEqual(manifest.skippedMedia.length, 1);
        assert.strictEqual(manifest.skippedMedia[0].id, 'm2');
        assert.ok(entries.some((e) => e.name === 'media/photo-jeunesse.jpg'));
        assert.ok(!entries.some((e) => e.name.includes('video-manquante')));
        assert.ok(entries.some((e) => e.name === 'manifest.json'));
      }
    );

    check(
      'buildExportPlan : les chants exportés contiennent les VRAIES paroles, pas juste les métadonnées',
      () => {
        // CORRECTIF : listSongs() seul ne renvoie que sectionCount (pas le
        // texte) — buildExportPlan doit passer par getSong(id) pour chaque
        // chant, sinon un chant exporté serait impossible à reconstruire.
        const { manifest } = buildExportPlan(fakeStores, userDataDir);
        assert.strictEqual(manifest.songs.length, 1);
        assert.ok(Array.isArray(manifest.songs[0].sections));
        assert.strictEqual(manifest.songs[0].sections[0].text, 'Grand est le Seigneur');
      }
    );

    await checkAsync(
      'exportService : produit un vrai .zip avec manifest + média réel dedans',
      async () => {
        const outPath = path.join(tmpDir, 'service-export.zip');
        const summary = await exportService(outPath, fakeStores, userDataDir);
        assert.strictEqual(summary.mediaCount, 1);
        assert.strictEqual(summary.skippedMediaCount, 1);
        assert.strictEqual(summary.rundownCount, 1);
        assert.strictEqual(summary.sceneCount, 1);
        assert.strictEqual(summary.songCount, 1);

        const entries = readZipEntries(fs.readFileSync(outPath));
        const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
        assert.strictEqual(manifest.media[0].filename, 'photo-jeunesse.jpg');
        assert.strictEqual(
          entries.get('media/photo-jeunesse.jpg').toString('utf8'),
          'fake-jpeg-bytes'
        );
      }
    );
  } finally {
    cleanup();
  }

  console.log('\n=== Résultat service-export ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
})();
