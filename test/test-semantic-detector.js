'use strict';
/**
 * Tests unitaires pour semantic-detector.js — SemanticDetector, looksBiblical, parseResponse.
 * Couvre : pré-filtre biblique, groq manquant/invalide, parsing réponse LLM,
 * confidence trop basse, référence null, context history, erreur LLM.
 * Les appels LLM sont mockés — pas de vrai appel API.
 */
const assert = require('assert');
const { SemanticDetector, CONFIG } = require('../semantic-detector');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

console.log('=== Tests semantic-detector.js ===');

// --- looksBiblical: rejet texte non biblique ---
const d1 = new SemanticDetector({ chatCompletion: async () => ({ text: '{}' }) });
d1.detect('il fait beau aujourd hui').then((r) => {
  check('texte non biblique: retourne null sans appel LLM', r === null);
});

// --- Groq wrapper manquant ---
const d2 = new SemanticDetector(null);
d2.detect('jesus marche sur les eaux').then((r) => {
  check('groq null: retourne null sans crash', r === null);
});

// --- Groq wrapper invalide ---
const d3 = new SemanticDetector({ notAFunction: true });
d3.detect('jesus marche sur les eaux').then((r) => {
  check('groq invalide: retourne null sans crash', r === null);
});

// --- Parsing réponse LLM valide ---
const mockGroqValid = {
  chatCompletion: async () => ({
    text: JSON.stringify({
      reference: 'Matthieu 14:25',
      confidence: 0.92,
      reasoning: "Jésus marche sur l'eau",
      alternativeRefs: ['Marc 6:48'],
    }),
    model: 'test',
    usage: {},
  }),
};
const d4 = new SemanticDetector(mockGroqValid);
d4.clearCache();
d4.detect('le passage où jesus marche sur les eaux').then((r) => {
  check('réponse valide: référence détectée', r && r.raw === 'Matthieu 14:25');
  check('réponse valide: confidence = 0.92', r && r.confidence === 0.92);
  check('réponse valide: book = matthieu', r && r.book === 'matthieu');
  check('réponse valide: chapter = 14', r && r.chapter === 14);
  check('réponse valide: verseStart = 25', r && r.verseStart === 25);
  check('réponse valide: detectedBy = semantic', r && r.detectedBy === 'semantic');
  check('réponse valide: alternativeRefs', r && r.alternativeRefs.length === 1);
});

// --- Référence chapter only ---
const mockGroqChapter = {
  chatCompletion: async () => ({
    text: JSON.stringify({
      reference: 'Romains 8',
      confidence: 0.85,
      reasoning: 'Paul parle de la vie en Esprit',
      alternativeRefs: [],
    }),
    model: 'test',
    usage: {},
  }),
};
const d5 = new SemanticDetector(mockGroqChapter);
d5.clearCache();
d5.detect('paul écrit aux romains chapitre 8').then((r) => {
  check('chapter only: référence détectée', r && r.raw === 'Romains 8');
  check('chapter only: verseStart undefined', r && r.verseStart === undefined);
});

// --- Confidence trop basse → null ---
const mockGroqLow = {
  chatCompletion: async () => ({
    text: JSON.stringify({
      reference: 'Jean 3:16',
      confidence: 0.4,
      reasoning: 'Peut-être une référence',
      alternativeRefs: [],
    }),
    model: 'test',
    usage: {},
  }),
};
const d6 = new SemanticDetector(mockGroqLow);
d6.clearCache();
d6.detect('la vie est belle').then((r) => {
  check('confidence trop basse: retourne null', r === null);
});

// --- Réponse null (pas de référence) ---
const mockGroqNull = {
  chatCompletion: async () => ({
    text: JSON.stringify({
      reference: null,
      confidence: 0,
      reasoning: 'Aucune référence biblique',
      alternativeRefs: [],
    }),
    model: 'test',
    usage: {},
  }),
};
const d7 = new SemanticDetector(mockGroqNull);
d7.clearCache();
d7.detect('jesus est bon').then((r) => {
  check('référence null: retourne null', r === null);
});

// --- Erreur LLM → retourne null ---
const mockGroqError = {
  chatCompletion: async () => {
    throw new Error('API limit');
  },
};
const d8 = new SemanticDetector(mockGroqError);
d8.clearCache();
// AJOUT (A.2 — visibilité des échecs IA) : un échec d'appel LLM ne doit plus
// se limiter à un console.error invisible — onError() doit être notifié
// pour que server.js puisse le diffuser (voir action WS 'aiModuleError').
let d8OnErrorMessage = null;
d8.onError = (message) => {
  d8OnErrorMessage = message;
};
d8.detect('jesus guerit les malades').then((r) => {
  check('erreur LLM: retourne null sans crash', r === null);
  check('erreur LLM: onError notifié', d8OnErrorMessage === 'API limit');
  check('erreur LLM: getStats().errorCount incrémenté', d8.getStats().errorCount === 1);
});

// --- clearCache ---
const mockGroqClear = {
  chatCompletion: async () => ({
    text: JSON.stringify({
      reference: 'Marc 1:1',
      confidence: 0.88,
      reasoning: 'Commencement',
      alternativeRefs: [],
    }),
    model: 'test',
    usage: {},
  }),
};
const d9 = new SemanticDetector(mockGroqClear);
d9.clearCache();
d9.detect('jean baptiste baptise').then(() => {
  d9.clearCache();
  check('clearCache: cacheSize = 0', d9.getStats().cacheSize === 0);
  check('clearCache: contextWindow = 0', d9.getStats().contextWindow === 0);
});

// --- Context history ---
const d10 = new SemanticDetector({ chatCompletion: async () => ({ text: '{}' }) });
d10.addContext('premier fragment');
d10.addContext('deuxième fragment');
check('context history: taille = 2', d10.getStats().contextWindow === 2);
d10.addContext('troisième');
d10.addContext('quatrième');
d10.addContext('cinquième');
d10.addContext('sixième (dépasse la fenêtre)');
check(
  'context history: taille max = CONTEXT_WINDOW_SIZE',
  d10.getStats().contextWindow === CONFIG.CONTEXT_WINDOW_SIZE
);

// --- Texte normalisé sans accent ---
const mockGroqNorm = {
  chatCompletion: async () => ({
    text: JSON.stringify({
      reference: 'Genèse 1:1',
      confidence: 0.9,
      reasoning: 'Création',
      alternativeRefs: [],
    }),
    model: 'test',
    usage: {},
  }),
};
const d11 = new SemanticDetector(mockGroqNorm);
d11.clearCache();
d11.detect('au commencement dieu a cree les cieux').then((r) => {
  check('texte normalisé sans accent: mot biblique détecté', r !== null);
});

// --- Attendre les tests async puis afficher les résultats ---
setTimeout(() => {
  console.log(`\n=== Résultat semantic-detector : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
}, 2000);
