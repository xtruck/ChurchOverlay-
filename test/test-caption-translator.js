/**
 * ============================================================================
 *  test-caption-translator.js — Tests pour caption-translator.js
 * ----------------------------------------------------------------------------
 *  Le plus important ici : le garde-fou "jamais d'erreur remontée à
 *  l'appelant" (timeout/429/réseau -> null, jamais une exception qui
 *  pourrait remonter jusqu'au pipeline de détection dans server.js). Même
 *  approche que test-sermon-qa.js (injectFakeModule pour mocker
 *  groq-wrapper.js AVANT de requérir le module testé).
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

console.log('=== Test Caption Translator ===\n');

let chatCompletionCalls = [];
let chatCompletionBehavior = async (prompt) => ({
  text: 'Translated: ' + prompt.slice(0, 20),
  model: 'fake',
  usage: {},
});

injectFakeModule('groq-wrapper.js', {
  chatCompletion: async (prompt, options) => {
    chatCompletionCalls.push({ prompt, options });
    return chatCompletionBehavior(prompt, options);
  },
});

const captionTranslator = require('../caption-translator');

(async () => {
  // Test 1 : texte vide -> null immédiat, aucun appel LLM.
  console.log('[TEST] Test 1: translateCaption() avec un texte vide...');
  chatCompletionCalls = [];
  const emptyResult = await captionTranslator.translateCaption('   ', 'en', { skipThrottle: true });
  assert.strictEqual(emptyResult, null);
  assert.strictEqual(chatCompletionCalls.length, 0, 'un texte vide ne doit jamais appeler le LLM');
  console.log('[TEST] ✓ Texte vide géré sans appel LLM\n');

  // Test 2 : traduction réussie -> texte renvoyé, prompt contient la langue cible.
  console.log('[TEST] Test 2: translateCaption() traduction réussie...');
  chatCompletionCalls = [];
  chatCompletionBehavior = async () => ({ text: 'God so loved the world', model: 'fake', usage: {} });
  const result = await captionTranslator.translateCaption('Dieu a tant aimé le monde', 'en', {
    skipThrottle: true,
  });
  assert.strictEqual(result, 'God so loved the world');
  assert.strictEqual(chatCompletionCalls.length, 1);
  assert(chatCompletionCalls[0].prompt.includes('English'), 'le prompt doit nommer la langue cible');
  assert(
    chatCompletionCalls[0].prompt.includes('Dieu a tant aimé le monde'),
    'le prompt doit inclure le texte source'
  );
  console.log('[TEST] ✓ Traduction renvoyée correctement\n');

  // Test 3 (LE PLUS IMPORTANT) : le garde-fou — chatCompletion() qui lève
  // (timeout/429/réseau) ne doit JAMAIS remonter d'exception à l'appelant.
  console.log('[TEST] Test 3: échec LLM -> null, jamais d’exception (garde-fou)...');
  chatCompletionBehavior = async () => {
    throw new Error('Rate limit Groq atteint — réessayez dans quelques secondes.');
  };
  let threw = false;
  let failResult;
  try {
    failResult = await captionTranslator.translateCaption('Une phrase quelconque', 'en', {
      skipThrottle: true,
    });
  } catch (_e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'translateCaption() ne doit jamais lever, même si le LLM échoue');
  assert.strictEqual(failResult, null, 'un échec LLM doit renvoyer null');
  console.log('[TEST] ✓ Échec LLM absorbé proprement, aucune exception\n');

  // Test 4 : réponse LLM vide/blanche -> null (pas une chaîne vide affichée).
  console.log('[TEST] Test 4: réponse LLM vide -> null...');
  chatCompletionBehavior = async () => ({ text: '   ', model: 'fake', usage: {} });
  const blankResult = await captionTranslator.translateCaption('Texte source', 'en', {
    skipThrottle: true,
  });
  assert.strictEqual(blankResult, null);
  console.log('[TEST] ✓ Réponse vide traitée comme absence de traduction\n');

  // Test 5 : throttle — deux appels rapprochés, le second est ignoré (renvoie
  // null sans même appeler le LLM), protège le quota gratuit partagé.
  console.log('[TEST] Test 5: throttle anti-rafale...');
  captionTranslator.resetThrottle();
  chatCompletionCalls = [];
  chatCompletionBehavior = async () => ({ text: 'OK', model: 'fake', usage: {} });
  const first = await captionTranslator.translateCaption('Premier segment', 'en');
  const second = await captionTranslator.translateCaption('Deuxième segment, juste après', 'en');
  assert.strictEqual(first, 'OK', 'le premier appel doit passer');
  assert.strictEqual(second, null, 'un second appel immédiat doit être throttlé');
  assert.strictEqual(chatCompletionCalls.length, 1, 'le LLM ne doit être appelé qu’une seule fois');
  console.log('[TEST] ✓ Rafale de segments rapprochés throttlée correctement\n');

  console.log('=== Tous les tests caption-translator sont passés ===');
})().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
