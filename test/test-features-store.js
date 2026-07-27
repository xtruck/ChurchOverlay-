'use strict';
/**
 * Tests unitaires pour features-store.js et pour l'isolation des thèmes
 * utilisateur (theme-loader.setUserDataDir).
 *
 * RÉGRESSION COUVERTE (audit round 5) : une fois l'app packagée (asar:true),
 * config/features.json et config/themes/ vivent dans app.asar, en LECTURE
 * SEULE — changer de thème ou enregistrer la config OBS depuis le tableau de
 * bord échouait donc systématiquement chez un utilisateur installé, alors que
 * tout marchait en développement. Les écritures vont maintenant dans le
 * dossier userData d'Electron, et la lecture fusionne config livrée +
 * surcharges utilisateur.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const featuresStore = require('../features-store');
const themeLoader = require('../theme-loader');

const BUILTIN_FEATURES = path.join(__dirname, '..', 'config', 'features.json');
const BUILTIN_THEMES = path.join(__dirname, '..', 'config', 'themes');

function assert(cond, msg) {
  if (!cond) { console.error('[TEST] ✗', msg); process.exit(1); }
  console.log('[TEST] ✓', msg);
}

console.log('=== Tests features-store.js ===');

const builtinBefore = fs.readFileSync(BUILTIN_FEATURES, 'utf8');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-test-'));

try {
  themeLoader.setUserDataDir(userDataDir);

  const features = featuresStore.readFeatures();
  assert(features.design && typeof features.design === 'object',
    'readFeatures renvoie la config livrée quand aucune surcharge utilisateur n\'existe');

  featuresStore.writeFeatures({ ...features, design: { ...features.design, activeTheme: 'claire' } });
  assert(fs.existsSync(path.join(userDataDir, 'features.json')),
    'writeFeatures écrit dans userData, pas dans le dossier de l\'app');
  assert(fs.readFileSync(BUILTIN_FEATURES, 'utf8') === builtinBefore,
    'config/features.json livré avec l\'app reste intact (lecture seule une fois packagé)');

  const merged = featuresStore.readFeatures();
  assert(merged.design.activeTheme === 'claire', 'la surcharge utilisateur l\'emporte à la lecture');
  assert(merged.broadcast && merged.broadcast.multiScene,
    'les clés absentes de la surcharge retombent sur la config livrée (fusion profonde)');

  // --- thèmes ------------------------------------------------------------
  assert(themeLoader.getActiveTheme().id === 'claire', 'getActiveTheme suit la surcharge utilisateur');

  themeLoader.setActiveTheme('nuit');
  assert(themeLoader.getActiveTheme().id === 'nuit', 'setActiveTheme fonctionne sans écrire dans l\'app');
  assert(fs.readFileSync(BUILTIN_FEATURES, 'utf8') === builtinBefore,
    'setActiveTheme n\'écrit pas dans config/features.json livré');

  themeLoader.duplicateTheme('nuit', '_test_user_theme', 'Thème utilisateur');
  assert(fs.existsSync(path.join(userDataDir, 'themes', '_test_user_theme.json')),
    'un thème créé par l\'utilisateur est écrit dans userData/themes');
  assert(!fs.existsSync(path.join(BUILTIN_THEMES, '_test_user_theme.json')),
    'aucun thème utilisateur n\'est écrit dans le dossier de l\'app');
  assert(themeLoader.listThemes().some((t) => t.id === '_test_user_theme'),
    'listThemes fusionne thèmes livrés et thèmes utilisateur');
  assert(themeLoader.listThemes().some((t) => t.id === 'nuit'), 'les thèmes livrés restent listés');

  themeLoader.setActiveTheme('_test_user_theme');
  assert(themeLoader.getActiveTheme().id === '_test_user_theme', 'un thème utilisateur peut devenir le thème actif');

  themeLoader.deleteTheme('_test_user_theme');
  assert(!themeLoader.listThemes().some((t) => t.id === '_test_user_theme'), 'deleteTheme retire le thème utilisateur');
  assert(themeLoader.getActiveTheme().id === 'nuit',
    'le thème actif retombe sur le thème par défaut si le thème choisi disparaît');
} finally {
  themeLoader.setUserDataDir(null);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.writeFileSync(BUILTIN_FEATURES, builtinBefore, 'utf8');
}

console.log('\n=== Tous les tests features-store OK ===');
