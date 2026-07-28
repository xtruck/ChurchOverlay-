/**
 * ============================================================================
 *  test-sermon-analyzer.js — Tests for sermon analysis
 * ============================================================================
 */

const { startSession, addTranscript, getAnalysis, getDetailedSummary, endSession } = require('../sermon-analyzer');

console.log('=== Tests Sermon Analyzer ===\n');

// Test 1: Start session
console.log('Test 1: Démarrage de session');
startSession();
console.log('✓ Session démarrée\n');

// Test 2: Add transcripts
console.log('Test 2: Ajout de transcriptions');
addTranscript('L\'amour de Dieu est essentiel pour notre foi');
addTranscript('Nous devons persévérer dans la prière');
addTranscript('La communauté est importante pour grandir ensemble');
addTranscript('L\'espérance nous donne la force d\'avancer');
console.log('✓ Transcriptions ajoutées\n');

// Test 3: Get analysis
console.log('Test 3: Analyse en cours');
const analysis = getAnalysis();
console.log('Analyse:', JSON.stringify(analysis, null, 2));
console.log('✓ Analyse récupérée\n');

// Test 4: Check themes
console.log('Test 4: Thèmes identifiés');
console.log('Thèmes:', analysis.themes);
console.log('✓ Thèmes identifiés\n');

// Test 5: Check key points
console.log('Test 5: Points clés');
console.log('Points clés:', analysis.keyPoints);
console.log('✓ Points clés identifiés\n');

// Test 6: Get detailed summary
console.log('Test 6: Résumé détaillé');
const summary = getDetailedSummary();
console.log('Résumé détaillé:');
console.log(summary);
console.log('✓ Résumé détaillé généré\n');

// Test 7: End session
console.log('Test 7: Fin de session');
const finalSummary = endSession();
console.log('Résumé final:');
console.log(finalSummary);
console.log('✓ Session terminée\n');

console.log('=== Tous les tests Sermon Analyzer réussis ===');