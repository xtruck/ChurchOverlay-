/**
 * ============================================================================
 *  test-highlight-export.js — Tests pour highlight-export.js
 * ----------------------------------------------------------------------------
 *  Module pur, aucun mock nécessaire (contrairement à test-caption-translator.js
 *  ou test-sermon-qa.js) : uniquement de la mise en forme sur des tableaux
 *  en mémoire, au format renvoyé par sessionStore.getVerseHistorySince()
 *  (colonnes SQL brutes : reference, shown_at, ...).
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const highlightExport = require('../highlight-export');

console.log('=== Test Highlight Export ===\n');

const SESSION_START = 1_000_000_000_000; // epoch ms arbitraire, lisible dans les diffs

// Test 1 : formatTimestamp() — mm:ss sous l'heure, h:mm:ss au-delà.
console.log('[TEST] Test 1: formatTimestamp()...');
assert.strictEqual(highlightExport.formatTimestamp(0), '0:00');
assert.strictEqual(highlightExport.formatTimestamp(65_000), '1:05');
assert.strictEqual(highlightExport.formatTimestamp(3_661_000), '1:01:01');
assert.strictEqual(highlightExport.formatTimestamp(-500), '0:00', 'jamais de temps négatif');
console.log('[TEST] ✓ Formats mm:ss / h:mm:ss corrects\n');

// Test 2 : buildYoutubeChapters() — cas simple, trié, premier chapitre à 0:00.
console.log('[TEST] Test 2: buildYoutubeChapters() — cas simple...');
{
  const entries = [
    { reference: 'Romains 8:28', shown_at: SESSION_START + 600_000 },
    { reference: 'Jean 3:16', shown_at: SESSION_START + 30_000 },
  ];
  const result = highlightExport.buildYoutubeChapters(entries, SESSION_START);
  const lines = result.split('\n');
  assert.strictEqual(lines.length, 3, 'entrée "Début du culte" ajoutée + 2 temps forts');
  assert.strictEqual(lines[0], '0:00 Début du culte');
  assert.strictEqual(lines[1], '0:30 Jean 3:16', 'trié par ordre chronologique, pas ordre d’entrée');
  assert.strictEqual(lines[2], '10:00 Romains 8:28');
}
console.log('[TEST] ✓ Chapitres triés chronologiquement, 0:00 forcé en tête\n');

// Test 3 : buildYoutubeChapters() — pas de "Début du culte" ajouté si le
// premier temps fort est déjà à 0:00.
console.log('[TEST] Test 3: buildYoutubeChapters() — premier temps fort déjà à 0:00...');
{
  const entries = [{ reference: 'Ouverture', shown_at: SESSION_START }];
  const result = highlightExport.buildYoutubeChapters(entries, SESSION_START);
  assert.strictEqual(result, '0:00 Ouverture');
}
console.log('[TEST] ✓ Pas de doublon "0:00" quand déjà présent\n');

// Test 4 : buildYoutubeChapters() — deux temps forts à moins de 10s
// d'écart sont fusionnés (le second ignoré), conformément aux règles
// YouTube (chapitres trop rapprochés rejetés).
console.log('[TEST] Test 4: buildYoutubeChapters() — filtre anti-rapprochement (10s)...');
{
  const entries = [
    { reference: 'Verset A', shown_at: SESSION_START + 5_000 },
    { reference: 'Verset B (trop proche)', shown_at: SESSION_START + 8_000 },
    { reference: 'Verset C', shown_at: SESSION_START + 25_000 },
  ];
  const result = highlightExport.buildYoutubeChapters(entries, SESSION_START);
  assert(!result.includes('Verset B'), 'un temps fort à moins de 10s du précédent doit être filtré');
  assert(result.includes('Verset A'));
  assert(result.includes('Verset C'));
}
console.log('[TEST] ✓ Temps forts trop rapprochés filtrés\n');

// Test 5 : buildYoutubeChapters() — entrées avant le début du culte ignorées,
// tableau vide -> chaîne vide.
console.log('[TEST] Test 5: buildYoutubeChapters() — cas limites...');
{
  const beforeStart = [{ reference: 'Avant le culte', shown_at: SESSION_START - 10_000 }];
  assert.strictEqual(highlightExport.buildYoutubeChapters(beforeStart, SESSION_START), '');
  assert.strictEqual(highlightExport.buildYoutubeChapters([], SESSION_START), '');
  assert.strictEqual(highlightExport.buildYoutubeChapters(null, SESSION_START), '');
}
console.log('[TEST] ✓ Cas limites gérés sans erreur\n');

// Test 6 : buildCsv() — en-tête toujours présent, une ligne par entrée,
// pas de filtre "10s minimum" (contrairement aux chapitres YouTube).
console.log('[TEST] Test 6: buildCsv()...');
{
  const entries = [
    { reference: 'Jean 3:16', shown_at: SESSION_START + 30_000 },
    { reference: 'Verset, avec virgule', shown_at: SESSION_START + 32_000 },
  ];
  const csv = highlightExport.buildCsv(entries, SESSION_START);
  const rows = csv.split('\n');
  assert.strictEqual(rows[0], 'shown_at_epoch_ms,timestamp,label');
  assert.strictEqual(rows.length, 3, 'les deux entrées doivent apparaître malgré le faible écart');
  assert(rows[2].includes('"Verset, avec virgule"'), 'une virgule dans le libellé doit être échappée');
}
console.log('[TEST] ✓ Export CSV correct, virgules échappées\n');

// Test 7 : buildCsv() sans entrée -> uniquement l'en-tête, jamais d'erreur.
console.log('[TEST] Test 7: buildCsv() sans entrée...');
assert.strictEqual(highlightExport.buildCsv([], SESSION_START), 'shown_at_epoch_ms,timestamp,label');
assert.strictEqual(
  highlightExport.buildCsv(null, SESSION_START),
  'shown_at_epoch_ms,timestamp,label'
);
console.log('[TEST] ✓ Tableau vide/absent géré proprement\n');

console.log('=== Tous les tests highlight-export sont passés ===');
