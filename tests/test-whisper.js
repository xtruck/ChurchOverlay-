/**
 * ============================================================================
 *  test-whisper.js — Script de test pour whisper-wrapper.js
 * ----------------------------------------------------------------------------
 *  Teste le démarrage, l'arrêt et les fonctionnalités de base du module
 *  Whisper Speech-to-Text.
 *
 *  USAGE:
 *    npm install                    (pour installer form-data)
 *    node test-whisper.js           (test démarrage/arrêt)
 * ============================================================================
 */

const whisper = require('./whisper-wrapper');

console.log('=== Test Whisper Wrapper ===\n');

// Configuration des callbacks
whisper.on({
  onReady: () => {
    console.log('[TEST] Serveur Whisper prêt !');
    console.log('[TEST] Configuration:', whisper.getConfig());
  },
  onTranscript: (result) => {
    console.log('[TEST] Transcription reçue:', JSON.stringify(result, null, 2));
  },
  onError: (error) => {
    console.error('[TEST] Erreur Whisper:', error);
  },
});

// Test 1: Démarrage du serveur
console.log('[TEST] Test 1: Démarrage du serveur Whisper...');
whisper.startServer()
  .then(() => {
    console.log('[TEST] ✓ Serveur démarré avec succès');
    console.log('[TEST] État running:', whisper.isRunning());

    // Attendre 5 secondes puis arrêter
    setTimeout(() => {
      console.log('\n[TEST] Test 2: Arrêt du serveur Whisper...');
      whisper.stopServer()
        .then(() => {
          console.log('[TEST] ✓ Serveur arrêté avec succès');
          console.log('[TEST] État running:', whisper.isRunning());
          console.log('\n=== Tests terminés ===');
          process.exit(0);
        })
        .catch((err) => {
          console.error('[TEST] ✗ Erreur lors de l\'arrêt:', err.message);
          process.exit(1);
        });
    }, 5000);
  })
  .catch((err) => {
    console.error('[TEST] ✗ Erreur lors du démarrage:', err.message);
    process.exit(1);
  });

// Gestion Ctrl+C pour arrêt propre
process.on('SIGINT', () => {
  console.log('\n[TEST] Interruption détectée, arrêt du serveur...');
  whisper.stopServer()
    .then(() => {
      console.log('[TEST] Serveur arrêté');
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
});
