/**
 * ============================================================================
 *  test-audio-capture.js — Script de test pour audio-capture.js
 * ----------------------------------------------------------------------------
 *  Teste la capture audio et la création de segments WAV.
 *
 *  PRÉREQUIS:
 *    - FFmpeg doit être installé et disponible dans PATH
 *    - Un micro doit être connecté
 *
 *  USAGE:
 *    node test-audio-capture.js
 * ============================================================================
 */

const audioCapture = require('../audio-capture');

console.log('=== Test Audio Capture ===\n');

// Configuration des callbacks
audioCapture.on({
  onAudioSegment: (segmentFile) => {
    console.log('[TEST] Segment audio créé:', segmentFile);
    console.log('[TEST] Configuration:', audioCapture.getConfig());
  },
  onError: (error) => {
    console.error('[TEST] Erreur capture audio:', error.message);
  },
});

// Test 1: Démarrage de la capture audio
console.log('[TEST] Test 1: Démarrage de la capture audio (10 secondes)...');
audioCapture.startRecording()
  .then(() => {
    console.log('[TEST] ✓ Capture audio démarrée');
    console.log('[TEST] État recording:', audioCapture.isRecording());

    // Arrêter après 10 secondes
    setTimeout(() => {
      console.log('\n[TEST] Test 2: Arrêt de la capture audio...');
      audioCapture.stopRecording()
        .then(() => {
          console.log('[TEST] ✓ Capture audio arrêtée');
          console.log('[TEST] État recording:', audioCapture.isRecording());
          
          // Nettoyer les fichiers temporaires
          console.log('\n[TEST] Test 3: Nettoyage des fichiers temporaires...');
          audioCapture.cleanupTempFiles();
          console.log('[TEST] ✓ Nettoyage terminé');
          
          console.log('\n=== Tests terminés ===');
          process.exit(0);
        })
        .catch((err) => {
          console.error('[TEST] ✗ Erreur lors de l\'arrêt:', err.message);
          process.exit(1);
        });
    }, 10000);
  })
  .catch((err) => {
    console.error('[TEST] ✗ Erreur lors du démarrage:', err.message);
    console.error('[TEST] Assurez-vous que FFmpeg est installé et dans PATH');
    process.exit(1);
  });

// Gestion Ctrl+C pour arrêt propre
process.on('SIGINT', () => {
  console.log('\n[TEST] Interruption détectée, arrêt de la capture...');
  audioCapture.stopRecording()
    .then(() => {
      audioCapture.cleanupTempFiles();
      console.log('[TEST] Capture arrêtée et nettoyée');
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
});
