'use strict';
/**
 * Tests unitaires pour le chantier A.6 — @electron/rebuild + postinstall.
 *
 * Vérifie :
 * 1. @electron/rebuild est en devDependencies
 * 2. Le script postinstall est défini et contient @electron/rebuild
 * 3. La dépendance est installée dans node_modules
 * 4. Le binaire electron-rebuild est accessible via npx
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

console.log('=== Tests A.6 — @electron/rebuild + postinstall ===');

// 1. Lire package.json
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// 2. @electron/rebuild dans devDependencies
check(
  '@electron/rebuild présent dans devDependencies',
  pkg.devDependencies && pkg.devDependencies['@electron/rebuild'] !== undefined
);

check(
  '@electron/rebuild version commence par ^4',
  pkg.devDependencies &&
    pkg.devDependencies['@electron/rebuild'] &&
    pkg.devDependencies['@electron/rebuild'].startsWith('^4')
);

// 3. Script postinstall défini
check(
  'script postinstall défini',
  typeof pkg.scripts === 'object' && typeof pkg.scripts.postinstall === 'string'
);

check(
  'postinstall contient @electron/rebuild',
  pkg.scripts && pkg.scripts.postinstall && pkg.scripts.postinstall.includes('@electron/rebuild')
);

// 4. Le module est installé dans node_modules
const rebuildPkgPath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@electron',
  'rebuild',
  'package.json'
);
const rebuildExists = fs.existsSync(rebuildPkgPath);
check('@electron/rebuild installé dans node_modules', rebuildExists);

// 5. build.files contient les modules natifs critiques
const buildFiles = pkg.build && pkg.build.files;
check(
  'build.files contient better-sqlite3',
  Array.isArray(buildFiles) && buildFiles.some((f) => f.includes('better-sqlite3'))
);

// 6. better-sqlite3 est dans dependencies (pas seulement devDependencies)
check(
  'better-sqlite3 dans dependencies (module natif)',
  pkg.dependencies && pkg.dependencies['better-sqlite3'] !== undefined
);

console.log(`\n=== Résultat A.6 : ${passed} passés, ${failed} échoués ===`);
process.exit(failed > 0 ? 1 : 0);
