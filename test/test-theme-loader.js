'use strict';
/**
 * Tests unitaires pour theme-loader.js
 * Vérifie chargement, sauvegarde, liste, suppression, duplication, conversion
 * CSS, protection des thèmes en lecture seule, et le thème actif
 * (getActiveTheme / setActiveTheme piloté par config/features.json).
 *
 * Thèmes livrés avec l'app (readonly: true, jamais supprimables/écrasables) :
 *   - nuit   : thème sombre doré par défaut (ex-mesev-default)
 *   - claire : thème clair minimaliste (ex-sobre-clair)
 */

const fs = require('fs');
const path = require('path');
const themeLoader = require('../theme-loader');

const THEMES_DIR = path.join(__dirname, '..', 'config', 'themes');
const FEATURES_FILE = path.join(__dirname, '..', 'config', 'features.json');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

function cleanup() {
  for (const f of fs.readdirSync(THEMES_DIR)) {
    if (f.startsWith('_test_')) {
      fs.unlinkSync(path.join(THEMES_DIR, f));
    }
  }
}

console.log('=== Tests theme-loader.js ===');
cleanup();

const themes = themeLoader.listThemes();
assert(themes.length >= 2, 'listThemes retourne au moins 2 thèmes (nuit + claire)');
assert(
  themes.some((t) => t.id === 'nuit'),
  'nuit est dans la liste'
);
assert(
  themes.some((t) => t.id === 'claire'),
  'claire est dans la liste'
);

const nuit = themeLoader.loadTheme('nuit');
assert(nuit.id === 'nuit', 'loadTheme(nuit) : id correct');
assert(nuit.colors.accent === '#D9BB6C', 'loadTheme : couleur accent (or) récupérée');
assert(nuit.effects.showCross === true, 'loadTheme : effet showCross activé');
assert(nuit.readonly === true, 'nuit marqué readonly');

const claire = themeLoader.loadTheme('claire');
assert(claire.readonly === true, 'claire marqué readonly');
assert(claire.effects.showCross === false, 'claire : pas de croix (thème sobre)');

const css = themeLoader.themeToCss(nuit);
assert(css.variables['--accent'] === '#D9BB6C', 'themeToCss : variable --accent correcte');
assert(css.variables['--verse-font'].includes('Merriweather'), 'themeToCss : police fournie');
assert(css.effects.showCross === true, 'themeToCss : effets propagés');
assert(css.background.type === 'none', 'themeToCss : backgroundImage propagé');

// CORRECTIF (Studio Clair — nouveau thème par défaut) : ces deux
// assertions vérifient le repli sur DEFAULT_THEME_ID pour les champs
// absents — leurs valeurs attendues suivent donc le thème par défaut
// ACTUEL (studio-clair-ivoire : Newsreader, pas de croix), pas une valeur
// figée sur 'nuit'. Le mécanisme testé (repli sur le défaut) est
// inchangé, seul le défaut lui-même a changé.
const partial = { id: '_test_partial', name: 'Partiel', colors: { accent: '#FF0000' } };
themeLoader.saveTheme(partial);
const loadedPartial = themeLoader.loadTheme('_test_partial');
const cssPartial = themeLoader.themeToCss(loadedPartial);
assert(cssPartial.variables['--accent'] === '#FF0000', 'themeToCss : accent personnalisé conservé');
assert(
  cssPartial.variables['--verse-font'].includes('Newsreader'),
  'themeToCss : typographie héritée du défaut (studio-clair-ivoire)'
);
assert(
  cssPartial.effects.showCross === false,
  'themeToCss : effets hérités du défaut (studio-clair-ivoire)'
);
themeLoader.deleteTheme('_test_partial');

const testTheme = {
  id: '_test_custom',
  name: 'Test Custom',
  description: 'Thème de test',
  colors: { accent: '#00FF00' },
  typography: { verseFontWeight: 900 },
  effects: { showParticles: false },
  backgroundImage: { type: 'none' },
};
themeLoader.saveTheme(testTheme);
const loaded = themeLoader.loadTheme('_test_custom');
assert(
  loaded.colors.accent === '#00FF00',
  'saveTheme + loadTheme : couleur accent personnalisée conservée'
);
assert(
  loaded.typography.verseFontWeight === 900,
  'saveTheme : typographie personnalisée conservée'
);
assert(loaded.effects.showParticles === false, 'saveTheme : effet désactivé conservé');

themeLoader.duplicateTheme('claire', '_test_dup', 'Test Dup');
const dup = themeLoader.loadTheme('_test_dup');
assert(dup.name === 'Test Dup', 'duplicateTheme : nouveau nom appliqué');
assert(dup.readonly === false, "Le duplicata n'est PAS readonly");
assert(
  dup.colors.accent === themeLoader.loadTheme('claire').colors.accent,
  'duplicateTheme : palette copiée'
);

try {
  themeLoader.deleteTheme('nuit');
  assert(false, 'DOIT LEVER une erreur en supprimant nuit');
} catch (e) {
  assert(/lecture seule|défaut/i.test(e.message), 'Suppression de nuit rejetée');
}

try {
  themeLoader.saveTheme({ id: 'nuit', name: 'Hack' });
  assert(false, 'DOIT LEVER une erreur en écrasant nuit');
} catch (e) {
  assert(/lecture seule|défaut/i.test(e.message), 'Écrasement de nuit rejeté');
}

try {
  themeLoader.saveTheme({ id: 'bad id with spaces', name: 'x' });
  assert(false, 'DOIT lever une erreur sur id invalide');
} catch (e) {
  assert(/ID/i.test(e.message), 'ID invalide rejeté');
}

try {
  themeLoader.saveTheme({ id: '_test_ok', name: '' });
  assert(false, 'DOIT lever une erreur sur nom vide');
} catch (e) {
  assert(/[Nn]om/.test(e.message), 'Nom vide rejeté');
}

themeLoader.deleteTheme('_test_custom');
themeLoader.deleteTheme('_test_dup');
const afterDelete = themeLoader.listThemes();
assert(
  !afterDelete.some((t) => t.id === '_test_custom'),
  'deleteTheme : thème disparu de la liste'
);

const featuresBefore = fs.readFileSync(FEATURES_FILE, 'utf8');
try {
  const active = themeLoader.getActiveTheme();
  assert(active && active.id, 'getActiveTheme retourne un thème valide');

  themeLoader.setActiveTheme('claire');
  const newActive = themeLoader.getActiveTheme();
  assert(newActive.id === 'claire', 'setActiveTheme : nuit → claire appliqué');

  themeLoader.setActiveTheme('nuit');
  assert(themeLoader.getActiveTheme().id === 'nuit', 'setActiveTheme : restauration vers nuit');

  try {
    themeLoader.setActiveTheme('inexistant');
    assert(false, 'DOIT lever une erreur pour un thème inexistant');
  } catch (e) {
    assert(/introuvable/i.test(e.message), 'setActiveTheme rejette un id inexistant');
  }
} finally {
  fs.writeFileSync(FEATURES_FILE, featuresBefore, 'utf8');
}

cleanup();
console.log('\n=== Tous les tests theme-loader OK ===');
