/**
 * test-ai-enricher.js — Tests pour ai-enricher.js
 *
 * CORRECTIF (bug reproductible en usage réel — voir ai-enricher.js#
 * detectSermonTheme) : Groq répondait 400 json_validate_failed à
 * failed_generation VIDE sur detectSermonTheme/generatePostServiceRecap/
 * findCrossReferences — les trois utilisaient json_mode:true (validation
 * JSON STRICTE côté Groq) avec GROQ_MODEL_CHAT ('openai/gpt-oss-20b', un
 * modèle de raisonnement pas garanti de produire une sortie strictement
 * conforme sous ce mode). Retiré au profit d'une réponse libre + extraction
 * tolérante (extractJsonObject), déjà éprouvée par semantic-detector.js sur
 * ce même modèle. Ce test vérifie : (1) json_mode n'est plus jamais
 * transmis, (2) l'extraction reste correcte sur une réponse "libre"
 * (préambule de raisonnement, bloc ```json```, etc. — pas du JSON pur),
 * (3) le retry existant absorbe toujours une tentative sans JSON exploitable.
 */
'use strict';
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

function loadAiEnricherWith(chatCompletionImpl) {
  const calls = [];
  injectFakeModule('groq-wrapper.js', {
    isChatRateLimited() {
      return false;
    },
    async chatCompletion(prompt, options) {
      calls.push({ prompt, options });
      return chatCompletionImpl(prompt, options, calls.length);
    },
  });
  delete require.cache[require.resolve('../ai-enricher')];
  const aiEnricher = require('../ai-enricher');
  return { aiEnricher, calls };
}

async function run() {
  console.log('=== Test ai-enricher ===\n');

  console.log('[TEST] Test 1: detectSermonTheme ne transmet plus json_mode à chatCompletion...');
  {
    const { aiEnricher, calls } = loadAiEnricherWith(async () => ({
      text: '{"theme":"La grâce","keywords":["grâce","pardon","foi"]}',
    }));
    const result = await aiEnricher.detectSermonTheme(
      'Un extrait de sermon suffisamment long pour dépasser le seuil minimum requis par cette fonction.'
    );
    check('json_mode absent des options transmises', calls[0].options.json_mode === undefined);
    check(
      'thème correctement extrait malgré json_mode absent',
      result && result.theme === 'La grâce' && result.keywords.length === 3
    );
  }
  console.log();

  console.log(
    '[TEST] Test 2: detectSermonTheme extrait le JSON même noyé dans du texte libre (préambule de raisonnement)...'
  );
  {
    // Simule un modèle de raisonnement qui produit du texte AVANT le JSON —
    // exactement le genre de réponse que json_mode strict aurait rejetée
    // côté Groq, mais qu'extractJsonObject sait retrouver.
    const { aiEnricher } = loadAiEnricherWith(async () => ({
      text: 'Voici mon analyse : le thème principal est clair.\n```json\n{"theme":"Persévérance","keywords":["endurance","foi","épreuve"]}\n```',
    }));
    const result = await aiEnricher.detectSermonTheme(
      'Un extrait de sermon suffisamment long pour dépasser le seuil minimum requis par cette fonction.'
    );
    check(
      'thème extrait depuis un bloc ```json``` noyé dans du texte',
      result && result.theme === 'Persévérance'
    );
  }
  console.log();

  console.log(
    '[TEST] Test 3: detectSermonTheme retente une fois si la 1ère réponse ne contient aucun JSON exploitable...'
  );
  {
    const { aiEnricher, calls } = loadAiEnricherWith(async (_p, _o, callNumber) =>
      callNumber === 1
        ? { text: "Je réfléchis encore, aucune réponse structurée pour l'instant." }
        : { text: '{"theme":"Espérance","keywords":["espoir","avenir","promesse"]}' }
    );
    const result = await aiEnricher.detectSermonTheme(
      'Un extrait de sermon suffisamment long pour dépasser le seuil minimum requis par cette fonction.'
    );
    check('deux tentatives effectuées (retry sur JSON introuvable)', calls.length === 2);
    check('thème obtenu après le retry', result && result.theme === 'Espérance');
  }
  console.log();

  console.log(
    '[TEST] Test 4: detectSermonTheme renvoie null (jamais une exception) si aucune tentative ne produit de JSON...'
  );
  {
    const { aiEnricher, calls } = loadAiEnricherWith(async () => ({
      text: 'Toujours rien de structuré.',
    }));
    const result = await aiEnricher.detectSermonTheme(
      'Un extrait de sermon suffisamment long pour dépasser le seuil minimum requis par cette fonction.'
    );
    check('exactement 2 tentatives (retry épuisé), pas de boucle infinie', calls.length === 2);
    check("null renvoyé plutôt qu'une exception non gérée", result === null);
  }
  console.log();

  console.log(
    '[TEST] Test 5: detectSermonTheme retente toujours sur un vrai 400 json_validate_failed (comportement existant préservé)...'
  );
  {
    const { aiEnricher, calls } = loadAiEnricherWith(async (_p, _o, callNumber) => {
      if (callNumber === 1) throw new Error('Groq Chat API a répondu 400: json_validate_failed');
      return { text: '{"theme":"Fidélité","keywords":["confiance","engagement","durée"]}' };
    });
    const result = await aiEnricher.detectSermonTheme(
      'Un extrait de sermon suffisamment long pour dépasser le seuil minimum requis par cette fonction.'
    );
    check('deux tentatives effectuées (retry sur 400 json_validate_failed)', calls.length === 2);
    check('thème obtenu après le retry sur erreur', result && result.theme === 'Fidélité');
  }
  console.log();

  console.log(
    '[TEST] Test 6: generatePostServiceRecap et findCrossReferences ne transmettent plus json_mode non plus...'
  );
  {
    const { aiEnricher, calls } = loadAiEnricherWith(async () => ({
      text: '{"title":"T","keyPoints":["a","b","c","d","e"],"application":"App","memoryVerse":"Jean 3:16"}',
    }));
    await aiEnricher.generatePostServiceRecap('Transcription complète du sermon.', []);
    check('generatePostServiceRecap : json_mode absent', calls[0].options.json_mode === undefined);
  }
  {
    const { aiEnricher, calls } = loadAiEnricherWith(async () => ({
      text: '[{"ref":"Romains 8:28","reason":"Thème lié"}]',
    }));
    await aiEnricher.findCrossReferences('Jean 3:16', 'Car Dieu a tant aimé le monde...');
    check('findCrossReferences : json_mode absent', calls[0].options.json_mode === undefined);
  }
  console.log();

  console.log(`\n=== Résultat ai-enricher : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec fatal:', err.message);
  process.exit(1);
});
