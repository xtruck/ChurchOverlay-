/**
 * ============================================================================
 *  test-ip-camera-store.js — Tests pour ip-camera-store.js
 * ----------------------------------------------------------------------------
 *  Tests purs (aucun réseau/Electron) : addItem/listItems/deleteItem contre
 *  un dossier userData temporaire. Même isolation que test-media-library.js.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ipCameraStore = require('../ip-camera-store');

console.log('=== Test IP Camera Store ===\n');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-ipcam-test-'));
ipCameraStore.setUserDataDir(userDataDir);

// Test 1 : addItem() ajoute une caméra IP avec une URL valide.
console.log('[TEST] Test 1: addItem() avec une URL valide...');
const item1 = ipCameraStore.addItem({
  label: 'Téléphone scène',
  url: 'http://192.168.1.50:8080/video',
});
assert.strictEqual(item1.label, 'Téléphone scène');
assert.strictEqual(item1.url, 'http://192.168.1.50:8080/video');
assert(item1.id, 'un id doit être généré');
console.log('[TEST] ✓ Caméra IP ajoutée correctement\n');

// Test 2 : addItem() rejette une URL qui n'est ni http:// ni https://.
console.log('[TEST] Test 2: addItem() rejette une URL invalide...');
assert.throws(
  () => ipCameraStore.addItem({ label: 'x', url: '192.168.1.50:8080/video' }),
  /URL invalide/,
  'une URL sans schéma http(s) doit être rejetée'
);
assert.throws(
  () => ipCameraStore.addItem({ label: 'x', url: 'ftp://192.168.1.50/video' }),
  /URL invalide/,
  'un schéma non-http(s) doit être rejeté'
);
assert.throws(
  () => ipCameraStore.addItem({ label: 'x', url: '' }),
  /URL invalide/,
  'une URL vide doit être rejetée'
);
console.log('[TEST] ✓ URLs invalides rejetées\n');

// Test 3 : addItem() retombe sur un libellé générique si aucun n'est fourni.
console.log('[TEST] Test 3: addItem() sans libellé retombe sur un nom générique...');
const item2 = ipCameraStore.addItem({ url: 'https://192.168.1.51:8080/video' });
assert.strictEqual(item2.label, 'Téléphone');
console.log('[TEST] ✓ Libellé générique appliqué\n');

// Test 4 : listItems() reflète les ajouts, les plus récents en premier.
console.log('[TEST] Test 4: listItems()...');
const items = ipCameraStore.listItems();
assert.strictEqual(items.length, 2);
assert.strictEqual(items[0].id, item2.id, 'le plus récemment ajouté doit apparaître en premier');
console.log('[TEST] ✓ Liste correcte, ordre du plus récent au plus ancien\n');

// Test 5 : deleteItem() retire l'entrée de l'index.
console.log('[TEST] Test 5: deleteItem()...');
const removed = ipCameraStore.deleteItem(item1.id);
assert.strictEqual(removed, true);
assert.strictEqual(ipCameraStore.listItems().length, 1);
console.log('[TEST] ✓ Caméra IP supprimée correctement\n');

// Test 6 : deleteItem() sur un id inconnu renvoie false sans planter.
console.log('[TEST] Test 6: deleteItem() sur un id inconnu...');
assert.strictEqual(ipCameraStore.deleteItem('id-inexistant'), false);
console.log('[TEST] ✓ Id inconnu géré proprement\n');

// Test 7 : MAX_ITEMS — la liste ne grossit pas indéfiniment (quelques
// téléphones en régie, pas un parc de caméras).
console.log('[TEST] Test 7: plafond MAX_ITEMS...');
for (let i = 0; i < ipCameraStore.MAX_ITEMS + 3; i++) {
  ipCameraStore.addItem({ label: `Cam ${i}`, url: `http://192.168.1.${60 + i}:8080/video` });
}
assert.strictEqual(
  ipCameraStore.listItems().length,
  ipCameraStore.MAX_ITEMS,
  'la liste doit être plafonnée à MAX_ITEMS'
);
console.log('[TEST] ✓ Plafond respecté\n');

fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('=== Tous les tests ip-camera-store sont passés ===');
