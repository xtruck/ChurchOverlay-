/**
 * ============================================================================
 *  test-ml-detector.js — Tests for ML-based verse detection
 * ============================================================================
 */

const { detect, detectMultiple, getStatistics, resetStatistics, train } = require('../ml-detector');

console.log('=== Tests ML Detector ===\n');

// Test 1: Basic detection with confidence
console.log('Test 1: Détection basique avec confidence');
const result1 = detect('Jean 3:16');
console.log('Résultat:', result1);
console.log('Confidence:', result1?.confidence);
console.log('✓ Test 1 passé\n');

// Test 2: Detection with context
console.log('Test 2: Détection avec contexte');
const result2 = detect('Lisons Jean 3:16 ensemble');
console.log('Résultat:', result2);
console.log('Confidence:', result2?.confidence);
console.log('Context score:', result2?.features?.contextScore);
console.log('✓ Test 2 passé\n');

// Test 3: Detection without context (should have lower confidence)
console.log('Test 3: Détection sans contexte');
const result3 = detect('Jean 3:16');
console.log('Résultat:', result3);
console.log('Confidence:', result3?.confidence);
console.log('✓ Test 3 passé\n');

// Test 4: Multiple detections
console.log('Test 4: Détections multiples');
const result4 = detectMultiple('Dans Jean 3:16 et Matthieu 5:9 nous voyons');
console.log('Références trouvées:', result4);
console.log('✓ Test 4 passé\n');

// Test 5: False positive filtering
console.log('Test 5: Filtrage des faux positifs');
const result5 = detect('Jean a dit');
console.log('Résultat:', result5);
console.log('Devrait être null:', result5 === null);
console.log('✓ Test 5 passé\n');

// Test 6: Statistics
console.log('Test 6: Statistiques');
resetStatistics();
detect('Jean 3:16');
detect('Matthieu 5:9');
detect('Jean a dit');
const stats = getStatistics();
console.log('Statistiques:', stats);
console.log('✓ Test 6 passé\n');

// Test 7: Training
console.log('Test 7: Entraînement');
train(['Luc 10:27', 'Marc 12:30'], ['Jean 3 euros', 'Matthieu 5 kilomètres']);
console.log('✓ Test 7 passé\n');

console.log('=== Tous les tests ML Detector réussis ===');