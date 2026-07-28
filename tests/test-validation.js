/**
 * ============================================================================
 *  test-validation.js — Tests pour le module de validation
 * ----------------------------------------------------------------------------
 *  Teste la validation des messages WebSocket et la sanitization
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const { validateMessage, validateAndSanitize, sanitizeText, SCHEMAS } = require('../validation');

console.log('=== Test Validation Module ===\n');

// Test 1: Validation de message showVerse valide
console.log('[TEST] Test 1: Validation showVerse valide...');
const validShowVerse = {
  action: 'showVerse',
  reference: 'Jean 3:16',
  text: 'Car Dieu a tant aimé le monde',
  durationMs: 300000
};
const result1 = validateMessage(validShowVerse);
assert.strictEqual(result1.valid, true, 'showVerse valide devrait passer');
assert.strictEqual(result1.error, null, 'Pas d\'erreur pour message valide');
console.log('[TEST] ✓ showVerse valide accepté');

// Test 2: Validation avec champ manquant
console.log('[TEST] Test 2: Validation avec champ manquant...');
const missingField = {
  action: 'showVerse',
  reference: 'Jean 3:16'
  // text manquant
};
const result2 = validateMessage(missingField);
assert.strictEqual(result2.valid, false, 'Champ manquant devrait rejeté');
assert(result2.error.includes('Champ requis manquant'), 'Erreur devrait mentionner champ manquant');
console.log('[TEST] ✓ Champ manquant détecté');

// Test 3: Validation avec action invalide
console.log('[TEST] Test 3: Validation avec action invalide...');
const invalidAction = {
  action: 'invalidAction',
  reference: 'Jean 3:16',
  text: 'Test'
};
const result3 = validateMessage(invalidAction);
assert.strictEqual(result3.valid, false, 'Action invalide devrait rejeté');
assert(result3.error.includes('Action inconnue'), 'Erreur devrait mentionner action inconnue');
console.log('[TEST] ✓ Action invalide détectée');

// Test 4: Validation de la longueur des champs
console.log('[TEST] Test 4: Validation de la longueur des champs...');
const tooLongText = {
  action: 'showVerse',
  reference: 'Jean 3:16',
  text: 'a'.repeat(5001), // Dépasse la limite de 5000
  durationMs: 300000
};
const result4 = validateMessage(tooLongText);
assert.strictEqual(result4.valid, false, 'Texte trop long devrait rejeté');
console.log('[TEST] ✓ Texte trop long détecté');

// Test 5: Validation de la durée maximale
console.log('[TEST] Test 5: Validation de la durée maximale...');
const tooLongDuration = {
  action: 'showVerse',
  reference: 'Jean 3:16',
  text: 'Test',
  durationMs: 3600001 // Dépasse 1 heure
};
const result5 = validateMessage(tooLongDuration);
assert.strictEqual(result5.valid, false, 'Durée trop longue devrait rejeté');
console.log('[TEST] ✓ Durée trop longue détectée');

// Test 6: Validation hideVerse
console.log('[TEST] Test 6: Validation hideVerse...');
const validHideVerse = { action: 'hideVerse' };
const result6 = validateMessage(validHideVerse);
assert.strictEqual(result6.valid, true, 'hideVerse valide devrait passer');
console.log('[TEST] ✓ hideVerse valide accepté');

// Test 7: Validation lookupReference
console.log('[TEST] Test 7: Validation lookupReference...');
const validLookup = {
  action: 'lookupReference',
  reference: 'Jean 3:16',
  durationMs: 300000
};
const result7 = validateMessage(validLookup);
assert.strictEqual(result7.valid, true, 'lookupReference valide devrait passer');
console.log('[TEST] ✓ lookupReference valide accepté');

// Test 8: Sanitization de texte
console.log('[TEST] Test 8: Sanitization de texte...');
const maliciousText = '<script>alert("xss")</script>';
const sanitized = sanitizeText(maliciousText);
assert(!sanitized.includes('<script>'), 'Balises script devraient être échappées');
assert(sanitized.includes('&lt;script&gt;'), 'Balises devraient être échappées');
console.log('[TEST] ✓ Texte malveillant sanitisé');

// Test 9: Validation et sanitization combinées
console.log('[TEST] Test 9: Validation et sanitization combinées...');
const messageWithXss = {
  action: 'showVerse',
  reference: 'Jean 3:16',
  text: '<script>alert("xss")</script> Car Dieu a tant aimé',
  durationMs: 300000
};
const result9 = validateAndSanitize(messageWithXss);
assert.strictEqual(result9.valid, true, 'Message avec XSS devrait être valide');
// Note: validateAndSanitize ne sanite pas le texte car overlay.html utilise textContent qui est sécurisé
// Le texte reste tel quel pour l'affichage correct dans l'overlay
assert.strictEqual(result9.sanitized.text, messageWithXss.text, 'Le texte devrait rester tel quel (textContent est sécurisé)');
console.log('[TEST] ✓ Validation et sanitization combinées réussies');

// Test 10: Champ non autorisé
console.log('[TEST] Test 10: Champ non autorisé...');
const unauthorizedField = {
  action: 'showVerse',
  reference: 'Jean 3:16',
  text: 'Test',
  durationMs: 300000,
  unauthorizedField: 'should not be here'
};
const result10 = validateMessage(unauthorizedField);
assert.strictEqual(result10.valid, false, 'Champ non autorisé devrait rejeté');
assert(result10.error.includes('Champ non autorisé'), 'Erreur devrait mentionner champ non autorisé');
console.log('[TEST] ✓ Champ non autorisé détecté');

// Test 11: Message non-objet
console.log('[TEST] Test 11: Message non-objet...');
const result11 = validateMessage("not an object");
assert.strictEqual(result11.valid, false, 'Non-objet devrait rejeté');
assert(result11.error.includes('objet'), 'Erreur devrait mentionner objet');
console.log('[TEST] ✓ Non-objet détecté');

// Test 12: Message null
console.log('[TEST] Test 12: Message null...');
const result12 = validateMessage(null);
assert.strictEqual(result12.valid, false, 'null devrait rejeté');
console.log('[TEST] ✓ null détecté');

// Test 13: Test des schémas disponibles
console.log('[TEST] Test 13: Vérification des schémas...');
assert(SCHEMAS.showVerse, 'Schéma showVerse devrait exister');
assert(SCHEMAS.hideVerse, 'Schéma hideVerse devrait exister');
assert(SCHEMAS.updateVerse, 'Schéma updateVerse devrait exister');
assert(SCHEMAS.lookupReference, 'Schéma lookupReference devrait exister');
console.log('[TEST] ✓ Tous les schémas requis sont présents');

console.log('\n=== Tests terminés ===');
console.log('[TEST] ✓ Tous les tests de validation sont passés');