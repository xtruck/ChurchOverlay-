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

// Test 18: addScene — payload valide (background objet, elements tableau)
console.log('[TEST] Test 18: Validation addScene valide...');
const validAddScene = {
  action: 'addScene',
  name: 'Intro culte',
  background: { type: 'color', color: '#000000' },
  elements: [{ type: 'text', text: 'Bienvenue' }],
  triggerPhrases: ['scène intro'],
};
const result18 = validateMessage(validAddScene);
assert.strictEqual(result18.valid, true, `addScene valide devrait passer : ${result18.error}`);
console.log('[TEST] ✓ addScene valide accepté');

// Test 19: addScene — background/elements de mauvais type rejetés
console.log('[TEST] Test 19: addScene avec background de mauvais type rejeté...');
const result19a = validateMessage({ action: 'addScene', name: 'X', background: 'not-an-object' });
assert.strictEqual(result19a.valid, false, 'background non-objet devrait être rejeté');
const result19b = validateMessage({ action: 'addScene', name: 'X', elements: { not: 'an-array' } });
assert.strictEqual(result19b.valid, false, 'elements non-tableau devrait être rejeté');
console.log('[TEST] ✓ background/elements mal typés rejetés');

// Test 20: studio de scènes — reste des actions
console.log('[TEST] Test 20: deleteScene/triggerScene/hideScene/setDefaultScene...');
assert.strictEqual(validateMessage({ action: 'deleteScene', id: 'abc' }).valid, true);
assert.strictEqual(validateMessage({ action: 'triggerScene', id: 'abc' }).valid, true);
assert.strictEqual(validateMessage({ action: 'triggerScene' }).valid, false, 'triggerScene sans id devrait être rejeté');
assert.strictEqual(validateMessage({ action: 'hideScene' }).valid, true);
assert.strictEqual(validateMessage({ action: 'setDefaultScene' }).valid, true, 'setDefaultScene sans id devrait passer (retire la scène par défaut)');
console.log('[TEST] ✓ Actions du studio de scènes correctes');

// Test 21: import/export de service
console.log('[TEST] Test 21: importPptxSlides/exportService/importService...');
assert.strictEqual(
  validateMessage({ action: 'importPptxSlides', sourcePath: 'C:\\x\\y.pptx' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'exportService', destPath: 'C:\\x\\out.zip' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'importService', sourcePath: 'C:\\x\\in.zip' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'exportService' }).valid,
  false,
  'exportService sans destPath devrait être rejeté'
);
console.log('[TEST] ✓ Import/export de service corrects');

// Test 22: bibliothèque de chants
console.log('[TEST] Test 22: addSong/deleteSong/showSongSection...');
const result22 = validateMessage({
  action: 'addSong',
  title: 'Amazing Grace',
  artist: 'John Newton',
  lyrics: "Amazing grace, how sweet the sound\n\nThat saved a wretch like me",
  triggerPhrases: ['amazing grace'],
});
assert.strictEqual(result22.valid, true, `addSong valide devrait passer : ${result22.error}`);
assert.strictEqual(
  validateMessage({ action: 'addSong' }).valid,
  false,
  'addSong sans title devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'deleteSong', id: 'abc' }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'showSongSection', id: 'abc', sectionIndex: 2 }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'showSongSection', id: 'abc', sectionIndex: -1 }).valid,
  false,
  'sectionIndex négatif devrait être rejeté'
);
console.log('[TEST] ✓ Bibliothèque de chants correcte');

// Test 23: mode confiance
console.log('[TEST] Test 23: setTrustMode/confirmPendingVerse/dismissPendingVerse...');
assert.strictEqual(validateMessage({ action: 'setTrustMode', mode: 'semi-auto' }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'setTrustMode', mode: 'yolo' }).valid,
  false,
  'mode inconnu devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'confirmPendingVerse' }).valid, true);
assert.strictEqual(validateMessage({ action: 'dismissPendingVerse' }).valid, true);
console.log('[TEST] ✓ Mode confiance correct');

// Test 24: feuille de route (rundown/cue-list)
console.log('[TEST] Test 24: addRundownCue/removeRundownCue/reorderRundownCues/...');
assert.strictEqual(
  validateMessage({
    action: 'addRundownCue',
    type: 'verse',
    label: 'Ouverture',
    reference: 'Jean 3:16',
  }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'addRundownCue', type: 'bogus', label: 'X' }).valid,
  false,
  'type de repère inconnu devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'removeRundownCue', id: 'abc' }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'reorderRundownCues', orderedIds: ['a', 'b', 'c'] }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'reorderRundownCues', orderedIds: 'not-an-array' }).valid,
  false,
  'orderedIds non-tableau devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'clearRundown' }).valid, true);
assert.strictEqual(validateMessage({ action: 'triggerRundownCue', id: 'abc' }).valid, true);
assert.strictEqual(validateMessage({ action: 'nextRundownCue' }).valid, true);
console.log('[TEST] ✓ Feuille de route correcte');

// Test 25: caméras IP
console.log('[TEST] Test 25: addIpCamera/deleteIpCamera/generateCameraPairing...');
assert.strictEqual(
  validateMessage({
    action: 'addIpCamera',
    label: 'Caméra fond de salle',
    url: 'http://192.168.1.50:8080/video',
  }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'addIpCamera', label: 'X' }).valid,
  false,
  'addIpCamera sans url devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'deleteIpCamera', id: 'abc' }).valid, true);
assert.strictEqual(validateMessage({ action: 'generateCameraPairing' }).valid, true);
console.log('[TEST] ✓ Caméras IP correctes');

// Test 26: habillage caméra (branding)
console.log('[TEST] Test 26: setBrandingLogo/Position/Size/Text/Visible...');
assert.strictEqual(
  validateMessage({ action: 'setBrandingLogo', sourcePath: 'C:\\logos\\x.png' }).valid,
  true
);
assert.strictEqual(validateMessage({ action: 'clearBrandingLogo' }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'setBrandingPosition', position: 'top-left' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'setBrandingPosition', position: 'middle' }).valid,
  false,
  'position hors énumération devrait être rejetée'
);
assert.strictEqual(validateMessage({ action: 'setBrandingSize', size: 'medium' }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'setBrandingSize', size: 'huge' }).valid,
  false,
  'size hors énumération devrait être rejetée'
);
assert.strictEqual(
  validateMessage({ action: 'setBrandingText', title: 'Église XYZ', subtitle: 'Culte du dimanche' })
    .valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'setBrandingText' }).valid,
  true,
  'setBrandingText sans title/subtitle devrait passer (les deux optionnels)'
);
assert.strictEqual(
  validateMessage({ action: 'setBrandingVisible', visible: true }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'setBrandingVisible' }).valid,
  false,
  'setBrandingVisible sans visible devrait être rejeté'
);
console.log('[TEST] ✓ Habillage caméra correct');

// Test 27: identité de marque du tableau de bord
console.log('[TEST] Test 27: setDashboardOrgName/AccentColor/Logo...');
assert.strictEqual(
  validateMessage({ action: 'setDashboardOrgName', organizationName: 'Église XYZ' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'setDashboardAccentColor', accentColor: '#7c8cf5' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'setDashboardAccentColor', accentColor: 'red' }).valid,
  false,
  'couleur non hexadécimale devrait être rejetée'
);
assert.strictEqual(
  validateMessage({ action: 'setDashboardLogo', sourcePath: 'C:\\logos\\dash.png' }).valid,
  true
);
assert.strictEqual(validateMessage({ action: 'clearDashboardLogo' }).valid, true);
console.log('[TEST] ✓ Identité de marque du tableau de bord correcte');

// Test 28: traduction secondaire et mode lecture
console.log('[TEST] Test 28: setSecondaryTranslation/startReading/stopReading/...');
assert.strictEqual(
  validateMessage({ action: 'setSecondaryTranslation', lang: 'en', code: 'kjv' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'setSecondaryTranslation' }).valid,
  true,
  'setSecondaryTranslation sans lang/code devrait passer (désactive la traduction secondaire)'
);
assert.strictEqual(
  validateMessage({ action: 'startReading', reference: 'Jean 3:1' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'startReading' }).valid,
  false,
  'startReading sans reference devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'stopReading' }).valid, true);
assert.strictEqual(validateMessage({ action: 'nextReadingVerse' }).valid, true);
assert.strictEqual(validateMessage({ action: 'previousReadingVerse' }).valid, true);
console.log('[TEST] ✓ Traduction secondaire et mode lecture corrects');

// Test 29: thème d'ambiance et traduction IA à la volée
console.log('[TEST] Test 29: setMoodTheme/translateText/hideTranslation...');
assert.strictEqual(validateMessage({ action: 'setMoodTheme', mood: 'joy' }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'translateText', text: 'Car Dieu a tant aimé le monde', targetLang: 'en' })
    .valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'translateText' }).valid,
  false,
  'translateText sans text devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'hideTranslation' }).valid, true);
console.log('[TEST] ✓ Thème d’ambiance et traduction IA corrects');

// Test 30: accessibilité et affichage
console.log('[TEST] Test 30: setHighContrast/setCaptions/setTranslatedCaptions/setTestPattern/setBackgroundPattern/setBlackScreen...');
assert.strictEqual(validateMessage({ action: 'setHighContrast', enabled: true }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'setHighContrast' }).valid,
  false,
  'setHighContrast sans enabled devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'setCaptions', enabled: false }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'setTranslatedCaptions', enabled: true, targetLang: 'es' }).valid,
  true
);
assert.strictEqual(validateMessage({ action: 'setTestPattern', enabled: true }).valid, true);
assert.strictEqual(
  validateMessage({ action: 'setBackgroundPattern', pattern: 'dots' }).valid,
  true
);
assert.strictEqual(
  validateMessage({ action: 'setBackgroundPattern', pattern: 'stripes' }).valid,
  false,
  'pattern hors énumération devrait être rejeté'
);
assert.strictEqual(validateMessage({ action: 'setBlackScreen', enabled: true }).valid, true);
console.log('[TEST] ✓ Accessibilité et affichage corrects');

console.log('\n=== Tests terminés ===');
console.log('[TEST] ✓ Tous les tests de validation sont passés');
