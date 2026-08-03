/**
 * ============================================================================
 *  test-rate-limiter.js — Tests pour le module de rate limiting
 * ----------------------------------------------------------------------------
 *  Teste la limitation de taux des connexions et messages
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const { createRateLimiter } = require('../rate-limiter');

console.log('=== Test Rate Limiter Module ===\n');

// Test 1: Création du rate limiter
console.log('[TEST] Test 1: Création du rate limiter...');
const rateLimiter = createRateLimiter({
  maxConnections: 5,
  maxMessagesPerMinute: 10,
});
assert(rateLimiter, 'Rate limiter devrait être créé');
console.log('[TEST] ✓ Rate limiter créé');

// Test 2: Vérification des connexions (simulation)
console.log('[TEST] Test 2: Vérification des connexions...');
const mockWs = {
  _socket: { remoteAddress: '127.0.0.1' },
  readyState: 1, // OPEN
};

const connectionCheck1 = rateLimiter.checkConnection(mockWs);
assert.strictEqual(connectionCheck1.allowed, true, 'Première connexion devrait être autorisée');
console.log('[TEST] ✓ Première connexion autorisée');

// Test 3: Limite de connexions par IP
console.log('[TEST] Test 3: Limite de connexions par IP...');
for (let i = 0; i < 5; i++) {
  const ws = { _socket: { remoteAddress: '192.168.1.1' }, readyState: 1 };
  rateLimiter.checkConnection(ws);
}
const sixthConnection = { _socket: { remoteAddress: '192.168.1.1' }, readyState: 1 };
const connectionCheck3 = rateLimiter.checkConnection(sixthConnection);
assert.strictEqual(
  connectionCheck3.allowed,
  false,
  'Connexion au-delà de la limite devrait rejetée'
);
assert(
  connectionCheck3.reason.includes('Trop de connexions'),
  'Raison devrait mentionner trop de connexions'
);
console.log('[TEST] ✓ Limite de connexions respectée');

// Test 4: Vérification des messages
console.log('[TEST] Test 4: Vérification des messages...');
const messageCheck1 = rateLimiter.checkMessage(mockWs);
assert.strictEqual(messageCheck1.allowed, true, 'Premier message devrait être autorisé');
console.log('[TEST] ✓ Premier message autorisé');

// Test 5: Limite de messages
console.log('[TEST] Test 5: Limite de messages...');
for (let i = 0; i < 10; i++) {
  rateLimiter.checkMessage(mockWs);
}
const eleventhMessage = rateLimiter.checkMessage(mockWs);
assert.strictEqual(eleventhMessage.allowed, false, 'Message au-delà de la limite devrait rejeté');
assert(
  eleventhMessage.reason.includes('Trop de messages'),
  'Raison devrait mentionner trop de messages'
);
console.log('[TEST] ✓ Limite de messages respectée');

// Test 6: Statistiques
console.log('[TEST] Test 6: Statistiques...');
const stats = rateLimiter.getStats();
assert(typeof stats.totalConnections === 'number', 'totalConnections devrait être un nombre');
assert(typeof stats.uniqueIPs === 'number', 'uniqueIPs devrait être un nombre');
assert(typeof stats.messageHistorySize === 'number', 'messageHistorySize devrait être un nombre');
console.log('[TEST] ✓ Statistiques disponibles');

// Test 7: Suppression de connexion
console.log('[TEST] Test 7: Suppression de connexion...');
rateLimiter.removeConnection(mockWs);
const statsAfterRemoval = rateLimiter.getStats();
console.log('[TEST] ✓ Connexion supprimée');

// Test 8: Différentes IP
console.log('[TEST] Test 8: Différentes IP...');
const ws1 = { _socket: { remoteAddress: '10.0.0.1' }, readyState: 1 };
const ws2 = { _socket: { remoteAddress: '10.0.0.2' }, readyState: 1 };
const check1 = rateLimiter.checkConnection(ws1);
const check2 = rateLimiter.checkConnection(ws2);
assert.strictEqual(check1.allowed, true, 'IP différente 1 devrait être autorisée');
assert.strictEqual(check2.allowed, true, 'IP différente 2 devrait être autorisée');
console.log('[TEST] ✓ Différentes IP traitées séparément');

// Test 9: IP inconnue
console.log('[TEST] Test 9: IP inconnue...');
const wsUnknown = { readyState: 1 }; // Pas de remoteAddress
const checkUnknown = rateLimiter.checkConnection(wsUnknown);
assert.strictEqual(checkUnknown.allowed, true, 'IP inconnue devrait être traitée comme unknown');
console.log('[TEST] ✓ IP inconnue gérée');

// Nettoyage
console.log('[TEST] Nettoyage...');
rateLimiter.stopCleanup();
console.log('[TEST] ✓ Rate limiter arrêté proprement');

console.log('\n=== Tests terminés ===');
console.log('[TEST] ✓ Tous les tests de rate limiting sont passés');
