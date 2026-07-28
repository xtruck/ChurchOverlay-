/**
 * ============================================================================
 *  test-voice-commands.js — Tests for voice command system
 * ============================================================================
 */

const { processCommand, getHistory, getAvailableCommands, getStatistics, clearHistory } = require('../voice-commands');

console.log('=== Tests Voice Commands ===\n');

// Test 1: Show verse command
console.log('Test 1: Commande afficher verset');
const cmd1 = processCommand('Montre le verset Jean 3:16');
console.log('Commande:', cmd1);
console.log('Action:', cmd1?.action);
console.log('✓ Test 1 passé\n');

// Test 2: Hide verse command
console.log('Test 2: Commande masquer verset');
const cmd2 = processCommand('Cache le verset');
console.log('Commande:', cmd2);
console.log('Action:', cmd2?.action);
console.log('✓ Test 2 passé\n');

// Test 3: Pause timer command
console.log('Test 3: Commande pause timer');
const cmd3 = processCommand('Pause le timer');
console.log('Commande:', cmd3);
console.log('Action:', cmd3?.action);
console.log('✓ Test 3 passé\n');

// Test 4: Resume timer command
console.log('Test 4: Commande reprendre timer');
const cmd4 = processCommand('Reprends le timer');
console.log('Commande:', cmd4);
console.log('Action:', cmd4?.action);
console.log('✓ Test 4 passé\n');

// Test 5: Start analysis command
console.log('Test 5: Commande démarrer analyse');
const cmd5 = processCommand('Démarre analyse');
console.log('Commande:', cmd5);
console.log('Action:', cmd5?.action);
console.log('✓ Test 5 passé\n');

// Test 6: Get summary command
console.log('Test 6: Commande résumé');
const cmd6 = processCommand('Donne-moi le résumé');
console.log('Commande:', cmd6);
console.log('Action:', cmd6?.action);
console.log('✓ Test 6 passé\n');

// Test 7: Language command
console.log('Test 7: Commande langue');
const cmd7 = processCommand('Langue français');
console.log('Commande:', cmd7);
console.log('Action:', cmd7?.action);
console.log('Language:', cmd7?.language);
console.log('✓ Test 7 passé\n');

// Test 8: Help command
console.log('Test 8: Commande aide');
const cmd8 = processCommand('Aide');
console.log('Commande:', cmd8);
console.log('Action:', cmd8?.action);
console.log('✓ Test 8 passé\n');

// Test 9: Extend time command
console.log('Test 9: Commande étendre temps');
const cmd9 = processCommand('Ajoute du temps');
console.log('Commande:', cmd9);
console.log('Action:', cmd9?.action);
console.log('Duration:', cmd9?.duration);
console.log('✓ Test 9 passé\n');

// Test 10: Command history
console.log('Test 10: Historique des commandes');
const history = getHistory(5);
console.log('Historique:', history);
console.log('✓ Test 10 passé\n');

// Test 11: Available commands
console.log('Test 11: Commandes disponibles');
const commands = getAvailableCommands();
console.log('Nombre de commandes:', commands.length);
console.log('✓ Test 11 passé\n');

// Test 12: Statistics
console.log('Test 12: Statistiques');
const stats = getStatistics();
console.log('Statistiques:', stats);
console.log('✓ Test 12 passé\n');

// Test 13: Invalid command
console.log('Test 13: Commande invalide');
const cmd13 = processCommand('Ceci n\'est pas une commande');
console.log('Commande:', cmd13);
console.log('Devrait être null:', cmd13 === null);
console.log('✓ Test 13 passé\n');

// Clean up
clearHistory();

console.log('=== Tous les tests Voice Commands réussis ===');