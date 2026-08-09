/**
 * ============================================================================
 *  test-branding-store.js — Tests pour branding-store.js
 * ----------------------------------------------------------------------------
 *  Tests purs (aucun Electron/IPC/WebSocket) : setLogo/clearLogo/setPosition
 *  contre un dossier userData temporaire. Même isolation que
 *  test-media-library.js.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const brandingStore = require('../branding-store');

console.log('=== Test Branding Store ===\n');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-branding-test-'));
brandingStore.setUserDataDir(userDataDir);

function makeSourceFile(filename) {
  const p = path.join(userDataDir, 'sources', filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
}

// Test 1 : getConfig() avant tout réglage -> valeurs par défaut.
console.log('[TEST] Test 1: getConfig() par défaut...');
{
  const config = brandingStore.getConfig();
  assert.strictEqual(config.logoFilename, null);
  assert.strictEqual(config.position, brandingStore.DEFAULT_POSITION);
}
console.log('[TEST] ✓ Valeurs par défaut correctes\n');

// Test 2 : setLogo() copie le fichier et le référence dans la config.
console.log('[TEST] Test 2: setLogo()...');
const logoSource = makeSourceFile('logo.png');
const config2 = brandingStore.setLogo(logoSource);
assert(config2.logoFilename, 'un nom de fichier doit être généré');
assert(
  fs.existsSync(path.join(userDataDir, 'branding', config2.logoFilename)),
  'le fichier doit avoir été copié dans <userData>/branding/'
);
console.log('[TEST] ✓ Logo copié et référencé correctement\n');

// Test 3 : setLogo() remplace l'ancien logo (fichier précédent supprimé).
console.log('[TEST] Test 3: setLogo() remplace le logo précédent...');
const oldFilename = brandingStore.getConfig().logoFilename;
const oldPath = path.join(userDataDir, 'branding', oldFilename);
const newLogoSource = makeSourceFile('logo2.png');
const config3 = brandingStore.setLogo(newLogoSource);
assert.notStrictEqual(
  config3.logoFilename,
  oldFilename,
  'un nouveau nom de fichier doit être généré'
);
assert(!fs.existsSync(oldPath), "l'ancien fichier logo doit avoir été supprimé");
assert(fs.existsSync(path.join(userDataDir, 'branding', config3.logoFilename)));
console.log('[TEST] ✓ Ancien logo remplacé et supprimé du disque\n');

// Test 4 : setLogo() rejette une extension non supportée.
console.log('[TEST] Test 4: setLogo() rejette une extension non supportée...');
const badSource = makeSourceFile('logo.mp4');
assert.throws(
  () => brandingStore.setLogo(badSource),
  /non supporté/,
  'une vidéo ne doit pas être acceptée comme logo'
);
console.log('[TEST] ✓ Extension non supportée rejetée\n');

// Test 5 : setLogo() rejette un fichier source inexistant.
console.log('[TEST] Test 5: setLogo() rejette un fichier source inexistant...');
assert.throws(
  () => brandingStore.setLogo(path.join(userDataDir, 'nope.png')),
  /introuvable/,
  'un chemin source inexistant doit être rejeté'
);
console.log('[TEST] ✓ Fichier source inexistant rejeté\n');

// Test 6 : setPosition() valide/retombe sur le défaut pour une valeur inconnue.
console.log('[TEST] Test 6: setPosition()...');
const configTopLeft = brandingStore.setPosition('top-left');
assert.strictEqual(configTopLeft.position, 'top-left');
const configInvalid = brandingStore.setPosition('milieu-de-l-ecran');
assert.strictEqual(
  configInvalid.position,
  brandingStore.DEFAULT_POSITION,
  'une position inconnue doit retomber sur le défaut'
);
console.log('[TEST] ✓ Position validée correctement\n');

// Test 7 : clearLogo() retire le logo (fichier + config).
console.log('[TEST] Test 7: clearLogo()...');
const currentFilename = brandingStore.getConfig().logoFilename;
const currentPath = path.join(userDataDir, 'branding', currentFilename);
assert(fs.existsSync(currentPath), 'le logo doit exister avant suppression');
const clearedConfig = brandingStore.clearLogo();
assert.strictEqual(clearedConfig.logoFilename, null);
assert(!fs.existsSync(currentPath), 'le fichier logo doit avoir été supprimé du disque');
console.log('[TEST] ✓ Logo retiré complètement (fichier + config)\n');

// Test 8 : clearLogo() sans logo actif ne plante pas.
console.log('[TEST] Test 8: clearLogo() sans logo actif...');
const clearedAgain = brandingStore.clearLogo();
assert.strictEqual(clearedAgain.logoFilename, null);
console.log('[TEST] ✓ Appel sans effet géré proprement\n');

fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('=== Tous les tests branding-store sont passés ===');
