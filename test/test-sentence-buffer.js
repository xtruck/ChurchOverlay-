/**
 * ============================================================================
 *  test-sentence-buffer.js — Tests pour sentence-buffer.js
 * ----------------------------------------------------------------------------
 *  Couvre le comportement attendu (accumulation glissante entre segments,
 *  reset par timeout de silence) et, en particulier, la RÉGRESSION que ce
 *  module corrige : server.js appelait resetBuffer() à chaque segment via
 *  une condition toujours vraie, annulant toute accumulation. Le Test 2
 *  ci-dessous échouerait avec l'ancien comportement (buffer jamais
 *  accumulé) et passe avec le nouveau.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const { createSentenceBuffer } = require('../sentence-buffer');

console.log('=== Test Sentence Buffer ===\n');

// Test 1 : un seul push retourne bien le texte.
console.log('[TEST] Test 1: push unique...');
{
  const buf = createSentenceBuffer();
  const result = buf.push('Jean chapitre 3', 1000);
  assert.strictEqual(result, 'Jean chapitre 3');
  console.log('[TEST] ✓ OK\n');
}

// Test 2 : deux segments rapprochés dans le temps s'accumulent (LE BUG
// CORRIGÉ — c'est ce comportement qui manquait avant l'extraction).
console.log('[TEST] Test 2: accumulation entre deux segments rapprochés...');
{
  const buf = createSentenceBuffer({ gapMs: 4000 });
  buf.push('Jean', 1000);
  const result = buf.push('chapitre 3, verset 16', 1500); // 500ms plus tard, sous le gap
  assert.strictEqual(
    result,
    'Jean chapitre 3, verset 16',
    'Les deux segments auraient dû être concaténés dans une seule fenêtre'
  );
  console.log('[TEST] ✓ OK — référence recomposée sur deux segments:', result, '\n');
}

// Test 3 : un silence prolongé (> gapMs) entre deux segments déclenche un
// reset — on ne mélange pas deux phrases sans rapport.
console.log('[TEST] Test 3: reset après un silence prolongé...');
{
  const buf = createSentenceBuffer({ gapMs: 4000 });
  buf.push('Jean chapitre 3', 1000);
  const result = buf.push('Amen.', 10000); // 9s plus tard, au-delà du gap
  assert.strictEqual(result, 'Amen.', 'Le buffer aurait dû être vidé avant ce push');
  console.log('[TEST] ✓ OK — buffer réinitialisé après le silence\n');
}

// Test 4 : la fenêtre est bornée en caractères (maxChars).
console.log('[TEST] Test 4: fenêtre bornée en caractères...');
{
  const buf = createSentenceBuffer({ maxChars: 20, gapMs: 60000 });
  buf.push('a'.repeat(15), 1000);
  const result = buf.push('b'.repeat(15), 1100);
  assert(result.length <= 20 + 1, 'Le buffer ne devrait pas dépasser significativement maxChars');
  console.log('[TEST] ✓ OK — longueur finale:', result.length, '\n');
}

// Test 5 : reset() manuel vide le buffer immédiatement.
console.log('[TEST] Test 5: reset() manuel...');
{
  const buf = createSentenceBuffer();
  buf.push('Jean 3', 1000);
  buf.reset();
  assert.strictEqual(buf.value(), '');
  const result = buf.push('Romains 8', 1050); // juste après, mais buffer déjà vidé
  assert.strictEqual(result, 'Romains 8');
  console.log('[TEST] ✓ OK\n');
}

console.log('=== Tous les tests sentence-buffer sont passés ===');
