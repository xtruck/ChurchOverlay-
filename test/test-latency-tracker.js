/**
 * test-latency-tracker.js — Tests pour latency-tracker.js
 */
'use strict';
const assert = require('assert');
const { startTracker } = require('../latency-tracker');

console.log('=== Test Latency Tracker ===\n');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('[TEST] Test 1: marks successifs produisent des deltas positifs...');
  const t = startTracker();
  await sleep(20);
  t.mark('vad');
  await sleep(15);
  t.mark('asrFinal');
  await sleep(5);
  t.mark('scripture');
  const { deltas, totalMs, marks } = t.summary();
  assert.strictEqual(marks.length, 4, 'start + 3 marks = 4 points');
  assert(deltas.vad >= 15, `deltas.vad devrait être >= ~20ms (obtenu ${deltas.vad})`);
  assert(
    deltas.asrFinal >= 10,
    `deltas.asrFinal devrait être >= ~15ms (obtenu ${deltas.asrFinal})`
  );
  assert(deltas.scripture >= 0, 'deltas.scripture doit être positif ou nul');
  assert(
    totalMs >= deltas.vad + deltas.asrFinal + deltas.scripture - 5,
    'totalMs doit être la somme des deltas'
  );
  console.log(`[TEST] ✓ deltas cohérents (total ${totalMs}ms)\n`);

  console.log('[TEST] Test 2: format() produit le gabarit [PERF] attendu...');
  const formatted = t.format();
  assert(formatted.startsWith('[PERF]'), 'doit commencer par [PERF]');
  assert(formatted.includes('vad:'), 'doit contenir la ligne vad');
  assert(formatted.includes('TOTAL:'), 'doit contenir la ligne TOTAL');
  console.log('[TEST] ✓ Format correct\n');

  console.log('[TEST] Test 3: aucun mark() posé => summary() ne plante pas, totalMs = 0...');
  const empty = startTracker();
  const emptySummary = empty.summary();
  assert.strictEqual(emptySummary.totalMs, 0);
  assert.deepStrictEqual(emptySummary.deltas, {});
  console.log('[TEST] ✓ Cas vide géré\n');

  console.log('[TEST] Test 4: startedAt explicite est respecté (pas Date.now() implicite)...');
  const fixedStart = Date.now() - 1000;
  const withStart = startTracker(fixedStart);
  withStart.mark('vad');
  const s = withStart.summary();
  assert(
    s.deltas.vad >= 990,
    `le delta doit refléter le startedAt fourni (obtenu ${s.deltas.vad})`
  );
  console.log('[TEST] ✓ startedAt respecté\n');

  console.log('\n=== Tous les tests latency-tracker sont passés ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
