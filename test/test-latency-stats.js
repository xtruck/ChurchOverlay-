/**
 * test-latency-stats.js — Tests pour latency-stats.js
 */
'use strict';
const assert = require('assert');
const latencyStats = require('../latency-stats');

console.log('=== Test Latency Stats ===\n');

function marksFor(partial) {
  // Un objet {name: at} pratique à écrire dans les tests -> le format
  // Array<{name, at}> attendu par recordFromMarks (voir tracker.summary()).
  return Object.entries(partial).map(([name, at]) => ({ name, at }));
}

function run() {
  latencyStats._reset();

  console.log('[TEST] Test 1: aucune donnée -> count 0, p50/p95 null...');
  {
    const stats = latencyStats.getStats();
    assert.strictEqual(stats.sttFirstToken.count, 0);
    assert.strictEqual(stats.sttFirstToken.p50, null);
    assert.strictEqual(stats.verseDetectedToOverlay.count, 0);
  }
  console.log('[TEST] ✓ état initial vide géré\n');

  console.log('[TEST] Test 2: marques complètes -> les deux métriques progressent...');
  {
    latencyStats.recordFromMarks(
      marksFor({ start: 0, vad: 0, asrFirstPartial: 120, scripture: 400, bible: 420, obs: 430 })
    );
    const stats = latencyStats.getStats();
    assert.strictEqual(stats.sttFirstToken.count, 1);
    assert.strictEqual(stats.sttFirstToken.p50, 120);
    assert.strictEqual(stats.verseDetectedToOverlay.count, 1);
    assert.strictEqual(stats.verseDetectedToOverlay.p50, 30);
  }
  console.log('[TEST] ✓ deltas calculés à partir des bonnes paires de marques\n');

  console.log(
    '[TEST] Test 3: marques partielles (pas de asrFirstPartial, ex. STT batch pur) -> jamais de valeur fabriquée...'
  );
  {
    latencyStats._reset();
    latencyStats.recordFromMarks(marksFor({ start: 0, vad: 0, asrFinal: 500, scripture: 520 }));
    const stats = latencyStats.getStats();
    assert.strictEqual(
      stats.sttFirstToken.count,
      0,
      'sans asrFirstPartial, sttFirstToken ne doit recevoir aucun échantillon'
    );
    assert.strictEqual(
      stats.verseDetectedToOverlay.count,
      0,
      "sans mark 'obs', verseDetectedToOverlay ne doit recevoir aucun échantillon"
    );
  }
  console.log('[TEST] ✓ métriques non mesurables restent à 0, jamais inventées\n');

  console.log('[TEST] Test 4: p50/p95 calculés sur plusieurs échantillons...');
  {
    latencyStats._reset();
    const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    for (const ms of samples) {
      latencyStats.recordFromMarks(marksFor({ vad: 0, asrFirstPartial: ms }));
    }
    const stats = latencyStats.getStats();
    assert.strictEqual(stats.sttFirstToken.count, 10);
    assert.strictEqual(
      stats.sttFirstToken.p50,
      600,
      `p50 attendu 600, obtenu ${stats.sttFirstToken.p50}`
    );
    assert.strictEqual(
      stats.sttFirstToken.p95,
      1000,
      `p95 attendu 1000, obtenu ${stats.sttFirstToken.p95}`
    );
  }
  console.log('[TEST] ✓ percentiles cohérents sur un échantillon connu\n');

  console.log('[TEST] Test 5: ring buffer borné (RING_SIZE) — pas de fuite mémoire...');
  {
    latencyStats._reset();
    for (let i = 0; i < latencyStats.RING_SIZE + 50; i++) {
      latencyStats.recordFromMarks(marksFor({ vad: 0, asrFirstPartial: i }));
    }
    const stats = latencyStats.getStats();
    assert.strictEqual(stats.sttFirstToken.count, latencyStats.RING_SIZE);
  }
  console.log('[TEST] ✓ le ring buffer plafonne bien à RING_SIZE échantillons\n');

  console.log('[TEST] Test 6: formatStats() produit un gabarit [PERF-STATS] lisible...');
  {
    latencyStats._reset();
    latencyStats.recordFromMarks(marksFor({ vad: 0, asrFirstPartial: 150 }));
    const formatted = latencyStats.formatStats();
    assert(formatted.startsWith('[PERF-STATS]'), 'doit commencer par [PERF-STATS]');
    assert(formatted.includes('sttFirstToken'), 'doit mentionner sttFirstToken');
    assert(formatted.includes('verseDetectedToOverlay'), 'doit mentionner verseDetectedToOverlay');
    assert(
      formatted.includes('(pas encore de donnée)'),
      'verseDetectedToOverlay sans échantillon doit le dire explicitement'
    );
  }
  console.log('[TEST] ✓ format lisible et honnête sur les métriques non mesurées\n');

  console.log('=== Tous les tests latency-stats sont passés ===');
}

run();
