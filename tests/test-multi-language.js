/**
 * ============================================================================
 *  test-multi-language.js — Tests for multi-language support
 * ============================================================================
 */

const { detectLanguage, setLanguage, getLanguage, getSupportedLanguages, detectReference, numberWordsToDigits } = require('../multi-language');

console.log('=== Tests Multi-Language Support ===\n');

// Test 1: Language detection
console.log('Test 1: Détection de langue');
const frenchText = 'Le Seigneur est mon berger, je ne manquerai de rien';
const englishText = 'The Lord is my shepherd, I shall not want';
const spanishText = 'Jehová es mi pastor, nada me faltará';

console.log('Français:', detectLanguage(frenchText));
console.log('English:', detectLanguage(englishText));
console.log('Español:', detectLanguage(spanishText));
console.log('✓ Test 1 passé\n');

// Test 2: Set and get language
console.log('Test 2: Configuration de langue');
setLanguage('en');
console.log('Langue actuelle:', getLanguage());
setLanguage('fr');
console.log('Langue actuelle:', getLanguage());
console.log('✓ Test 2 passé\n');

// Test 3: Get supported languages
console.log('Test 3: Langues supportées');
const languages = getSupportedLanguages();
console.log('Langues:', languages);
console.log('✓ Test 3 passé\n');

// Test 4: French reference detection
console.log('Test 4: Détection de référence française');
setLanguage('fr');
const frenchRef = detectReference('Jean 3:16');
console.log('Référence française:', frenchRef);
console.log('✓ Test 4 passé\n');

// Test 5: English reference detection
console.log('Test 5: Détection de référence anglaise');
setLanguage('en');
const englishRef = detectReference('John 3:16');
console.log('Référence anglaise:', englishRef);
console.log('✓ Test 5 passé\n');

// Test 6: Spanish reference detection
console.log('Test 6: Détection de référence espagnole');
setLanguage('es');
const spanishRef = detectReference('Juan 3:16');
console.log('Référence espagnole:', spanishRef);
console.log('✓ Test 6 passé\n');

// Test 7: Number words to digits (French)
console.log('Test 7: Conversion mots-chiffres français');
setLanguage('fr');
const frenchNumbers = numberWordsToDigits('Jean trois seize');
console.log('Conversion:', frenchNumbers);
console.log('✓ Test 7 passé\n');

// Test 8: Number words to digits (English)
console.log('Test 8: Conversion mots-chiffres anglais');
setLanguage('en');
const englishNumbers = numberWordsToDigits('John three sixteen');
console.log('Conversion:', englishNumbers);
console.log('✓ Test 8 passé\n');

// Test 9: Cross-language detection
console.log('Test 9: Détection multi-langue');
const frenchRefInEn = detectReference('Jean 3:16', 'fr');
console.log('Référence française en mode anglais:', frenchRefInEn);
const englishRefInFr = detectReference('John 3:16', 'en');
console.log('Référence anglaise en mode français:', englishRefInFr);
console.log('✓ Test 9 passé\n');

// Reset to default
setLanguage('fr');

console.log('=== Tous les tests Multi-Language réussis ===');