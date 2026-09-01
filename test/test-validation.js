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
  durationMs: 300000,
};
const result1 = validateMessage(validShowVerse);
assert.strictEqual(result1.valid, true, 'showVerse valide devrait passer');
assert.strictEqual(result1.error, null, "Pas d'erreur pour message valide");
console.log('[TEST] ✓ showVerse valide accepté');

// Test 2: Validation avec champ manquant
console.log('[TEST] Test 2: Validation avec champ manquant...');
const missingField = {
  action: 'showVerse',
  reference: 'Jean 3:16',
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
  text: 'Test',
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
  durationMs: 300000,
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
  durationMs: 3600001, // Dépasse 1 heure
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
  durationMs: 300000,
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
// NOTE : validateAndSanitize() n'échappe PAS le HTML (voir commentaire dans
// validation.js). overlay.html affiche tout via textContent, qui neutralise
// déjà toute injection HTML/JS côté navigateur — échapper ici en plus
// afficherait des versets pollués par des entités (&amp;, &#x27;, ...).
// Ce test vérifie donc que le texte passe la validation de structure/longueur
// sans être altéré, PAS qu'il est échappé.
console.log('[TEST] Test 9: Validation et sanitization combinées...');
const messageWithXss = {
  action: 'showVerse',
  reference: 'Jean 3:16',
  text: '<script>alert("xss")</script> Car Dieu a tant aimé',
  durationMs: 300000,
};
const result9 = validateAndSanitize(messageWithXss);
assert.strictEqual(
  result9.valid,
  true,
  'Message avec XSS devrait être valide (validation de structure uniquement)'
);
assert.strictEqual(
  result9.sanitized.text,
  messageWithXss.text,
  'Le texte ne doit pas être altéré : overlay.html neutralise via textContent'
);
console.log(
  '[TEST] ✓ Validation et sanitization combinées réussies (texte non altéré, sécurité déléguée à textContent côté overlay)'
);

// Test 10: Champ non autorisé
console.log('[TEST] Test 10: Champ non autorisé...');
const unauthorizedField = {
  action: 'showVerse',
  reference: 'Jean 3:16',
  text: 'Test',
  durationMs: 300000,
  unauthorizedField: 'should not be here',
};
const result10 = validateMessage(unauthorizedField);
assert.strictEqual(result10.valid, false, 'Champ non autorisé devrait rejeté');
assert(
  result10.error.includes('Champ non autorisé'),
  'Erreur devrait mentionner champ non autorisé'
);
console.log('[TEST] ✓ Champ non autorisé détecté');

// Test 11: Message non-objet
console.log('[TEST] Test 11: Message non-objet...');
const result11 = validateMessage('not an object');
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

// Test 14: Validation addMediaItem — payload minimal valide
console.log('[TEST] Test 14: Validation addMediaItem valide...');
const validAddMedia = {
  action: 'addMediaItem',
  sourcePath: 'C:\\Users\\op\\Pictures\\poster.png',
  label: 'Affiche de bienvenue',
  triggerPhrases: ['affiche accueil'],
  transitionStyle: 'fade',
  includeInLoop: true,
};
const result14 = validateMessage(validAddMedia);
assert.strictEqual(result14.valid, true, `addMediaItem valide devrait passer : ${result14.error}`);
console.log('[TEST] ✓ addMediaItem valide accepté');

// Test 15: addMediaItem — sourcePath manquant rejeté
console.log('[TEST] Test 15: addMediaItem sans sourcePath rejeté...');
const result15 = validateMessage({ action: 'addMediaItem', label: 'Sans fichier' });
assert.strictEqual(result15.valid, false, 'addMediaItem sans sourcePath devrait être rejeté');
console.log('[TEST] ✓ addMediaItem sans sourcePath rejeté');

// Test 16: addMediaItem — transitionStyle hors de la liste autorisée rejeté
console.log('[TEST] Test 16: addMediaItem avec transitionStyle invalide rejeté...');
const result16 = validateMessage({
  action: 'addMediaItem',
  sourcePath: 'C:\\media\\x.png',
  transitionStyle: 'explode', // n'existe pas dans TRANSITION_STYLES (media-library.js)
});
assert.strictEqual(result16.valid, false, 'transitionStyle inconnu devrait être rejeté');
console.log('[TEST] ✓ transitionStyle invalide rejeté');

// Test 17: deleteMediaItem / setDefaultMediaItem
console.log('[TEST] Test 17: deleteMediaItem et setDefaultMediaItem...');
assert.strictEqual(
  validateMessage({ action: 'deleteMediaItem', id: 'abc123' }).valid,
  true,
  'deleteMediaItem avec id valide devrait passer'
);
assert.strictEqual(
  validateMessage({ action: 'deleteMediaItem' }).valid,
  false,
  'deleteMediaItem sans id devrait être rejeté'
);
assert.strictEqual(
  validateMessage({ action: 'setDefaultMediaItem' }).valid,
  true,
  "setDefaultMediaItem sans id devrait passer (retire le poster principal, voir server.js)"
);
assert.strictEqual(
  validateMessage({ action: 'setDefaultMediaItem', id: 'abc123' }).valid,
  true,
  'setDefaultMediaItem avec id devrait passer'
);
console.log('[TEST] ✓ deleteMediaItem et setDefaultMediaItem corrects');

console.log('\n=== Tests terminés ===');
console.log('[TEST] ✓ Tous les tests de validation sont passés');
