/**
 * ============================================================================
 *  test-sermon-qa.js — Tests pour sermon-qa.js
 * ----------------------------------------------------------------------------
 *  Le test le plus important ici (cahier des charges — Point 5, garde-fou
 *  "jamais de réponse sans citation source") : quand la recherche par
 *  mots-clés ne trouve AUCUN contenu pertinent, chatCompletion() ne doit
 *  JAMAIS être appelée — pas seulement "le prompt le lui demande", une
 *  vérification structurelle que le modèle n'est même pas sollicité.
 *
 *  Même approche que test/integration-session-stats.js : sermon-archive.js
 *  et groq-wrapper.js sont mockés (injectFakeModule) AVANT de requérir
 *  sermon-qa.js, qui les requiert lui-même à son propre chargement.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

console.log('=== Test Sermon Q&A ===\n');

const SERMON_1 = {
  date: '2026-06-01T10:00:00.000Z',
  theme: 'La grâce de Dieu',
  fullTranscript:
    "Aujourd'hui nous parlons de la grace de Dieu envers nous. " +
    'La grace est un don gratuit, pas quelque chose que nous meritons. ' +
    'Dieu nous aime malgre nos fautes et nos erreurs. ' +
    "C'est cela le coeur de l'evangile, la grace qui sauve.",
};
const SERMON_2 = {
  date: '2026-06-08T10:00:00.000Z',
  theme: "La priere et l'intercession",
  fullTranscript:
    'La priere est essentielle dans la vie du croyant. ' +
    'Quand nous prions, nous entrons en communion avec Dieu. ' +
    "L'intercession consiste a prier pour les autres avec perseverance.",
};

let chatCompletionCalls = [];
function resetMock() {
  chatCompletionCalls = [];
}

injectFakeModule('sermon-archive.js', {
  getAllTranscripts: () => [SERMON_1, SERMON_2],
});
injectFakeModule('groq-wrapper.js', {
  chatCompletion: async (prompt, options) => {
    chatCompletionCalls.push({ prompt, options });
    return { text: 'Réponse générée à partir des sources fournies.', model: 'fake', usage: {} };
  },
});

const sermonQa = require('../sermon-qa');

// Test 1 : chunkText() découpe sur des frontières de phrase, autour de la
// taille cible.
console.log('[TEST] Test 1: chunkText()...');
const longText = 'Phrase courte. '.repeat(100);
const chunks = sermonQa.chunkText(longText);
assert(chunks.length > 1, 'un texte long doit être découpé en plusieurs fenêtres');
for (const chunk of chunks) {
  assert(
    chunk.length <= 700,
    `chunk trop long (${chunk.length} caractères) : "${chunk.slice(0, 40)}..."`
  );
  assert(
    !chunk.startsWith(' ') && !chunk.endsWith(' '),
    "chunk ne doit pas avoir d'espaces superflus en bordure"
  );
}
assert.deepStrictEqual(sermonQa.chunkText(''), [], 'texte vide -> aucune fenêtre');
console.log('[TEST] ✓ Découpage en fenêtres correct\n');

// Test 2 : wordOverlapScore() — similarité de recouvrement de mots.
console.log('[TEST] Test 2: wordOverlapScore()...');
assert(
  sermonQa.wordOverlapScore('la grace de Dieu', 'Dieu nous donne sa grace') > 0.3,
  'des textes proches doivent avoir un score élevé'
);
assert.strictEqual(
  sermonQa.wordOverlapScore('la grace de Dieu', 'le chat dort sur le tapis'),
  0,
  'des textes sans rapport doivent avoir un score de zéro'
);
console.log('[TEST] ✓ Score de recouvrement correct\n');

// Test 3 : retrieveRelevantChunks() — classe le bon sermon en tête. Le
// sermon sur la prière peut aussi apparaître (mot partagé "Dieu"), mais
// avec un score nettement plus bas — trié en conséquence, pas exclu en dur.
console.log('[TEST] Test 3: retrieveRelevantChunks()...');
const graceResults = sermonQa.retrieveRelevantChunks('Que dit la Bible sur la grace de Dieu ?');
assert(graceResults.length > 0, 'une question sur la grâce doit trouver des passages pertinents');
assert.strictEqual(
  graceResults[0].theme,
  'La grâce de Dieu',
  'le sermon le plus pertinent doit être classé en premier'
);
assert(
  graceResults.every((r, i) => i === 0 || graceResults[i - 1].score >= r.score),
  'les résultats doivent être triés par score décroissant'
);
console.log('[TEST] ✓ Recherche par mots-clés correcte (classement par pertinence)\n');

// Test 4 (LE PLUS IMPORTANT) : askQuestion() sans contenu pertinent
// n'appelle JAMAIS chatCompletion() — garde-fou structurel, pas juste une
// instruction de prompt.
console.log("[TEST] Test 4: askQuestion() sans contenu pertinent -> pas d'appel LLM...");
resetMock();
(async () => {
  const noMatchResult = await sermonQa.askQuestion('Quelle est la recette du gateau au chocolat ?');
  assert.strictEqual(noMatchResult.ok, true);
  assert.strictEqual(
    noMatchResult.answered,
    false,
    'sans contenu pertinent, answered doit être false'
  );
  assert(
    typeof noMatchResult.message === 'string' && noMatchResult.message.length > 0,
    'un message explicatif doit être renvoyé'
  );
  assert.strictEqual(
    chatCompletionCalls.length,
    0,
    'chatCompletion() ne doit JAMAIS être appelée sans contenu pertinent trouvé'
  );
  console.log('[TEST] ✓ Aucun appel LLM sans source à citer\n');

  // Test 5 : askQuestion() AVEC contenu pertinent appelle bien le LLM et
  // renvoie les sources à côté de la réponse.
  console.log('[TEST] Test 5: askQuestion() avec contenu pertinent...');
  resetMock();
  const matchResult = await sermonQa.askQuestion('Que dit le pasteur sur la grace de Dieu ?');
  assert.strictEqual(matchResult.ok, true);
  assert.strictEqual(matchResult.answered, true);
  assert.strictEqual(
    chatCompletionCalls.length,
    1,
    'chatCompletion() doit être appelée une seule fois'
  );
  assert(
    chatCompletionCalls[0].prompt.includes('grace'),
    'le prompt envoyé au LLM doit inclure les extraits pertinents'
  );
  assert(
    Array.isArray(matchResult.sources) && matchResult.sources.length > 0,
    'des sources doivent être renvoyées'
  );
  assert(
    matchResult.sources[0].label.includes('grâce'),
    'la source renvoyée doit référencer le bon sermon'
  );
  console.log('[TEST] ✓ Réponse générée avec sources citées\n');

  // Test 6 : question vide rejetée sans même consulter l'archive.
  console.log('[TEST] Test 6: askQuestion() avec une question vide...');
  resetMock();
  const emptyResult = await sermonQa.askQuestion('   ');
  assert.strictEqual(emptyResult.ok, false);
  assert.strictEqual(chatCompletionCalls.length, 0);
  console.log('[TEST] ✓ Question vide rejetée proprement\n');

  console.log('=== Tous les tests sermon-qa sont passés ===');
})().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
