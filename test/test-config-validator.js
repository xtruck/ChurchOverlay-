/**
 * ============================================================================
 *  test/test-config-validator.js — Tests de config-validator.js
 * ----------------------------------------------------------------------------
 *  CORRECTIF (audit) : ce fichier ne contenait pas de test du tout — il
 *  était une copie identique (octet pour octet) de config-validator.js
 *  lui-même, collée par erreur à la place du vrai test. `npm test`
 *  l'exécutait avec succès (code de sortie 0, aucune sortie) en donnant
 *  l'illusion que config-validator.js était couvert par un test, alors
 *  qu'aucune assertion n'était jamais faite. Remplacé ici par un vrai test.
 * ============================================================================
 */

'use strict';

const assert = require('assert');
const configValidator = require('../config-validator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   ${err.message}`);
    failed++;
  }
}

// ── PORT ──
test('PORT: valeur par défaut si non défini', () => {
  const r = configValidator.validateEnvVar('PORT', undefined);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.parsedValue, 8765);
});

test('PORT: rejette une valeur hors plage', () => {
  const r = configValidator.validateEnvVar('PORT', '99999');
  assert.strictEqual(r.valid, false);
});

test('PORT: accepte une valeur valide', () => {
  const r = configValidator.validateEnvVar('PORT', '9000');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.parsedValue, 9000);
});

// ── WS_HOST (CORRECTIF audit) ──
test('WS_HOST: défaut à 127.0.0.1 (liaison locale) si non défini', () => {
  const r = configValidator.validateEnvVar('WS_HOST', undefined);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.parsedValue, '127.0.0.1');
});

test('WS_HOST: accepte une valeur personnalisée', () => {
  const r = configValidator.validateEnvVar('WS_HOST', '0.0.0.0');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.parsedValue, '0.0.0.0');
});

test("WS_HOST: rejette une chaîne composée uniquement d'espaces", () => {
  const r = configValidator.validateEnvVar('WS_HOST', '   ');
  assert.strictEqual(r.valid, false);
});

// ── MAX_CONNECTIONS / MAX_MESSAGES_PER_MINUTE (CORRECTIF audit) ──
test('MAX_CONNECTIONS: défaut à 10 si non défini', () => {
  const r = configValidator.validateEnvVar('MAX_CONNECTIONS', undefined);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.parsedValue, 10);
});

test('MAX_CONNECTIONS: rejette une valeur hors plage', () => {
  const r = configValidator.validateEnvVar('MAX_CONNECTIONS', '0');
  assert.strictEqual(r.valid, false);
});

test('MAX_MESSAGES_PER_MINUTE: défaut à 60 si non défini', () => {
  const r = configValidator.validateEnvVar('MAX_MESSAGES_PER_MINUTE', undefined);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.parsedValue, 60);
});

// ── NODE_ENV ──
test('NODE_ENV: rejette une valeur non reconnue', () => {
  const r = configValidator.validateEnvVar('NODE_ENV', 'staging');
  assert.strictEqual(r.valid, false);
});

// ── validateEnvironment ──
test('validateEnvironment: valide avec un environnement vide (tout par défaut)', () => {
  const original = { ...process.env };
  delete process.env.PORT;
  delete process.env.WS_HOST;
  delete process.env.MAX_CONNECTIONS;
  delete process.env.MAX_MESSAGES_PER_MINUTE;
  delete process.env.NODE_ENV;
  try {
    const r = configValidator.validateEnvironment();
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.config.WS_HOST, '127.0.0.1');
  } finally {
    process.env = original;
  }
});

// ── validateSystemConfig (avertissements attendus sans clés API) ──
test('validateSystemConfig: avertit si GROQ_API_KEY absent', async () => {
  const original = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const result = await configValidator.validateSystemConfig();
    assert.ok(result.warnings.some((w) => w.includes('GROQ_API_KEY')));
  } finally {
    if (original !== undefined) process.env.GROQ_API_KEY = original;
  }
});

console.log(`\n=== Résultat test-config-validator : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) process.exit(1);
