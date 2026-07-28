/**
 * ============================================================================
 *  test-analytics.js — Tests for analytics system
 * ============================================================================
 */

const { startSession, endSession, trackVerseDisplay, trackTranscription, trackVoiceCommand, trackLanguageUsage, trackDetectionConfidence, trackError, updatePeakUsers, getAnalyticsReport, getInsights, resetMetrics } = require('../analytics');

console.log('=== Tests Analytics System ===\n');

// Test 1: Start session
console.log('Test 1: Démarrage de session');
startSession();
console.log('✓ Session démarrée\n');

// Test 2: Track verse display
console.log('Test 2: Suivi d\'affichage de verset');
trackVerseDisplay('Jean 3:16', 'jean');
trackVerseDisplay('Matthieu 5:9', 'matthieu');
trackVerseDisplay('Jean 3:16', 'jean'); // Duplicate
console.log('✓ Affichage de versets suivi\n');

// Test 3: Track transcription
console.log('Test 3: Suivi de transcription');
trackTranscription(1500);
trackTranscription(1800);
trackTranscription(1200);
console.log('✓ Transcriptions suivies\n');

// Test 4: Track voice command
console.log('Test 4: Suivi de commandes vocales');
trackVoiceCommand('showVerse');
trackVoiceCommand('hideVerse');
trackVoiceCommand('showVerse');
console.log('✓ Commandes vocales suivies\n');

// Test 5: Track language usage
console.log('Test 5: Suivi d\'utilisation de langue');
trackLanguageUsage('fr');
trackLanguageUsage('en');
trackLanguageUsage('fr');
console.log('✓ Utilisation de langues suivie\n');

// Test 6: Track detection confidence
console.log('Test 6: Suivi de confiance de détection');
trackDetectionConfidence(0.9);
trackDetectionConfidence(0.85);
trackDetectionConfidence(0.7);
console.log('✓ Confiance de détection suivie\n');

// Test 7: Track errors
console.log('Test 7: Suivi d\'erreurs');
trackError('transcription');
trackError('detection');
trackError('network');
console.log('✓ Erreurs suivies\n');

// Test 8: Update peak users
console.log('Test 8: Mise à jour des utilisateurs max');
updatePeakUsers(5);
updatePeakUsers(10);
updatePeakUsers(7);
console.log('✓ Utilisateurs max mis à jour\n');

// Test 9: Get analytics report
console.log('Test 9: Rapport d\'analytics');
const report = getAnalyticsReport();
console.log('Rapport:', JSON.stringify(report, null, 2));
console.log('✓ Rapport généré\n');

// Test 10: Get insights
console.log('Test 10: Insights');
const insights = getInsights();
console.log('Insights:', insights);
console.log('✓ Insights générés\n');

// Test 11: End session
console.log('Test 11: Fin de session');
endSession();
console.log('✓ Session terminée\n');

// Test 12: Reset metrics
console.log('Test 12: Réinitialisation des métriques');
resetMetrics();
const reportAfterReset = getAnalyticsReport();
console.log('Métriques après réinitialisation:', reportAfterReset.overview);
console.log('✓ Métriques réinitialisées\n');

console.log('=== Tous les tests Analytics réussis ===');