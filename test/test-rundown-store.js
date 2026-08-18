/**
 * ============================================================================
 * test-rundown-store.js — Tests pour rundown-store.js
 * ----------------------------------------------------------------------------
 * Tests purs (aucun Electron/IPC/WebSocket) : addCue/listCues/getCue/
 * removeCue/reorderCues contre un dossier userData temporaire. Même
 * structure que test-scene-store.js.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rundownStore = require('../rundown-store');

console.log('=== Test Rundown Store ===\n');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-rundown-test-'));
rundownStore.setUserDataDir(userDataDir);

// Test 1 : listCues() vide au départ.
console.log('[TEST] Test 1: listCues() vide au départ...');
assert.deepStrictEqual(rundownStore.listCues(), []);
console.log('[TEST] ✓ Feuille de route vide au départ\n');

// Test 2 : addCue() type verse.
console.log('[TEST] Test 2: addCue() type verse...');
const verseCue = rundownStore.addCue({ type: 'verse', label: 'Jean 3:16', reference: 'Jean 3:16' });
assert.strictEqual(verseCue.type, 'verse');
assert.strictEqual(verseCue.label, 'Jean 3:16');
assert.strictEqual(verseCue.reference, 'Jean 3:16');
assert(typeof verseCue.id === 'string' && verseCue.id.length > 0);
assert(typeof verseCue.addedAt === 'string');
console.log('[TEST] ✓ Repère verset créé\n');

// Test 3 : addCue() type media.
console.log('[TEST] Test 3: addCue() type media...');
const mediaCue = rundownStore.addCue({
  type: 'media',
  label: 'Photo équipe',
  mediaId: 'media-abc',
});
assert.strictEqual(mediaCue.type, 'media');
assert.strictEqual(mediaCue.mediaId, 'media-abc');
console.log('[TEST] ✓ Repère média créé\n');

// Test 4 : addCue() type scene.
console.log('[TEST] Test 4: addCue() type scene...');
const sceneCue = rundownStore.addCue({ type: 'scene', label: 'Bienvenue', sceneId: 'scene-xyz' });
assert.strictEqual(sceneCue.type, 'scene');
assert.strictEqual(sceneCue.sceneId, 'scene-xyz');
console.log('[TEST] ✓ Repère scène créé\n');

// Test 5 : listCues() reflète l'ordre d'ajout.
console.log('[TEST] Test 5: listCues() reflète l’ordre d’ajout...');
const afterThree = rundownStore.listCues();
assert.strictEqual(afterThree.length, 3);
assert.deepStrictEqual(
  afterThree.map((c) => c.id),
  [verseCue.id, mediaCue.id, sceneCue.id]
);
console.log('[TEST] ✓ Ordre d’ajout préservé\n');

// Test 6 : getCue() par id, et id inconnu -> null.
console.log('[TEST] Test 6: getCue()...');
assert.strictEqual(rundownStore.getCue(mediaCue.id).label, 'Photo équipe');
assert.strictEqual(rundownStore.getCue('id-inconnu'), null);
console.log('[TEST] ✓ getCue() correct\n');

// Test 7 : validations — type invalide, verset sans référence, média sans mediaId, libellé vide.
console.log('[TEST] Test 7: validations...');
assert.throws(() => rundownStore.addCue({ type: 'song', label: 'x' }), /Type de repère invalide/);
assert.throws(
  () => rundownStore.addCue({ type: 'verse', label: 'x' }),
  /Référence biblique manquante/
);
assert.throws(() => rundownStore.addCue({ type: 'media', label: 'x' }), /mediaId manquant/);
assert.throws(() => rundownStore.addCue({ type: 'scene', label: 'x' }), /sceneId manquant/);
assert.throws(
  () => rundownStore.addCue({ type: 'verse', label: '', reference: 'Jean 3:16' }),
  /Libellé de repère manquant/
);
console.log('[TEST] ✓ Validations correctes\n');

// Test 8 : reorderCues() — réordonnancement complet.
console.log('[TEST] Test 8: reorderCues() — réordonnancement complet...');
const reordered = rundownStore.reorderCues([sceneCue.id, verseCue.id, mediaCue.id]);
assert.deepStrictEqual(
  reordered.map((c) => c.id),
  [sceneCue.id, verseCue.id, mediaCue.id]
);
assert.deepStrictEqual(
  rundownStore.listCues().map((c) => c.id),
  [sceneCue.id, verseCue.id, mediaCue.id]
);
console.log('[TEST] ✓ Réordonnancement complet appliqué et persisté\n');

// Test 9 : reorderCues() — ids inconnus ignorés, ids manquants ajoutés à la fin.
console.log('[TEST] Test 9: reorderCues() — robustesse (ids inconnus/partiels)...');
const partial = rundownStore.reorderCues([mediaCue.id, 'id-inconnu']);
assert.deepStrictEqual(
  partial.map((c) => c.id),
  [mediaCue.id, sceneCue.id, verseCue.id],
  'mediaCue en premier (demandé), les 2 autres ajoutés à la fin dans leur ordre relatif d’origine'
);
console.log('[TEST] ✓ Réordonnancement partiel robuste\n');

// Test 10 : removeCue().
console.log('[TEST] Test 10: removeCue()...');
assert.strictEqual(rundownStore.removeCue(sceneCue.id), true);
assert.strictEqual(rundownStore.removeCue('id-inconnu'), false);
assert.strictEqual(rundownStore.listCues().length, 2);
assert.strictEqual(rundownStore.getCue(sceneCue.id), null);
console.log('[TEST] ✓ removeCue() correct\n');

// Test 11 : MAX_CUES respecté.
console.log('[TEST] Test 11: MAX_CUES respecté...');
rundownStore.clearCues();
for (let i = 0; i < rundownStore.MAX_CUES; i++) {
  rundownStore.addCue({ type: 'media', label: `Média ${i}`, mediaId: `m-${i}` });
}
assert.strictEqual(rundownStore.listCues().length, rundownStore.MAX_CUES);
assert.throws(
  () => rundownStore.addCue({ type: 'media', label: 'Trop', mediaId: 'trop' }),
  /Feuille de route pleine/
);
console.log('[TEST] ✓ MAX_CUES respecté\n');

// Test 12 : clearCues().
console.log('[TEST] Test 12: clearCues()...');
rundownStore.clearCues();
assert.deepStrictEqual(rundownStore.listCues(), []);
console.log('[TEST] ✓ clearCues() vide bien la feuille de route\n');

fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('=== Tous les tests rundown-store sont passés ===');
