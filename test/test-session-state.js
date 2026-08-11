/**
 * ============================================================================
 *  test-session-state.js — Tests pour session-state.js
 * ----------------------------------------------------------------------------
 *  Premier test de ce module (chantier bilingue FR/EN). Porte spécifiquement
 *  sur transcriptionLanguage (langue de l'ASR) vs displayLanguage (langue
 *  d'affichage) : ces deux réglages doivent rester TOTALEMENT indépendants,
 *  jamais couplés automatiquement — c'est la règle centrale du cahier des
 *  charges bilingue. Ne couvre pas exhaustivement le reste du module
 *  (historique, accessibilité, habillage caméra...), volontairement hors
 *  périmètre de ce lot.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const sessionState = require('../session-state');

console.log('=== Test Session State (transcriptionLanguage / displayLanguage) ===\n');

// Test 1 : valeurs par défaut, chacune indépendante de l'autre.
console.log('[TEST] Test 1: valeurs par défaut...');
assert.strictEqual(sessionState.getDisplayLanguage(), 'fr', 'displayLanguage par défaut : fr');
assert.strictEqual(
  sessionState.getTranscriptionLanguage(),
  null,
  'transcriptionLanguage par défaut : null (pas de préférence de session)'
);
console.log('[TEST] ✓ Valeurs par défaut correctes et indépendantes\n');

// Test 2 : setTranscriptionLanguage() ne modifie jamais displayLanguage.
console.log('[TEST] Test 2: setTranscriptionLanguage() ne touche pas displayLanguage...');
{
  const displayBefore = sessionState.getDisplayLanguage();
  sessionState.setTranscriptionLanguage('en');
  assert.strictEqual(sessionState.getTranscriptionLanguage(), 'en');
  assert.strictEqual(
    sessionState.getDisplayLanguage(),
    displayBefore,
    'displayLanguage doit rester inchangé après un changement de transcriptionLanguage'
  );
}
console.log('[TEST] ✓ displayLanguage inchangé après setTranscriptionLanguage()\n');

// Test 3 : setDisplayLanguage() ne modifie jamais transcriptionLanguage.
console.log('[TEST] Test 3: setDisplayLanguage() ne touche pas transcriptionLanguage...');
{
  const transcriptionBefore = sessionState.getTranscriptionLanguage();
  sessionState.setDisplayLanguage('both');
  assert.strictEqual(sessionState.getDisplayLanguage(), 'both');
  assert.strictEqual(
    sessionState.getTranscriptionLanguage(),
    transcriptionBefore,
    'transcriptionLanguage doit rester inchangé après un changement de displayLanguage'
  );
}
console.log('[TEST] ✓ transcriptionLanguage inchangé après setDisplayLanguage()\n');

// Test 4 : setTranscriptionLanguage() accepte de revenir à "pas de préférence".
console.log('[TEST] Test 4: setTranscriptionLanguage(null) réinitialise...');
{
  sessionState.setTranscriptionLanguage('fr');
  assert.strictEqual(sessionState.getTranscriptionLanguage(), 'fr');
  sessionState.setTranscriptionLanguage(null);
  assert.strictEqual(sessionState.getTranscriptionLanguage(), null);
  sessionState.setTranscriptionLanguage(undefined);
  assert.strictEqual(
    sessionState.getTranscriptionLanguage(),
    null,
    'une valeur absente/undefined retombe aussi sur null, jamais sur une chaîne vide'
  );
}
console.log('[TEST] ✓ Réinitialisation à null fonctionne\n');

console.log(
  '=== Résultat session-state (transcriptionLanguage/displayLanguage) : tous les tests sont passés ==='
);
