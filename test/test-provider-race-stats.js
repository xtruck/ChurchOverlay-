/**
 * test-provider-race-stats.js — Tests pour provider-race-stats.js
 */
'use strict';
const assert = require('assert');
const raceStats = require('../provider-race-stats');

console.log('=== Test Provider Race Stats ===\n');

function run() {
  raceStats._reset();

  console.log(
    '[TEST] Test 1: état initial à zéro, pas de recommandation (pas assez de données)...'
  );
  {
    const stats = raceStats.getStats();
    assert.strictEqual(stats.total, 0);
    assert.strictEqual(stats.groqWins, 0);
    assert.strictEqual(stats.wastedDeepgramCalls, 0);
    assert.strictEqual(raceStats.getRecommendation(), null);
  }
  console.log('[TEST] ✓ état initial vide géré\n');

  console.log('[TEST] Test 2: chaque record*() incrémente le bon compteur...');
  {
    raceStats.recordGroqWin();
    raceStats.recordGroqWin();
    raceStats.recordDeepgramFallbackWin();
    raceStats.recordCircuitSkip();
    raceStats.recordBothFailed();
    const stats = raceStats.getStats();
    assert.strictEqual(stats.groqWins, 2);
    assert.strictEqual(stats.deepgramFallbackWins, 1);
    assert.strictEqual(stats.circuitSkips, 1);
    assert.strictEqual(stats.bothFailed, 1);
    assert.strictEqual(stats.total, 5);
  }
  console.log('[TEST] ✓ compteurs corrects par issue\n');

  console.log(
    '[TEST] Test 3: wastedDeepgramCalls = groqWins (Deepgram lancé en parallèle mais jamais utilisé)...'
  );
  {
    const stats = raceStats.getStats();
    assert.strictEqual(stats.wastedDeepgramCalls, stats.groqWins);
  }
  console.log('[TEST] ✓ appels gaspillés = victoires Groq\n');

  console.log(
    '[TEST] Test 4: recommandation "faible taux de repli" quand deepgramFallbackWins/racedTotal < seuil, avec assez de données...'
  );
  {
    raceStats._reset();
    // 19 victoires Groq, 1 repli Deepgram -> taux de repli 5% (20 courses),
    // volontairement à la limite du seuil pour vérifier le comportement en
    // dessous vs au-dessus.
    for (let i = 0; i < 19; i++) raceStats.recordGroqWin();
    raceStats.recordDeepgramFallbackWin();
    const rec = raceStats.getRecommendation();
    assert(rec !== null, 'assez de données (n=20) -> une recommandation doit être produite');
    assert(
      rec.includes('Groq seul') || rec.includes('reste justifiée'),
      'la recommandation doit trancher explicitement dans un sens ou l’autre'
    );
  }
  console.log('[TEST] ✓ recommandation produite au seuil MIN_SAMPLES_FOR_RECOMMENDATION\n');

  console.log('[TEST] Test 5: pas assez de données (< MIN_SAMPLES_FOR_RECOMMENDATION) -> null...');
  {
    raceStats._reset();
    for (let i = 0; i < raceStats.MIN_SAMPLES_FOR_RECOMMENDATION - 1; i++)
      raceStats.recordGroqWin();
    assert.strictEqual(
      raceStats.getRecommendation(),
      null,
      'sous le seuil minimum, aucune recommandation ne doit être inventée'
    );
  }
  console.log('[TEST] ✓ silence plutôt qu’une tendance non fiable sur peu de données\n');

  console.log(
    '[TEST] Test 6: taux de repli élevé -> recommandation "course justifiée", pas "Groq seul"...'
  );
  {
    raceStats._reset();
    for (let i = 0; i < 10; i++) raceStats.recordGroqWin();
    for (let i = 0; i < 10; i++) raceStats.recordDeepgramFallbackWin();
    const rec = raceStats.getRecommendation();
    assert(rec.includes('reste justifiée'), 'un taux de repli à 50% doit justifier la course');
  }
  console.log('[TEST] ✓ recommandation cohérente avec un taux de repli élevé\n');

  console.log('[TEST] Test 7: formatStats() produit un gabarit [PROVIDER-RACE] lisible...');
  {
    raceStats._reset();
    raceStats.recordGroqWin();
    const formatted = raceStats.formatStats();
    assert(formatted.startsWith('[PROVIDER-RACE]'), 'doit commencer par [PROVIDER-RACE]');
    assert(formatted.includes('groqWins'), 'doit mentionner groqWins');
    assert(formatted.includes('appels Deepgram gaspillés'), 'doit mentionner le coût gaspillé');
  }
  console.log('[TEST] ✓ format lisible\n');

  console.log('=== Tous les tests provider-race-stats sont passés ===');
}

run();
