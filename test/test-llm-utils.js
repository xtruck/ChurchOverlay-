'use strict';
/**
 * Tests unitaires pour llm-utils.js — extractResponseText().
 * Couvre : format standard chatCompletion, fallback string brute, objets
 * malformés (null/undefined/object), préservation whitespace trim.
 */
const assert = require('assert');
const { extractResponseText } = require('../llm-utils');

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

console.log('=== Tests llm-utils.js ===');

// Format standard chatCompletion ({text, model, usage})
check(
  'format standard — texte extrait et trimsé',
  extractResponseText({ text: '  Hello  ', model: 'm', usage: {} }) === 'Hello'
);

// Texte multiline avec espaces
check(
  'texte multiline — trim complet',
  extractResponseText({ text: '\n  Jean 14:6  \n', model: 'm', usage: {} }) === 'Jean 14:6'
);

// Fallback : réponse brute est une string (ancien format)
check('réponse brute string — trim', extractResponseText('  bonjour  ') === 'bonjour');

// Null / undefined → chaîne vide, pas de crash
check('null → chaîne vide', extractResponseText(null) === '');
check('undefined → chaîne vide', extractResponseText(undefined) === '');

// Objet sans clé text → chaîne vide
check('objet sans .text → chaîne vide', extractResponseText({ model: 'm' }) === '');

// Objet avec .text non-string → chaîne vide (garde-fou type)
check('.text number → chaîne vide', extractResponseText({ text: 42 }) === '');

// JSON.parse sur le résultat doit fonctionner (cas ai-theme-generator)
const jsonResult = extractResponseText({ text: '{"theme":"Foi"}', model: 'm', usage: {} });
check('résultat JSONisable (cas ai-theme-generator)', JSON.parse(jsonResult).theme === 'Foi');

console.log(`\n=== Résultat llm-utils : ${passed} passés, ${failed} échoués ===`);
process.exit(failed > 0 ? 1 : 0);
