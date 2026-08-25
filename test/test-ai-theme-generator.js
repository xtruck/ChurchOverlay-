'use strict';
/**
 * Tests unitaires pour ai-theme-generator.js — AIThemeGenerator.
 * Couvre : repli sur thème par règles quand l'IA échoue, et notification
 * onError() (A.2 — visibilité des échecs IA, voir llm-utils.js).
 * Les appels LLM sont mockés — pas de vrai appel API.
 */
const assert = require('assert');
const { AIThemeGenerator } = require('../ai-theme-generator');

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

console.log('=== Tests ai-theme-generator.js ===');

async function runAsyncTests() {
  // --- Pas de groq : repli direct sur le thème par règles ---
  const g1 = new AIThemeGenerator(null);
  const t1 = await g1.generate('Réjouissez-vous, il y a de la joie', '', 'auto');
  check('sans groq: thème par règles (source rule)', t1.source === 'rule');
  check('sans groq: aucune erreur comptée', g1.getStats().errorCount === 0);

  // --- Groq échoue en plein appel : repli sur le thème par règles, ET
  //     onError notifié (avant ce chantier, seulement un console.warn) ---
  const mockGroqError = {
    chatCompletion: async () => {
      throw new Error('Groq indisponible');
    },
  };
  const g2 = new AIThemeGenerator(mockGroqError);
  let g2ErrorMessage = null;
  g2.onError = (message) => {
    g2ErrorMessage = message;
  };
  const t2 = await g2.generate('Réjouissez-vous, il y a de la joie', '', 'auto');
  check('erreur LLM: repli sur le thème par règles', t2.source === 'rule');
  check('erreur LLM: onError notifié', g2ErrorMessage === 'Groq indisponible');
  check('erreur LLM: getStats().errorCount incrémenté', g2.getStats().errorCount === 1);
  check('erreur LLM: getStats().lastError renseigné', g2.getStats().lastError.message === 'Groq indisponible');

  // --- Groq répond correctement : thème IA utilisé, pas d'erreur comptée ---
  const mockGroqOk = {
    chatCompletion: async () => ({
      text: JSON.stringify({
        name: 'Joie éclatante',
        backgroundGradient: 'linear-gradient(red, yellow)',
        textColor: '#ffffff',
        accentColor: '#ffcc00',
        fontFamily: 'sans-serif',
        animationStyle: 'bloom',
        particleColor: '#ffcc00',
        glowColor: 'rgba(255,204,0,0.5)',
        borderColor: 'rgba(255,255,255,0.3)',
        shadowColor: 'rgba(0,0,0,0.3)',
        mood: 'joy',
      }),
      model: 'test',
      usage: {},
    }),
  };
  const g3 = new AIThemeGenerator(mockGroqOk);
  const t3 = await g3.generate('Réjouissez-vous, il y a de la joie', '', 'auto');
  check('succès LLM: thème IA utilisé (source ai)', t3.source === 'ai');
  check('succès LLM: aucune erreur comptée', g3.getStats().errorCount === 0);
}

runAsyncTests().then(() => {
  console.log(`\n=== Résultat ai-theme-generator : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
});
