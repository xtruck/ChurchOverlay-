/**
 * ============================================================================
 *  test-config-validator.js — Tests pour le module de validation de configuration
 * ----------------------------------------------------------------------------
 *  Teste la validation des variables d'environnement et de la configuration système
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const { validateEnvVar, validateEnvironment, ENV_SCHEMA } = require('../config-validator');

console.log('=== Test Config Validator Module ===\n');

// Test 1: Validation PORT valide
console.log('[TEST] Test 1: Validation PORT valide...');
const portResult = validateEnvVar('PORT', '8765');
assert.strictEqual(portResult.valid, true, 'PORT valide devrait passer');
assert.strictEqual(portResult.parsedValue, 8765, 'PORT devrait être converti en nombre');
console.log('[TEST] ✓ PORT valide accepté');

// Test 2: Validation PORT invalide
console.log('[TEST] Test 2: Validation PORT invalide...');
const invalidPort = validateEnvVar('PORT', '99999');
assert.strictEqual(invalidPort.valid, false, 'PORT invalide devrait rejeté');
assert(invalidPort.error.includes('entre 1 et 65535'), 'Erreur devrait mentionner la plage valide');
console.log('[TEST] ✓ PORT invalide détecté');

// Test 3: Validation PORT avec valeur par défaut
console.log('[TEST] Test 3: Validation PORT avec valeur par défaut...');
const defaultPort = validateEnvVar('PORT', '');
assert.strictEqual(defaultPort.valid, true, 'PORT vide devrait utiliser la valeur par défaut');
assert.strictEqual(defaultPort.parsedValue, 8765, 'Valeur par défaut devrait être 8765');
console.log('[TEST] ✓ Valeur par défaut utilisée');

// Test 4: Validation AUDIO_DEVICE
console.log('[TEST] Test 4: Validation AUDIO_DEVICE...');
const audioDevice = validateEnvVar('AUDIO_DEVICE', 'Microphone (Realtek)');
assert.strictEqual(audioDevice.valid, true, 'AUDIO_DEVICE valide devrait passer');
assert.strictEqual(audioDevice.parsedValue, 'Microphone (Realtek)', 'Valeur devrait être préservée');
console.log('[TEST] ✓ AUDIO_DEVICE valide accepté');

// Test 5: Validation NODE_ENV valide
console.log('[TEST] Test 5: Validation NODE_ENV valide...');
const nodeEnv = validateEnvVar('NODE_ENV', 'production');
assert.strictEqual(nodeEnv.valid, true, 'NODE_ENV production devrait passer');
console.log('[TEST] ✓ NODE_ENV production accepté');

// Test 6: Validation NODE_ENV invalide
console.log('[TEST] Test 6: Validation NODE_ENV invalide...');
const invalidNodeEnv = validateEnvVar('NODE_ENV', 'invalid');
assert.strictEqual(invalidNodeEnv.valid, false, 'NODE_ENV invalide devrait rejeté');
assert(invalidNodeEnv.error.includes('development, production ou test'), 'Erreur devrait mentionner les valeurs valides');
console.log('[TEST] ✓ NODE_ENV invalide détecté');

// Test 7: Validation environnement complète
console.log('[TEST] Test 7: Validation environnement complète...');
process.env.PORT = '9000';
process.env.NODE_ENV = 'test';
const envValidation = validateEnvironment();
assert.strictEqual(envValidation.valid, true, 'Validation environnement devrait passer');
assert.strictEqual(envValidation.config.PORT, 9000, 'PORT devrait être 9000');
assert.strictEqual(envValidation.config.NODE_ENV, 'test', 'NODE_ENV devrait être test');
console.log('[TEST] ✓ Validation environnement réussie');

// Test 8: Validation avec erreur
console.log('[TEST] Test 8: Validation avec erreur...');
process.env.PORT = 'invalid';
const envValidationWithError = validateEnvironment();
assert.strictEqual(envValidationWithError.valid, false, 'Validation avec PORT invalide devrait échouer');
assert(envValidationWithError.errors.length > 0, 'Devrait avoir des erreurs');
console.log('[TEST] ✓ Erreur détectée dans la validation');

// Test 9: Variable non reconnue
console.log('[TEST] Test 9: Variable non reconnue...');
const unknownVar = validateEnvVar('UNKNOWN_VAR', 'some_value');
assert.strictEqual(unknownVar.valid, true, 'Variable non reconnue devrait être acceptée');
assert.strictEqual(unknownVar.parsedValue, 'some_value', 'Valeur devrait être préservée');
console.log('[TEST] ✓ Variable non reconnue acceptée');

// Test 10: Schémas disponibles
console.log('[TEST] Test 10: Vérification des schémas...');
assert(ENV_SCHEMA.PORT, 'Schéma PORT devrait exister');
assert(ENV_SCHEMA.AUDIO_DEVICE, 'Schéma AUDIO_DEVICE devrait exister');
assert(ENV_SCHEMA.FFMPEG_PATH, 'Schéma FFMPEG_PATH devrait exister');
assert(ENV_SCHEMA.NODE_ENV, 'Schéma NODE_ENV devrait exister');
console.log('[TEST] ✓ Tous les schémas requis sont présents');

// Nettoyage
delete process.env.PORT;
delete process.env.NODE_ENV;

console.log('\n=== Tests terminés ===');
console.log('[TEST] ✓ Tous les tests de validation de configuration sont passés');
