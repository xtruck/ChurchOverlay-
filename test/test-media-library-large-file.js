/**
 * ============================================================================
 *  test-media-library-large-file.js — addItem() avec un fichier volumineux
 * ----------------------------------------------------------------------------
 *  Le document mission (Partie 2.3) fixe un critère de charge "200 médias /
 *  vidéo 1 Go+" pour le Mur Média — jamais mesuré jusqu'ici faute de vrai
 *  fichier volumineux disponible dans ce bac à sable (voir
 *  test/e2e/media-wall-load.spec.js pour le volet 200-médias/rendu, et
 *  JOURNAL-MISSION.md pour l'historique).
 *
 *  Ce test-ci couvre l'autre moitié du critère : le fichier lui-même. 150 Mo
 *  plutôt que 1 Go pile — media-library.js#addItem() n'a QU'UNE seule
 *  opération touchant le contenu du fichier (fs.copyFileSync(), une copie
 *  OS-level en un appel, jamais de lecture/hash/bufferisation JS du contenu
 *  entier — vérifié en lisant addItem() avant d'écrire ce test) : aucun code
 *  n'y dépend de la taille au-delà d'un simple facteur d'échelle linéaire.
 *  150 Mo suffit donc à prouver qu'aucun chemin de code ne bufferise ou ne
 *  bloque de façon anormale, sans faire durer la suite `npm test` pour un Go
 *  entier qui ne testerait rien de plus.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mediaLibrary = require('../media-library');

console.log('=== Test médiathèque — fichier volumineux ===\n');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-large-file-test-'));
mediaLibrary.setUserDataDir(userDataDir);

const LARGE_FILE_SIZE = 150 * 1024 * 1024; // 150 Mo
const sourcePath = path.join(os.tmpdir(), `churchoverlay-large-source-${Date.now()}.mp4`);

console.log(`[TEST] Écriture d'un fichier source de ${LARGE_FILE_SIZE / 1024 / 1024} Mo...`);
// Buffer.alloc() (memset, pas crypto.randomBytes) : rapide à générer, la
// vitesse de GÉNÉRATION du fichier de test n'est pas ce qui est mesuré ici.
fs.writeFileSync(sourcePath, Buffer.alloc(LARGE_FILE_SIZE, 0x42));
console.log('[TEST] ✓ Fichier source prêt\n');

try {
  console.log('[TEST] addItem() sur ce fichier volumineux...');
  const start = Date.now();
  const item = mediaLibrary.addItem({
    sourcePath,
    label: 'Vidéo volumineuse — test',
  });
  const elapsedMs = Date.now() - start;
  console.log(`[TEST] ✓ addItem() terminé en ${elapsedMs}ms\n`);

  assert.strictEqual(item.mediaType, 'video', 'extension .mp4 -> mediaType video');
  console.log('[TEST] ✓ mediaType correctement détecté\n');

  // Généreux (10s) pour rester fiable sur une machine CI partagée/lente —
  // une copie disque-à-disque de 150 Mo prend normalement l'ordre de la
  // centaine de ms sur un SSD, largement sous ce plafond.
  assert.ok(
    elapsedMs < 10000,
    `addItem() a pris ${elapsedMs}ms pour 150 Mo — anormalement lent, possible régression`
  );
  console.log('[TEST] ✓ Copie terminée dans un temps raisonnable (<10s)\n');

  const copiedPath = path.join(userDataDir, 'media', item.filename);
  const copiedStat = fs.statSync(copiedPath);
  assert.strictEqual(
    copiedStat.size,
    LARGE_FILE_SIZE,
    'le fichier copié doit avoir EXACTEMENT la même taille que la source — copie intègre'
  );
  console.log('[TEST] ✓ Fichier copié intact (taille identique à la source)\n');

  const listed = mediaLibrary.listItems().find((m) => m.id === item.id);
  assert.ok(listed, "l'élément existe dans listItems()");
  assert.strictEqual(
    listed.fileMissing,
    false,
    'fileMissing=false — le gros fichier est bien vu sur le disque'
  );
  console.log('[TEST] ✓ listItems() voit le fichier volumineux, fileMissing=false\n');

  mediaLibrary.deleteItem(item.id);
  assert.ok(!fs.existsSync(copiedPath), 'deleteItem() a bien supprimé le gros fichier du disque');
  console.log('[TEST] ✓ deleteItem() nettoie correctement un gros fichier\n');
} finally {
  try {
    fs.unlinkSync(sourcePath);
  } catch (_) {}
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (_) {}
}

console.log('=== Résultat médiathèque (fichier volumineux) : OK ===');
