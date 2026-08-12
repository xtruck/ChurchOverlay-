/**
 * ============================================================================
 *  test-scene-store.js — Tests pour scene-store.js
 * ----------------------------------------------------------------------------
 *  Tests purs (aucun Electron/IPC/WebSocket) : addScene/listItems/getItem/
 *  updateScene/deleteItem/poster-principal contre un dossier userData
 *  temporaire. Même isolation que test-media-library.js, dont ce fichier
 *  reprend délibérément la structure (scene-store.js est un clone assumé de
 *  media-library.js — voir son en-tête).
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sceneStore = require('../scene-store');

console.log('=== Test Scene Store ===\n');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-scene-test-'));
sceneStore.setUserDataDir(userDataDir);

// Test 1 : addScene() minimal (nom seul) — fond et éléments par défaut.
console.log('[TEST] Test 1: addScene() minimal...');
const emptyScene = sceneStore.addScene({ name: 'Scène vide' });
assert.strictEqual(emptyScene.name, 'Scène vide');
assert.deepStrictEqual(
  emptyScene.background,
  { type: 'none', mediaId: null, color: null },
  'fond par défaut : aucun'
);
assert.deepStrictEqual(emptyScene.elements, [], 'aucun élément par défaut');
assert.strictEqual(emptyScene.isDefault, false, 'jamais poster principal à la création');
assert(typeof emptyScene.id === 'string' && emptyScene.id.length > 0);
assert.strictEqual(emptyScene.addedAt, emptyScene.updatedAt, 'addedAt === updatedAt à la création');
console.log('[TEST] ✓ Scène minimale créée avec les bons défauts\n');

// Test 2 : addScene() avec un fond image et des éléments texte/image complets.
console.log('[TEST] Test 2: addScene() — fond + éléments complets...');
const fullScene = sceneStore.addScene({
  name: 'Bienvenue — dimanche',
  background: { type: 'media', mediaId: 'media-abc-123' },
  elements: [
    {
      type: 'text',
      text: 'Bienvenue à tous !',
      position: 'top-center',
      align: 'center',
      fontFamily: 'Manrope',
      fontSizePct: 8,
      fontWeight: 700,
      color: '#FFD700',
    },
    { type: 'image', mediaId: 'logo-xyz-789', position: 'bottom-right', widthPct: 15 },
  ],
});
assert.strictEqual(fullScene.background.type, 'media');
assert.strictEqual(fullScene.background.mediaId, 'media-abc-123');
assert.strictEqual(fullScene.elements.length, 2);
assert.strictEqual(fullScene.elements[0].type, 'text');
assert.strictEqual(fullScene.elements[0].text, 'Bienvenue à tous !');
assert.strictEqual(fullScene.elements[0].position, 'top-center');
assert.strictEqual(fullScene.elements[0].fontFamily, 'Manrope');
assert.strictEqual(fullScene.elements[0].fontSizePct, 8);
assert.strictEqual(fullScene.elements[0].fontWeight, 700);
assert.strictEqual(fullScene.elements[0].color, '#FFD700');
assert.strictEqual(fullScene.elements[1].type, 'image');
assert.strictEqual(fullScene.elements[1].mediaId, 'logo-xyz-789');
assert.strictEqual(fullScene.elements[1].widthPct, 15);
assert(typeof fullScene.elements[0].id === 'string' && fullScene.elements[0].id.length > 0);
assert(typeof fullScene.elements[1].id === 'string' && fullScene.elements[1].id.length > 0);
assert.notStrictEqual(
  fullScene.elements[0].id,
  fullScene.elements[1].id,
  'chaque élément reçoit un id distinct'
);
console.log('[TEST] ✓ Scène complète créée avec fond et éléments corrects\n');

// Test 3 : sanitisation — valeurs invalides retombent sur les défauts, pas
// stockées telles quelles (même discipline que TRANSITION_STYLES dans
// media-library.js).
console.log('[TEST] Test 3: addScene() — sanitisation des valeurs invalides...');
const dirtyScene = sceneStore.addScene({
  name: 'Scène sale',
  background: { type: 'couleur-invalide', mediaId: 'x' },
  elements: [
    {
      type: 'text',
      text: 'x',
      position: 'nulle-part',
      align: 'diagonal',
      fontFamily: 'Comic Sans MS',
      fontSizePct: 9999,
      fontWeight: 999,
    },
    { type: 'image', mediaId: 'img-1', widthPct: -50 },
    { type: 'image' /* mediaId manquant */ },
  ],
});
assert.strictEqual(dirtyScene.background.type, 'none', 'type de fond inconnu -> "none"');
assert.strictEqual(
  dirtyScene.background.mediaId,
  null,
  'mediaId ignoré si le fond n’est pas "media"'
);
assert.strictEqual(
  dirtyScene.elements.length,
  2,
  'un élément image sans mediaId doit être rejeté silencieusement (pas de crash)'
);
assert.strictEqual(dirtyScene.elements[0].position, sceneStore.DEFAULT_POSITION);
assert.strictEqual(dirtyScene.elements[0].align, sceneStore.DEFAULT_TEXT_ALIGN);
assert.strictEqual(dirtyScene.elements[0].fontFamily, sceneStore.DEFAULT_FONT_FAMILY);
assert.strictEqual(
  dirtyScene.elements[0].fontSizePct,
  sceneStore.MAX_FONT_SIZE_PCT,
  'plafonné au maximum'
);
assert.strictEqual(dirtyScene.elements[0].fontWeight, sceneStore.DEFAULT_FONT_WEIGHT);
assert.strictEqual(dirtyScene.elements[1].widthPct, 1, 'largeur négative plancher à 1');
console.log('[TEST] ✓ Valeurs invalides retombent sur les défauts, aucun crash\n');

// Test 4 : addScene() sans nom est rejeté.
console.log('[TEST] Test 4: addScene() rejette un nom manquant/vide...');
assert.throws(() => sceneStore.addScene({}), /[Nn]om/, 'nom manquant doit être rejeté');
assert.throws(
  () => sceneStore.addScene({ name: '   ' }),
  /[Nn]om/,
  'nom vide (espaces) doit être rejeté'
);
console.log('[TEST] ✓ Nom manquant rejeté\n');

// Test 5 : nombre d'éléments plafonné à MAX_ELEMENTS_PER_SCENE.
console.log('[TEST] Test 5: addScene() plafonne le nombre d’éléments...');
const manyElements = Array.from({ length: sceneStore.MAX_ELEMENTS_PER_SCENE + 10 }, (_, i) => ({
  type: 'text',
  text: `Élément ${i}`,
}));
const cappedScene = sceneStore.addScene({ name: 'Trop d’éléments', elements: manyElements });
assert.strictEqual(cappedScene.elements.length, sceneStore.MAX_ELEMENTS_PER_SCENE);
console.log('[TEST] ✓ Nombre d’éléments plafonné correctement\n');

// Test 6 : listItems()/getItem() reflètent les ajouts.
console.log('[TEST] Test 6: listItems() / getItem()...');
const items = sceneStore.listItems();
assert.strictEqual(items.length, 4, 'les quatre scènes ajoutées jusqu’ici doivent apparaître');
assert.strictEqual(sceneStore.getItem(fullScene.id).name, 'Bienvenue — dimanche');
assert.strictEqual(sceneStore.getItem('id-inexistant'), null, 'un id inconnu doit renvoyer null');
console.log('[TEST] ✓ Liste et accès par id corrects\n');

// Test 7 : updateScene() — patch partiel (nom seul, sans toucher au reste).
console.log('[TEST] Test 7: updateScene() — patch partiel...');
const renamedScene = sceneStore.updateScene(emptyScene.id, { name: 'Scène renommée' });
assert.strictEqual(renamedScene.name, 'Scène renommée');
assert.deepStrictEqual(
  renamedScene.background,
  emptyScene.background,
  'fond inchangé par un patch de nom seul'
);
assert.notStrictEqual(renamedScene.updatedAt, emptyScene.updatedAt, 'updatedAt doit avancer');
assert.strictEqual(renamedScene.addedAt, emptyScene.addedAt, 'addedAt ne doit jamais changer');
console.log('[TEST] ✓ Patch partiel appliqué, addedAt préservé\n');

// Test 7b : updateScene() — remplace intégralement le fond/les éléments
// quand ces champs sont fournis (pas une fusion élément par élément).
console.log('[TEST] Test 7b: updateScene() — remplacement fond + éléments...');
const updatedFull = sceneStore.updateScene(fullScene.id, {
  background: { type: 'color', color: '#123456' },
  elements: [{ type: 'text', text: 'Nouveau texte unique' }],
});
assert.strictEqual(updatedFull.background.type, 'color');
assert.strictEqual(updatedFull.background.color, '#123456');
assert.strictEqual(
  updatedFull.elements.length,
  1,
  'les anciens éléments doivent être remplacés, pas fusionnés'
);
assert.strictEqual(updatedFull.elements[0].text, 'Nouveau texte unique');
console.log('[TEST] ✓ Fond et éléments remplacés intégralement\n');

// Test 7c : updateScene() sur un id inconnu renvoie null sans planter.
console.log('[TEST] Test 7c: updateScene() sur un id inconnu...');
assert.strictEqual(sceneStore.updateScene('id-inexistant', { name: 'x' }), null);
console.log('[TEST] ✓ Id inconnu géré proprement\n');

// Test 8 : deleteItem() supprime l'entrée d'index (aucun fichier propre à
// une scène — voir l'en-tête de scene-store.js).
console.log('[TEST] Test 8: deleteItem()...');
const removed = sceneStore.deleteItem(dirtyScene.id);
assert.strictEqual(removed, true);
assert.strictEqual(sceneStore.getItem(dirtyScene.id), null, "l'entrée d'index doit avoir disparu");
console.log('[TEST] ✓ Suppression correcte\n');

// Test 9 : deleteItem() sur un id inconnu renvoie false sans planter.
console.log('[TEST] Test 9: deleteItem() sur un id inconnu...');
assert.strictEqual(sceneStore.deleteItem('id-inexistant'), false);
console.log('[TEST] ✓ Suppression d’un id inconnu gérée proprement\n');

// Test 10 : getDefaultScene() renvoie null tant qu'aucune scène par défaut
// n'a été désignée.
console.log('[TEST] Test 10: getDefaultScene() sans poster principal...');
assert.strictEqual(sceneStore.getDefaultScene(), null);
console.log('[TEST] ✓ Aucun poster principal par défaut\n');

// Test 11 : setDefaultScene() marque la scène comme poster principal.
console.log('[TEST] Test 11: setDefaultScene() — marquage...');
const defaultResult = sceneStore.setDefaultScene(cappedScene.id);
assert(defaultResult !== null);
assert.strictEqual(defaultResult.isDefault, true);
assert.strictEqual(sceneStore.getDefaultScene().id, cappedScene.id);
console.log('[TEST] ✓ Poster principal désigné\n');

// Test 12 : un seul poster principal à la fois — en désigner un nouveau
// démarque automatiquement l'ancien (DANS CET INDEX — l'arbitrage avec
// media-library.js est le lot 2, pas testé ici).
console.log('[TEST] Test 12: setDefaultScene() — un seul à la fois...');
const secondDefault = sceneStore.setDefaultScene(renamedScene.id);
assert.strictEqual(secondDefault.isDefault, true);
assert.strictEqual(
  sceneStore.getItem(cappedScene.id).isDefault,
  false,
  'l’ancienne scène par défaut doit être démarquée automatiquement'
);
assert.strictEqual(sceneStore.getDefaultScene().id, renamedScene.id);
console.log('[TEST] ✓ Un seul poster principal à la fois, ancien démarqué\n');

// Test 13 : clearDefaultScene() retire le statut, getDefaultScene() renvoie
// à nouveau null.
console.log('[TEST] Test 13: clearDefaultScene()...');
const cleared = sceneStore.clearDefaultScene();
assert.strictEqual(cleared.id, renamedScene.id);
assert.strictEqual(sceneStore.getDefaultScene(), null);
assert.strictEqual(sceneStore.getItem(renamedScene.id).isDefault, false);
console.log('[TEST] ✓ Poster principal retiré correctement\n');

// Test 14 : setDefaultScene()/clearDefaultScene() sur un id inconnu ou sans
// poster actif renvoient null sans planter.
console.log('[TEST] Test 14: cas limites (id inconnu / rien à retirer)...');
assert.strictEqual(sceneStore.setDefaultScene('id-inexistant'), null);
assert.strictEqual(sceneStore.clearDefaultScene(), null, 'rien à retirer -> null, pas d’erreur');
console.log('[TEST] ✓ Cas limites gérés proprement\n');

fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('=== Tous les tests scene-store sont passés ===');
