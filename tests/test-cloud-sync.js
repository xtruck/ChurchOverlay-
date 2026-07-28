/**
 * ============================================================================
 *  test-cloud-sync.js — Tests for cloud sync system
 * ============================================================================
 */

const { setProvider, startAutoSync, stopAutoSync, queueSync, syncAll, backupSermon, backupVerse, backupAnalytics, getSyncStatus, getBackups, cleanupOldBackups, exportAllData } = require('../cloud-sync');

async function runTests() {
  console.log('=== Tests Cloud Sync System ===\n');

  // Test 1: Get sync status
  console.log('Test 1: Statut de synchronisation');
  const status = getSyncStatus();
  console.log('Statut:', status);
  console.log('✓ Statut récupéré\n');

  // Test 2: Backup verse
  console.log('Test 2: Sauvegarde de verset');
  await backupVerse({ reference: 'Jean 3:16', text: 'Car Dieu a tant aimé le monde...', timestamp: Date.now() });
  console.log('✓ Verset sauvegardé\n');

  // Test 3: Backup sermon
  console.log('Test 3: Sauvegarde de sermon');
  await backupSermon({ summary: 'Sermon sur l\'amour', duration: 3600000, timestamp: Date.now() });
  console.log('✓ Sermon sauvegardé\n');

  // Test 4: Backup analytics
  console.log('Test 4: Sauvegarde d\'analytics');
  await backupAnalytics({ totalVerses: 10, averageConfidence: 0.85, timestamp: Date.now() });
  console.log('✓ Analytics sauvegardés\n');

  // Test 5: Sync all
  console.log('Test 5: Synchronisation de tous');
  await syncAll();
  console.log('✓ Synchronisation terminée\n');

  // Test 6: Get backups
  console.log('Test 6: Récupération des sauvegardes');
  const backups = await getBackups();
  console.log('Nombre de sauvegardes:', backups.length);
  console.log('Types:', backups.map(b => b.type));
  console.log('✓ Sauvegardes récupérées\n');

  // Test 7: Get specific type backups
  console.log('Test 7: Récupération des sauvegardes de versets');
  const verseBackups = await getBackups('verse');
  console.log('Sauvegardes de versets:', verseBackups.length);
  console.log('✓ Sauvegardes de versets récupérées\n');

  // Test 8: Start auto sync
  console.log('Test 8: Démarrage de la synchronisation automatique');
  startAutoSync(10000); // 10 seconds for testing
  console.log('✓ Synchronisation automatique démarrée\n');

  // Test 9: Queue sync
  console.log('Test 9: File d\'attente de synchronisation');
  queueSync('test', { data: 'test data' });
  console.log('✓ Élément mis en file d\'attente\n');

  // Test 10: Stop auto sync
  console.log('Test 10: Arrêt de la synchronisation automatique');
  stopAutoSync();
  console.log('✓ Synchronisation automatique arrêtée\n');

  // Test 11: Export all data
  console.log('Test 11: Export de toutes les données');
  const exportData = await exportAllData();
  console.log('Données exportées:', exportData.totalBackups, 'éléments');
  console.log('✓ Données exportées\n');

  // Test 12: Cleanup old backups
  console.log('Test 12: Nettoyage des anciennes sauvegardes');
  const deletedCount = await cleanupOldBackups(1); // Clean backups older than 1 day
  console.log('Sauvegardes supprimées:', deletedCount);
  console.log('✓ Nettoyage terminé\n');

  console.log('=== Tous les tests Cloud Sync réussis ===');
}

runTests().catch(error => {
  console.error('Erreur lors des tests:', error);
  process.exit(1);
});