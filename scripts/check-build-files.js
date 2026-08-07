/**
 * ============================================================================
 *  scripts/check-build-files.js — Garde-fou anti-régression de packaging
 * ----------------------------------------------------------------------------
 *  POURQUOI CE SCRIPT EXISTE :
 *  Le bug du "listeur audio qui ne fonctionne pas" a révélé une classe de
 *  bug plus large et silencieuse : `package.json` a une LISTE BLANCHE
 *  explicite des fichiers inclus dans le .exe packagé (champ build.files).
 *  Un développeur peut créer un nouveau fichier .js, faire un `require()`
 *  dessus depuis main.js, tester en local avec `npm start` (qui fonctionne,
 *  car aucun filtre n'est appliqué en dev) — et pousser en production sans
 *  jamais s'apercevoir que le .exe final plante au lancement
 *  ("Cannot find module"), car la liste blanche n'a pas été mise à jour.
 *
 *  CE QUE FAIT CE SCRIPT :
 *  1. Part de main.js (et server.js) et suit récursivement tous les
 *     require('./xxx') locaux (pas les paquets npm).
 *  2. Vérifie que chaque fichier local ainsi découvert est bien couvert par
 *     la liste build.files de package.json (correspondance exacte ou glob).
 *  3. Si un fichier requis manque à l'appel → le script échoue (exit 1)
 *     avec un message explicite. Branché en CI, ça bloque le merge/build
 *     AVANT que ça devienne un .exe cassé livré à un utilisateur.
 *
 *  USAGE :
 *    node scripts/check-build-files.js
 *  (intégré aussi à `npm run check-files` et à la CI GitHub Actions)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY_POINTS = ['main.js', 'server.js'];

function readPackageJson() {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

// Convertit une entrée de build.files (peut être un glob simple type
// "ffmpeg/**/*" ou un nom exact "main.js") en RegExp de correspondance.
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function isFileWhitelisted(relPath, filesList) {
  const normalized = relPath.replace(/\\/g, '/');
  return filesList.some((pattern) => {
    if (pattern.startsWith('!')) return false; // exclusions gérées séparément
    return globToRegExp(pattern).test(normalized);
  });
}

// Suit récursivement les require('./xxx') ou require("../xxx") locaux
// (analyse statique simple par regex — suffisant pour ce projet, pas de
// require() dynamiques construits par concaténation de variables ici).
//
// CORRECTIF AUDIT — un fichier require() par le code mais absent du disque
// n'est PLUS un simple avertissement ignoré : il est collecté dans
// `missingOnDisk` et fait échouer le script (voir main()). L'ancien
// comportement ("avertissement, ignoré") a laissé passer sans broncher le
// cas de setup-ffmpeg.js/dshow-parser.js — deux fichiers require()'d par
// main.js mais supprimés du dépôt — alors que ce script existe précisément
// pour intercepter ce genre de régression. Un fichier manquant sur disque
// est même PIRE qu'un fichier manquant de build.files : ça casse aussi
// `npm start` en dev, pas seulement le .exe packagé.
function findLocalRequires(
  filePath,
  seen = new Set(),
  result = new Set(),
  missingOnDisk = new Set()
) {
  const relFromRoot = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (seen.has(relFromRoot)) return { result, missingOnDisk };
  seen.add(relFromRoot);

  if (!fs.existsSync(filePath)) {
    missingOnDisk.add(relFromRoot);
    return { result, missingOnDisk };
  }

  result.add(relFromRoot);

  const content = fs.readFileSync(filePath, 'utf8');
  const requireRegex = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = requireRegex.exec(content)) !== null) {
    let resolved = path.resolve(path.dirname(filePath), match[1]);
    if (!path.extname(resolved)) resolved += '.js';
    findLocalRequires(resolved, seen, result, missingOnDisk);
  }

  return { result, missingOnDisk };
}

function main() {
  const pkg = readPackageJson();
  const filesList = (pkg.build && pkg.build.files) || [];

  if (filesList.length === 0) {
    console.error('✗ package.json ne définit aucun champ build.files — impossible de vérifier.');
    process.exit(1);
  }

  console.log('=== Vérification de la liste blanche de packaging (build.files) ===\n');

  const allRequired = new Set();
  const allMissingOnDisk = new Set();
  for (const entry of ENTRY_POINTS) {
    console.log(`Analyse depuis : ${entry}`);
    const { result, missingOnDisk } = findLocalRequires(path.join(ROOT, entry));
    result.forEach((f) => allRequired.add(f));
    missingOnDisk.forEach((f) => allMissingOnDisk.add(f));
  }

  if (allMissingOnDisk.size > 0) {
    console.error('\n✗ ÉCHEC — les fichiers suivants sont require() par le code');
    console.error("  (main.js/server.js ou l'un de leurs require() locaux) mais");
    console.error("  ABSENTS DU DISQUE. L'app plante au lancement (MODULE_NOT_FOUND),");
    console.error('  y compris en dev (npm start), pas seulement une fois packagée :\n');
    allMissingOnDisk.forEach((f) => console.error(`    - ${f}`));
    console.error('\n  Corrige en restaurant ce(s) fichier(s) ou en retirant le(s) require()');
    console.error('  correspondant(s) si la fonctionnalité a été volontairement supprimée.');
    process.exit(1);
  }

  const missing = [];
  for (const relPath of allRequired) {
    if (!isFileWhitelisted(relPath, filesList)) {
      missing.push(relPath);
    }
  }

  console.log(`\n${allRequired.size} fichier(s) local(-aux) requis détecté(s) au total.\n`);

  if (missing.length > 0) {
    console.error('✗ ÉCHEC — les fichiers suivants sont require() depuis main.js/server.js');
    console.error('  mais ABSENTS de build.files dans package.json.');
    console.error('  Le .exe packagé plantera au lancement sans eux :\n');
    missing.forEach((f) => console.error(`    - ${f}`));
    console.error('\n  Corrige en ajoutant ces entrées au tableau "build.files" de package.json.');
    process.exit(1);
  }

  console.log('✓ Tous les fichiers requis localement sont bien couverts par build.files.');
  console.log('  Le .exe packagé devrait pouvoir tous les charger.');
  process.exit(0);
}

main();
