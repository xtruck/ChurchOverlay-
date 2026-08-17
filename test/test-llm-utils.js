'use strict';
/**
 * Tests unitaires pour llm-utils.js — extractResponseText() et extractJsonObject().
 * Couvre : format standard chatCompletion, fallback string brute, objets
 * malformés (null/undefined/object), préservation whitespace trim.
 * extractJsonObject : JSON pur, bloc markdown, objet dans du texte, tableau,
 * texte sans JSON, null/undefined.
 */
const assert = require('assert');
const { extractResponseText, extractJsonObject } = require('../llm-utils');

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

// ---- extractJsonObject ----
console.log('\n--- extractJsonObject ---');

// JSON pur (réponse json_mode Groq)
check('JSON pur — parsé', extractJsonObject('{"theme":"Foi"}').theme === 'Foi');

// JSON pur avec trim
check('JSON pur avec espaces — parsé', extractJsonObject('  {"theme":"Foi"}  ').theme === 'Foi');

// Bloc markdown ```json
check(
  'bloc markdown — extrait',
  extractJsonObject('Voici le résultat:\n```json\n{"theme":"Foi"}\n```\nFin.').theme === 'Foi'
);

// Bloc markdown sans langue
check(
  'bloc markdown sans langue — extrait',
  extractJsonObject('```{"theme":"Foi"}\n```').theme === 'Foi'
);

// Objet dans du texte libre
check(
  'objet dans du texte — extrait',
  extractJsonObject('Le thème détecté est {"theme":"Grâce","keywords":["foi"]}. Merci.').theme ===
    'Grâce'
);

// Tableau JSON dans du texte
check(
  'tableau dans du texte — extrait',
  extractJsonObject('Voici les refs:\n[{"ref":"Jean 3:16","reason":"Amour"}]').length === 1
);

// Tableau JSON pur
check('tableau JSON pur — parsé', extractJsonObject('[{"ref":"Jean 3:16"}]').length === 1);

// null / undefined → null
check('extractJsonObject(null) → null', extractJsonObject(null) === null);
check('extractJsonObject(undefined) → null', extractJsonObject(undefined) === null);

// Texte sans JSON
check('texte sans JSON → null', extractJsonObject('Bonjour, pas de JSON ici.') === null);

// JSON malformé
check('JSON malformé → null', extractJsonObject('```json\n{invalid}\n```') === null);

console.log(`\n=== Résultat llm-utils : ${passed} passés, ${failed} échoués ===`);
process.exit(failed > 0 ? 1 : 0);
