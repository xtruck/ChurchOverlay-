/**
 * ============================================================================
 *  test-media-library.js — Tests pour media-library.js
 * ----------------------------------------------------------------------------
 *  Tests purs (aucun Electron/IPC/WebSocket) : addItem/listItems/getItem/
 *  deleteItem/matchTriggerPhrase contre un dossier userData temporaire.
 *  Même isolation que test-sentence-buffer.js/test-audio-capture.js.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mediaLibrary = require('../media-library');

console.log('=== Test Media Library ===\n');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-media-test-'));
mediaLibrary.setUserDataDir(userDataDir);

// Fichier source factice (contenu sans importance : jamais décodé, juste copié).
function makeSourceFile(filename) {
  const p = path.join(userDataDir, 'sources', filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  return p;
}

// Test 1 : addItem() copie le fichier et retourne les bonnes métadonnées.
console.log('[TEST] Test 1: addItem() (image)...');
const imgSource = makeSourceFile('poster.png');
const imgItem = mediaLibrary.addItem({
  sourcePath: imgSource,
  label: 'Poster annonces',
  triggerPhrases: ['annonces de la semaine', "  soutenons l'église  "],
});
assert.strictEqual(imgItem.mediaType, 'image', 'un .png doit être classé "image"');
assert.strictEqual(imgItem.label, 'Poster annonces');
assert.deepStrictEqual(
  imgItem.triggerPhrases,
  ['annonces de la semaine', "soutenons l'église"],
  'les phrases déclencheuses doivent être conservées et débarrassées des espaces superflus'
);
assert.strictEqual(
  imgItem.displayDurationMs,
  mediaLibrary.DEFAULT_IMAGE_DURATION_MS,
  'une image sans durée explicite doit recevoir la durée par défaut'
);
assert(
  fs.existsSync(path.join(userDataDir, 'media', imgItem.filename)),
  'le fichier doit avoir été copié dans <userData>/media/'
);
assert.strictEqual(
  imgItem.transitionStyle,
  mediaLibrary.DEFAULT_TRANSITION_STYLE,
  'sans style précisé, le style d’apparition par défaut doit être appliqué'
);
console.log('[TEST] ✓ Image ajoutée et copiée correctement\n');

// Test 2 : addItem() classe correctement une vidéo, sans durée par défaut
// (joue jusqu'à sa fin naturelle plutôt qu'un minuteur arbitraire).
console.log('[TEST] Test 2: addItem() (vidéo)...');
const vidSource = makeSourceFile('intro.mp4');
const vidItem = mediaLibrary.addItem({ sourcePath: vidSource, label: 'Intro culte' });
assert.strictEqual(vidItem.mediaType, 'video', 'un .mp4 doit être classé "video"');
assert.strictEqual(
  vidItem.displayDurationMs,
  null,
  'une vidéo sans durée explicite ne doit pas recevoir de minuteur automatique'
);
console.log('[TEST] ✓ Vidéo ajoutée et classée correctement\n');

// Test 2b : addItem() sans AUCUNE phrase déclencheuse retombe sur le nom —
// évite qu'un média reste silencieusement inatteignable à la voix quand
// l'opérateur ne remplit que le champ "Nom" (voir commentaire dans addItem).
console.log('[TEST] Test 2b: addItem() sans phrase déclencheuse retombe sur le nom...');
const noPhraseSource = makeSourceFile('fallback.png');
const noPhraseItem = mediaLibrary.addItem({ sourcePath: noPhraseSource, label: 'Poster Un' });
assert.deepStrictEqual(
  noPhraseItem.triggerPhrases,
  ['Poster Un'],
  'sans phrase déclencheuse fournie, le nom doit devenir la phrase déclencheuse par défaut'
);
assert(
  mediaLibrary.matchTriggerPhrase('on va montrer poster un maintenant') !== null,
  'dire le nom seul doit suffire à déclencher le média'
);
console.log('[TEST] ✓ Repli sur le nom comme phrase déclencheuse par défaut\n');

// Test 2c : addItem() avec un style d'apparition explicite valide, et repli
// sur le défaut pour une valeur inconnue (jamais une valeur arbitraire non
// reconnue par overlay.html, voir TRANSITION_STYLES).
console.log('[TEST] Test 2c: addItem() — style d’apparition (valide et invalide)...');
const styledSource = makeSourceFile('styled.png');
const styledItem = mediaLibrary.addItem({
  sourcePath: styledSource,
  label: 'Style test',
  transitionStyle: 'zoom',
});
assert.strictEqual(styledItem.transitionStyle, 'zoom');
const badStyleSource = makeSourceFile('badstyle.png');
const badStyleItem = mediaLibrary.addItem({
  sourcePath: badStyleSource,
  label: 'Mauvais style',
  transitionStyle: 'explosion-3d',
});
assert.strictEqual(
  badStyleItem.transitionStyle,
  mediaLibrary.DEFAULT_TRANSITION_STYLE,
  'un style inconnu doit retomber sur le défaut plutôt que d’être stocké tel quel'
);
console.log('[TEST] ✓ Style d’apparition validé correctement\n');

// Test 3 : listItems()/getItem() reflètent les ajouts.
console.log('[TEST] Test 3: listItems() / getItem()...');
const items = mediaLibrary.listItems();
assert.strictEqual(items.length, 5, 'les cinq éléments ajoutés doivent apparaître');
assert.strictEqual(mediaLibrary.getItem(imgItem.id).label, 'Poster annonces');
assert.strictEqual(mediaLibrary.getItem('id-inexistant'), null, 'un id inconnu doit renvoyer null');
console.log('[TEST] ✓ Liste et accès par id corrects\n');

// Test 4 : matchTriggerPhrase() — correspondance insensible aux accents/majuscules.
console.log('[TEST] Test 4: matchTriggerPhrase() — correspondance normalisée...');
const match = mediaLibrary.matchTriggerPhrase(
  "N'oubliez pas les ANNONCÉS de la semaine avant de partir"
);
assert(
  match !== null,
  'une phrase contenant la phrase déclencheuse (accents/casse différents) doit matcher'
);
assert.strictEqual(match.id, imgItem.id);
console.log('[TEST] ✓ Correspondance normalisée détectée\n');

// Test 5 : matchTriggerPhrase() renvoie null sans correspondance.
console.log('[TEST] Test 5: matchTriggerPhrase() — aucune correspondance...');
assert.strictEqual(
  mediaLibrary.matchTriggerPhrase('Dieu a tellement aimé le monde'),
  null,
  'un texte sans rapport ne doit déclencher aucun média'
);
console.log('[TEST] ✓ Aucun faux positif\n');

// Test 6 : extension non supportée rejetée.
console.log('[TEST] Test 6: addItem() rejette une extension non supportée...');
const badSource = makeSourceFile('malware.exe');
assert.throws(
  () => mediaLibrary.addItem({ sourcePath: badSource, label: 'x' }),
  /non supporté/,
  'une extension hors liste blanche doit être rejetée'
);
console.log('[TEST] ✓ Extension non supportée rejetée\n');

// Test 7 : fichier source inexistant rejeté.
console.log('[TEST] Test 7: addItem() rejette un fichier source inexistant...');
assert.throws(
  () => mediaLibrary.addItem({ sourcePath: path.join(userDataDir, 'nope.png'), label: 'x' }),
  /introuvable/,
  'un chemin source inexistant doit être rejeté'
);
console.log('[TEST] ✓ Fichier source inexistant rejeté\n');

// Test 8 : deleteItem() supprime le fichier ET l'entrée d'index.
console.log('[TEST] Test 8: deleteItem()...');
const filePath = path.join(userDataDir, 'media', imgItem.filename);
assert(fs.existsSync(filePath), 'le fichier doit exister avant suppression');
const removed = mediaLibrary.deleteItem(imgItem.id);
assert.strictEqual(removed, true);
assert.strictEqual(mediaLibrary.getItem(imgItem.id), null, "l'entrée d'index doit avoir disparu");
assert(!fs.existsSync(filePath), 'le fichier copié doit avoir été supprimé du disque');
assert.strictEqual(
  mediaLibrary.matchTriggerPhrase('annonces de la semaine'),
  null,
  'un élément supprimé ne doit plus jamais se déclencher'
);
console.log('[TEST] ✓ Suppression complète (fichier + index)\n');

// Test 9 : deleteItem() sur un id inconnu renvoie false sans planter.
console.log('[TEST] Test 9: deleteItem() sur un id inconnu...');
assert.strictEqual(mediaLibrary.deleteItem('id-inexistant'), false);
console.log('[TEST] ✓ Suppression d’un id inconnu gérée proprement\n');

// Test 10 : updateItem() modifie durée/style d'un média DÉJÀ uploadé (voir
// demande explicite — "détails d'affichage" pour les médias déjà composés),
// sans toucher au fichier ni aux phrases déclencheuses.
console.log('[TEST] Test 10: updateItem() — durée et style...');
const updated = mediaLibrary.updateItem(vidItem.id, {
  displayDurationMs: 30_000,
  transitionStyle: 'slide',
});
assert(updated !== null);
assert.strictEqual(updated.displayDurationMs, 30_000);
assert.strictEqual(updated.transitionStyle, 'slide');
assert.strictEqual(
  mediaLibrary.getItem(vidItem.id).displayDurationMs,
  30_000,
  'la mise à jour doit être persistée sur disque'
);
assert.strictEqual(
  mediaLibrary.getItem(vidItem.id).label,
  'Intro culte',
  'updateItem() ne doit jamais toucher au libellé'
);
console.log('[TEST] ✓ Durée et style mis à jour et persistés\n');

// Test 10b : updateItem() avec displayDurationMs: null retire le minuteur
// (affichage jusqu'à masquage manuel), et un style inconnu est ignoré
// plutôt que stocké tel quel.
console.log('[TEST] Test 10b: updateItem() — durée null et style invalide...');
const updated2 = mediaLibrary.updateItem(vidItem.id, {
  displayDurationMs: null,
  transitionStyle: 'explosion-3d',
});
assert.strictEqual(updated2.displayDurationMs, null);
assert.strictEqual(
  updated2.transitionStyle,
  mediaLibrary.DEFAULT_TRANSITION_STYLE,
  'un style inconnu doit retomber sur le défaut plutôt que d’être accepté'
);
console.log('[TEST] ✓ Durée null et style invalide gérés correctement\n');

// Test 10c : updateItem() sur un id inconnu renvoie null sans planter.
console.log('[TEST] Test 10c: updateItem() sur un id inconnu...');
assert.strictEqual(mediaLibrary.updateItem('id-inexistant', { transitionStyle: 'zoom' }), null);
console.log('[TEST] ✓ Id inconnu géré proprement\n');

fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('=== Tous les tests media-library sont passés ===');
