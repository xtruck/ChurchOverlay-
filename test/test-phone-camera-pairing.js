/**
 * ============================================================================
 *  test-phone-camera-pairing.js — Tests pour phone-camera-pairing.js
 * ----------------------------------------------------------------------------
 *  Module pur (aucun réseau/Express) : codes de jumelage à usage unique,
 *  secrets de flux, expiration. Le cas le plus important : un code de
 *  jumelage ne doit JAMAIS pouvoir être réutilisé une deuxième fois.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const pairing = require('../phone-camera-pairing');

console.log('=== Test Phone Camera Pairing ===\n');

// Test 1 : generatePairingCode() produit un code valide et différent à chaque appel.
console.log('[TEST] Test 1: generatePairingCode()...');
const code1 = pairing.generatePairingCode();
const code2 = pairing.generatePairingCode();
assert(typeof code1 === 'string' && code1.length > 0);
assert.notStrictEqual(code1, code2, 'deux codes générés doivent être différents');
assert.strictEqual(pairing.isPairingCodeValid(code1), true);
assert.strictEqual(pairing.isPairingCodeValid(code2), true);
console.log('[TEST] ✓ Codes générés uniques et valides\n');

// Test 2 : isPairingCodeValid() renvoie false pour un code inconnu.
console.log('[TEST] Test 2: isPairingCodeValid() avec un code inconnu...');
assert.strictEqual(pairing.isPairingCodeValid('code-invente'), false);
assert.strictEqual(pairing.isPairingCodeValid(''), false);
assert.strictEqual(pairing.isPairingCodeValid(null), false);
console.log('[TEST] ✓ Code inconnu/vide/null rejeté\n');

// Test 3 (LE PLUS IMPORTANT) : redeemPairingCode() consomme le code — un
// deuxième échange avec le MÊME code doit échouer. Sans ça, un QR capturé
// en photo pourrait être réutilisé indéfiniment par n'importe qui.
console.log('[TEST] Test 3: redeemPairingCode() — usage unique...');
const code3 = pairing.generatePairingCode();
const result1 = pairing.redeemPairingCode(code3);
assert(result1 !== null, 'le premier échange doit réussir');
assert(result1.cameraId, 'un id de caméra doit être généré');
assert(result1.streamSecret, 'un secret de flux doit être généré');
assert.strictEqual(result1.label, '', 'sans nom fourni à la génération, le label doit être vide');
assert.strictEqual(
  pairing.isPairingCodeValid(code3),
  false,
  'le code doit être invalidé après usage'
);
const result2 = pairing.redeemPairingCode(code3);
assert.strictEqual(result2, null, 'un deuxième échange avec le même code doit échouer');
console.log('[TEST] ✓ Code de jumelage à usage unique — réutilisation impossible\n');

// Test 4 : redeemPairingCode() avec un code inconnu renvoie null.
console.log('[TEST] Test 4: redeemPairingCode() avec un code inconnu...');
assert.strictEqual(pairing.redeemPairingCode('jamais-genere'), null);
console.log('[TEST] ✓ Code inconnu rejeté\n');

// Test 4b (demande explicite — "plusieurs téléphones doivent être
// distinguables") : le nom choisi par l'opérateur à la génération du QR
// doit être porté jusqu'au redeemPairingCode(), et débarrassé des espaces
// superflus/tronqué comme les autres champs texte de l'app.
console.log('[TEST] Test 4b: generatePairingCode() porte le nom choisi...');
const codeNamed = pairing.generatePairingCode('  Téléphone scène  ');
const resultNamed = pairing.redeemPairingCode(codeNamed);
assert.strictEqual(
  resultNamed.label,
  'Téléphone scène',
  'le nom doit être conservé (espaces retirés)'
);
console.log('[TEST] ✓ Nom choisi correctement porté jusqu’au jumelage\n');

// Test 5 : isStreamSecretValid() — seul le bon secret pour la bonne caméra passe.
console.log('[TEST] Test 5: isStreamSecretValid()...');
const code5 = pairing.generatePairingCode();
const { cameraId, streamSecret } = pairing.redeemPairingCode(code5);
assert.strictEqual(pairing.isStreamSecretValid(cameraId, streamSecret), true);
assert.strictEqual(
  pairing.isStreamSecretValid(cameraId, 'mauvais-secret'),
  false,
  'un mauvais secret doit être rejeté'
);
assert.strictEqual(
  pairing.isStreamSecretValid('id-inconnu', streamSecret),
  false,
  'le bon secret pour une AUTRE caméra doit être rejeté'
);
console.log('[TEST] ✓ Validation du secret de flux correcte\n');

// Test 6 : isCameraPaired().
console.log('[TEST] Test 6: isCameraPaired()...');
assert.strictEqual(pairing.isCameraPaired(cameraId), true);
assert.strictEqual(pairing.isCameraPaired('id-inconnu'), false);
console.log('[TEST] ✓ Statut de jumelage correct\n');

// Test 7 : removeCamera() invalide immédiatement son secret de flux.
console.log('[TEST] Test 7: removeCamera()...');
pairing.removeCamera(cameraId);
assert.strictEqual(pairing.isCameraPaired(cameraId), false);
assert.strictEqual(
  pairing.isStreamSecretValid(cameraId, streamSecret),
  false,
  'le secret doit devenir invalide après removeCamera()'
);
console.log('[TEST] ✓ Caméra retirée, secret immédiatement invalidé\n');

console.log('=== Tous les tests phone-camera-pairing sont passés ===');
