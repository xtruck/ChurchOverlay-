/**
 * ============================================================================
 *  test-dashboard-branding-store.js — Tests pour dashboard-branding-store.js
 * ----------------------------------------------------------------------------
 *  Tests purs (aucun Electron/IPC/WebSocket) : setOrganizationName/
 *  setAccentColor/setLogo/clearLogo contre un dossier userData temporaire.
 *  Même isolation/structure que test-branding-store.js.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dashboardBrandingStore = require('../dashboard-branding-store');

console.log('=== Test Dashboard Branding Store ===\n');

const userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'churchoverlay-dashboard-branding-test-')
);
dashboardBrandingStore.setUserDataDir(userDataDir);

function makeSourceFile(filename) {
  const p = path.join(userDataDir, 'sources', filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
}

// Test 1 : getConfig() avant tout réglage -> valeurs par défaut.
console.log('[TEST] Test 1: getConfig() par défaut...');
{
  const config = dashboardBrandingStore.getConfig();
  assert.strictEqual(config.organizationName, null);
  assert.strictEqual(config.accentColor, null);
  assert.strictEqual(config.logoFilename, null);
}
console.log('[TEST] ✓ Valeurs par défaut correctes\n');

// Test 2 : setOrganizationName() enregistre et coupe les espaces superflus.
console.log('[TEST] Test 2: setOrganizationName()...');
{
  const config = dashboardBrandingStore.setOrganizationName('  Église de la Grâce  ');
  assert.strictEqual(config.organizationName, 'Église de la Grâce');
  const emptyConfig = dashboardBrandingStore.setOrganizationName('   ');
  assert.strictEqual(emptyConfig.organizationName, null, 'un nom vide retombe sur null (défaut)');
}
console.log('[TEST] ✓ Nom d’organisation enregistré et normalisé\n');

// Test 2b : setOrganizationName() tronque un nom trop long.
console.log('[TEST] Test 2b: setOrganizationName() tronque un nom trop long...');
{
  const tooLong = 'A'.repeat(200);
  const config = dashboardBrandingStore.setOrganizationName(tooLong);
  assert.strictEqual(config.organizationName.length, dashboardBrandingStore.MAX_ORG_NAME_LENGTH);
}
console.log('[TEST] ✓ Nom trop long tronqué\n');

// Test 3 : setAccentColor() accepte un hex valide.
console.log('[TEST] Test 3: setAccentColor() accepte un hex valide...');
{
  const config = dashboardBrandingStore.setAccentColor('#ff0033');
  assert.strictEqual(config.accentColor, '#ff0033');
}
console.log('[TEST] ✓ Couleur valide enregistrée\n');

// Test 3b : setAccentColor() rejette une valeur non hexadécimale.
console.log('[TEST] Test 3b: setAccentColor() rejette une couleur invalide...');
{
  assert.throws(
    () => dashboardBrandingStore.setAccentColor('red'),
    /invalide/,
    'un nom de couleur CSS (non hex) doit être rejeté'
  );
  assert.throws(
    () => dashboardBrandingStore.setAccentColor('<script>alert(1)</script>'),
    /invalide/,
    'une valeur non hexadécimale doit être rejetée, jamais stockée telle quelle'
  );
}
console.log('[TEST] ✓ Couleur invalide rejetée\n');

// Test 4 : setLogo() copie le fichier et le référence dans la config.
console.log('[TEST] Test 4: setLogo()...');
const logoSource = makeSourceFile('logo.png');
const config4 = dashboardBrandingStore.setLogo(logoSource);
assert(config4.logoFilename, 'un nom de fichier doit être généré');
assert(
  fs.existsSync(path.join(userDataDir, 'dashboard-branding', config4.logoFilename)),
  'le fichier doit avoir été copié dans <userData>/dashboard-branding/'
);
console.log('[TEST] ✓ Logo copié et référencé correctement\n');

// Test 5 : setLogo() remplace l'ancien logo (fichier précédent supprimé).
console.log('[TEST] Test 5: setLogo() remplace le logo précédent...');
{
  const oldFilename = dashboardBrandingStore.getConfig().logoFilename;
  const oldPath = path.join(userDataDir, 'dashboard-branding', oldFilename);
  const newLogoSource = makeSourceFile('logo2.png');
  const config = dashboardBrandingStore.setLogo(newLogoSource);
  assert.notStrictEqual(
    config.logoFilename,
    oldFilename,
    'un nouveau nom de fichier doit être généré'
  );
  assert(!fs.existsSync(oldPath), "l'ancien fichier logo doit avoir été supprimé");
  assert(fs.existsSync(path.join(userDataDir, 'dashboard-branding', config.logoFilename)));
}
console.log('[TEST] ✓ Ancien logo remplacé et supprimé du disque\n');

// Test 6 : setLogo() rejette une extension non supportée (ex. exécutable).
console.log('[TEST] Test 6: setLogo() rejette une extension non supportée...');
{
  const badSource = makeSourceFile('logo.exe');
  assert.throws(
    () => dashboardBrandingStore.setLogo(badSource),
    /non supporté/,
    'un exécutable ne doit jamais être accepté comme logo'
  );
}
console.log('[TEST] ✓ Extension non supportée rejetée\n');

// Test 7 : setLogo() rejette un fichier source inexistant.
console.log('[TEST] Test 7: setLogo() rejette un fichier source inexistant...');
assert.throws(
  () => dashboardBrandingStore.setLogo(path.join(userDataDir, 'nope.png')),
  /introuvable/,
  'un chemin source inexistant doit être rejeté'
);
console.log('[TEST] ✓ Fichier source inexistant rejeté\n');

// Test 8 : clearLogo() retire le logo (fichier + config), sans toucher au
// nom d'organisation ni à la couleur d'accent (champs indépendants).
console.log('[TEST] Test 8: clearLogo() ne touche pas aux autres champs...');
{
  const before = dashboardBrandingStore.getConfig();
  assert(before.logoFilename, 'le logo doit exister avant suppression');
  const currentPath = path.join(userDataDir, 'dashboard-branding', before.logoFilename);
  assert(fs.existsSync(currentPath));
  const cleared = dashboardBrandingStore.clearLogo();
  assert.strictEqual(cleared.logoFilename, null);
  assert(!fs.existsSync(currentPath), 'le fichier logo doit être supprimé du disque');
  assert.strictEqual(
    cleared.organizationName,
    before.organizationName,
    'clearLogo() ne doit pas affecter le nom d’organisation'
  );
  assert.strictEqual(
    cleared.accentColor,
    before.accentColor,
    'clearLogo() ne doit pas affecter la couleur d’accent'
  );
}
console.log('[TEST] ✓ Logo retiré sans affecter les autres champs\n');

console.log('=== Résultat dashboard-branding-store : tous les tests sont passés ===');
