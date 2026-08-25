'use strict';
/**
 * scripts/run-tests.js — exécute chaque fichier de test listé en argument
 * dans un process séparé, et CONTINUE après un échec.
 *
 * CORRECTIF : les scripts "test"/"test-all" de package.json enchaînaient
 * ~85 fichiers avec `&&` — le premier échec (même un artefact
 * d'environnement pré-existant, sans rapport avec un vrai changement de
 * code) arrêtait TOUTE la suite en silence. Aucun message "N tests non
 * exécutés", juste un exit code 1 après le dernier fichier qui a pu
 * tourner. Conséquence vérifiée en conditions réelles (voir
 * JOURNAL-MISSION.md, 2026-08-25) : plusieurs fichiers de test placés
 * après un échec connu (test-clip-exporter.js, ffmpeg indisponible dans ce
 * bac à sable) n'ont JAMAIS tourné pendant toute une session de travail,
 * sans qu'aucun signal ne le révèle — jusqu'à une vérification manuelle
 * fichier par fichier.
 *
 * Ce runner exécute TOUT, rapporte un résumé complet (réussis/échoués), et
 * ne quitte en erreur qu'à la toute fin — même contrat de code de sortie
 * qu'avant (0 si tout est vert, 1 sinon) pour ne rien casser côté CI.
 *
 * USAGE : node scripts/run-tests.js <fichier1.js> [fichier2.js...]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/run-tests.js <fichier1.js> [fichier2.js...]');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const results = [];

for (const file of files) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`▶ ${file}`);
  console.log('='.repeat(78));
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: ROOT });
  const ok = !res.error && res.status === 0;
  results.push({ file, ok, status: res.status, error: res.error });
}

const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok);

console.log(`\n${'='.repeat(78)}`);
console.log('RÉSUMÉ');
console.log('='.repeat(78));
console.log(`${passed.length}/${results.length} fichiers de test réussis.`);

if (failed.length > 0) {
  console.log(`\n${failed.length} échec(s) :`);
  for (const r of failed) {
    const detail = r.error
      ? ` — ${r.error.message}`
      : r.status != null
        ? ` (exit ${r.status})`
        : '';
    console.log(`  ✗ ${r.file}${detail}`);
  }
  process.exit(1);
}

process.exit(0);
