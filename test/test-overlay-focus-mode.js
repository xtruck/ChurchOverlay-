'use strict';

/**
 * ============================================================================
 *  test-overlay-focus-mode.js — Mode Focus vocal (chantier innovation v1.0,
 *  Pilier 4)
 * ----------------------------------------------------------------------------
 *  Couvre les 3 briques ajoutées pour "mode focus" / "focus mode" :
 *   1. session-state.js — état process-wide, bascule sans valeur explicite.
 *   2. voice-commands.js — détection de la phrase COMPLÈTE uniquement (garde
 *      anti-faux-positif : "focus" seul, fréquent dans une prédication, ne
 *      doit jamais déclencher).
 *   3. validation.js — schéma de l'action WS setOverlayFocusMode (enabled
 *      optionnel, contrairement à setBlackScreen).
 *  Unitaire, aucun serveur réel démarré — même esprit que
 *  test-transcription-corrector.js/test-asr-engine.js pour ce chantier.
 * ============================================================================
 */

const { detectCommand } = require('../voice-commands');
const sessionState = require('../session-state');
const { validateMessage } = require('../validation');
const { CLIENT_ACTIONS } = require('../action-registry');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name, detail ? '—' + detail : '');
    failed++;
  }
}

console.log('=== Tests Mode Focus vocal (Pilier 4) ===\n');

// --- 1. session-state.js ---
console.log('--- session-state.js ---');
check('état initial : inactif', sessionState.getOverlayFocusActive() === false);
check(
  'toggleOverlayFocusActive() : première bascule -> true, valeur retournée cohérente',
  sessionState.toggleOverlayFocusActive() === true && sessionState.getOverlayFocusActive() === true
);
check(
  'toggleOverlayFocusActive() : seconde bascule -> false',
  sessionState.toggleOverlayFocusActive() === false &&
    sessionState.getOverlayFocusActive() === false
);
sessionState.setOverlayFocusActive(true);
check(
  'setOverlayFocusActive(true) : valeur explicite respectée',
  sessionState.getOverlayFocusActive() === true
);
sessionState.setOverlayFocusActive(false); // état propre pour les tests suivants

// --- 2. voice-commands.js — détection ---
console.log('\n--- voice-commands.js — détection ---');
check(
  '[fr] "mode focus" résout vers setOverlayFocusMode',
  detectCommand('mode focus')?.action === 'setOverlayFocusMode'
);
check(
  '[fr] "active le mode focus" résout vers setOverlayFocusMode',
  detectCommand('active le mode focus')?.action === 'setOverlayFocusMode'
);
check(
  '[en] "focus mode" résout vers setOverlayFocusMode',
  detectCommand('focus mode')?.action === 'setOverlayFocusMode'
);
check('GARDE ANTI-FAUX-POSITIF : "focus" seul ne déclenche RIEN', detectCommand('focus') === null);
check(
  'GARDE ANTI-FAUX-POSITIF : phrase de prédication contenant "focus" ne déclenche RIEN',
  detectCommand('gardons le focus sur l’essentiel de notre foi') === null
);
check(
  'GARDE ANTI-FAUX-POSITIF : "focus sur Dieu" ne déclenche RIEN',
  detectCommand('mettons le focus sur Dieu ce matin') === null
);

// --- 3. validation.js — schéma setOverlayFocusMode ---
console.log('\n--- validation.js — setOverlayFocusMode ---');
{
  const r1 = validateMessage({ action: 'setOverlayFocusMode' });
  check('sans "enabled" (cas vocal — bascule) : accepté', r1.valid === true, JSON.stringify(r1));

  const r2 = validateMessage({ action: 'setOverlayFocusMode', enabled: true });
  check('avec "enabled: true" (cas dashboard) : accepté', r2.valid === true, JSON.stringify(r2));

  const r3 = validateMessage({ action: 'setOverlayFocusMode', enabled: false });
  check('avec "enabled: false" : accepté', r3.valid === true, JSON.stringify(r3));

  const r4 = validateMessage({ action: 'setOverlayFocusMode', enabled: 'oui' });
  check('avec "enabled" non booléen : rejeté', r4.valid === false);
}

// --- 4. action-registry.js — l'action est bien réservée à l'opérateur ---
console.log('\n--- action-registry.js ---');
check(
  'setOverlayFocusMode est déclarée operatorOnly (jamais un spectateur overlay.js)',
  CLIENT_ACTIONS.setOverlayFocusMode && CLIENT_ACTIONS.setOverlayFocusMode.operatorOnly === true
);

console.log(`\n=== Résultat Mode Focus vocal : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log(
    'Mode Focus vocal conforme (bascule serveur, garde anti-faux-positif, schéma validé).'
  );
}
