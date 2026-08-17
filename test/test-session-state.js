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
  'fr',
  'transcriptionLanguage par défaut : fr (A.5 — langue de session forçée)'
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

// --- Fusion de fragments (chantier ASR, Étape 4) ---
console.log('=== Tests fusion de fragments (reconstruction de références) ===\n');

// Test 5 : fragments cumulatifs émis par l'endpointing (bloc1.wav C1 réel) :
// "1 Corinthiens chapitre" / "13 verset" / "13 verset 4." doivent fusionner
// en une référence complète sans dupliquer le chevauchement.
console.log('[TEST] Test 5: fusion de fragments cumulatifs (C1 réel)...');
{
  sessionState.pushTranscriptFragment('1 Corinthiens chapitre', 10_000);
  sessionState.pushTranscriptFragment('13 verset', 11_400);
  sessionState.pushTranscriptFragment('13 verset 4.', 11_800);
  assert.strictEqual(
    sessionState.getFusedRecentText(12_000),
    '1 Corinthiens chapitre 13 verset 4.',
    'les fragments redondants doivent fusionner en supprimant le chevauchement'
  );
}
console.log('[TEST] ✓ Fusion cumulative correcte\n');

// Test 6 : un seul fragment dans la fenêtre → rien à fusionner (chaîne vide).
console.log('[TEST] Test 6: un seul fragment → aucune fusion...');
{
  sessionState.pushTranscriptFragment('13 verset 4.', 40_000);
  assert.strictEqual(
    sessionState.getFusedRecentText(41_000),
    '',
    'un seul fragment ne fusionne rien'
  );
}
console.log('[TEST] ✓ Aucune fusion pour un fragment unique\n');

// Test 7 : fragments très espacés dans le temps (≥ fenêtre) → pas de fusion.
// Fenêtre élargie à 15000ms (voir session-state.js) : la séparation des
// énoncés consécutifs rapprochés (1.4-2.3s, F1/F2 à 5s) est désormais portée
// par le RESET sur nom de livre (Test 9), plus la fenêtre ne protège que des
// écarts très larges. Ici un écart de 20s (> 15000ms) : le premier fragment
// est hors fenêtre → le buffer ne contient qu'un seul fragment → aucune
// fusion.
console.log('[TEST] Test 7: énoncés distincts espacés de 20s → pas de fusion...');
{
  sessionState.pushTranscriptFragment('Romains 8 verset 28', 50_000);
  sessionState.pushTranscriptFragment('Romains 12 verset 2', 70_000);
  const fused = sessionState.getFusedRecentText(70_000);
  assert.strictEqual(
    fused,
    '',
    'le premier énoncé (20s avant) est hors fenêtre : le second reste seul, aucune fusion'
  );
}
console.log('[TEST] ✓ Pas de fusion erronée inter-énoncés (fenêtre respectée)\n');

// Test 8 : un fragment déjà entièrement contenu dans l'accumulation (partial
// puis final identique) est ignoré, pas dupliqué.
console.log('[TEST] Test 8: fragment redondant ignoré...');
{
  sessionState.resetTranscriptFragments();
  sessionState.pushTranscriptFragment('Jean chapitre 3 verset', 60_000);
  sessionState.pushTranscriptFragment('Jean chapitre 3 verset 16', 61_000);
  sessionState.pushTranscriptFragment('Jean chapitre 3 verset 16', 61_200);
  assert.strictEqual(
    sessionState.getFusedRecentText(62_000),
    'Jean chapitre 3 verset 16',
    'le dernier fragment répété ne doit pas être ajouté une deuxième fois'
  );
}
console.log('[TEST] ✓ Redondance éliminée\n');

// Test 9 : RESET du buffer sur nom de livre (correctif probe-overwrites).
// Le scénario réel de contamination : « 13 verset 4. » (fin de l'énoncé C1,
// "1 Corinthiens chapitre 13 verset 4") est encore dans le buffer quand le
// fragment « 2e Timothée chapitre » (début de l'énoncé C2) arrive 1.4-2.3s
// plus tard — les deux fragments sont DANS la fenêtre 4000ms. Sans reset, la
// fusion donnerait « 2e Timothée chapitre 13 verset 4. » → 2timothee 13:4
// FAUX. Le reset vide le buffer : le fragment C1 est jeté, seul C2 est
// conservé, et la fusion avec le fragment suivant de C2 reste correcte.
console.log('[TEST] Test 9: reset du buffer quand un nom de livre arrive...');
{
  sessionState.resetTranscriptFragments();
  sessionState.pushTranscriptFragment('13 verset 4.', 70_000);
  sessionState.resetTranscriptFragments();
  sessionState.pushTranscriptFragment('2e Timothée chapitre', 71_400);
  const fusedSolo = sessionState.getFusedRecentText(72_000);
  assert.strictEqual(
    fusedSolo,
    '',
    "le résidu de l'énoncé précédent a été jeté par le reset : le fragment C2 seul ne fusionne rien"
  );
  sessionState.pushTranscriptFragment('3 verset 16', 72_800);
  assert.strictEqual(
    sessionState.getFusedRecentText(73_000),
    '2e Timothée chapitre 3 verset 16',
    'les fragments du même énoncé C2 fusionnent toujours correctement après le reset'
  );
}
console.log('[TEST] ✓ Reset par nom de livre : contamination inter-énoncés éliminée\n');

// Test 10 : containsBookName (detector.js) — la base du reset. Un fragment
// « 2e Timothée chapitre » (début d'énoncé, aucune référence détectable seule)
// doit signaler la présence d'un livre ; les fragments de continuation
// (« 13 verset 4. », « chapitre 21 verset 4. ») et les phrases ordinaires ne
// doivent pas.
console.log('[TEST] Test 10: containsBookName...');
{
  const d = require('../detector');
  assert.strictEqual(
    d.containsBookName('2e Timothée chapitre'),
    '2timothee',
    '2e Timothée reconnu'
  );
  assert.strictEqual(d.containsBookName('Apocalypse'), 'apocalypse', 'Apocalypse reconnu');
  assert.strictEqual(d.containsBookName('Ecclésiaste'), 'ecclesiaste', 'Ecclésiaste reconnu');
  assert.strictEqual(d.containsBookName('13 verset 4.'), null, 'continuation : pas de livre');
  assert.strictEqual(
    d.containsBookName('chapitre 21 verset 4.'),
    null,
    'continuation : pas de livre'
  );
  assert.strictEqual(d.containsBookName('merci beaucoup'), null, 'phrase ordinaire : pas de livre');
}
console.log("[TEST] ✓ containsBookName détecte les débuts d'énoncé\n");

// Test 11 : removeLastTranscriptFragment — purge du résidu fautif. Le
// scénario réel (probe-overwrites) : le final « 13 verset 4. » (fin de C1)
// est délivré par l'ASR APRÈS « 2e Timothée chapitre » (début de C2) — la
// fusion donne « 2e Timothée chapitre 13 verset 4. » → 2timothee 13:4 FAUX.
// La validation de chapitre (2 Timothée n'a que 4 chapitres) rejette la
// référence et purge le résidu fautif : le fragment suivant (« 3 verset 16 »)
// peut alors fusionner proprement avec « 2e Timothée chapitre ».
console.log('[TEST] Test 11: purge du résidu fautif (removeLastTranscriptFragment)...');
{
  sessionState.resetTranscriptFragments();
  sessionState.pushTranscriptFragment('2e Timothée chapitre', 80_000);
  sessionState.pushTranscriptFragment('13 verset 4.', 81_400);
  const contaminated = sessionState.getFusedRecentText(82_000);
  assert.strictEqual(
    contaminated,
    '2e Timothée chapitre 13 verset 4.',
    'la contamination reproduite : le résidu de C1 se colle au début de C2'
  );
  sessionState.removeLastTranscriptFragment();
  sessionState.pushTranscriptFragment('3 verset 16', 82_800);
  assert.strictEqual(
    sessionState.getFusedRecentText(83_000),
    '2e Timothée chapitre 3 verset 16',
    'après purge du résidu fautif, le vrai fragment de C2 fusionne correctement'
  );
}
console.log('[TEST] ✓ Purge du résidu fautif : fusion C2 correcte\n');

console.log(
  '=== Résultat session-state (transcriptionLanguage/displayLanguage + fusion) : tous les tests sont passés ==='
);
