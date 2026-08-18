'use strict';
/**
 * Tests unitaires pour embedding-provider.js — embedTexts()/embedQuery().
 * @google/genai est mocké via injection de module (même technique que
 * integration-quote-match.js) — aucun appel réseau réel.
 */
const Module = require('module');

// CORRECTIF (trouvé en écrivant ce test) : injectFakeModule() dans les
// tests d'intégration existants (integration-quote-match.js et consorts)
// résout un CHEMIN RELATIF de fichier propre à ce dépôt (ex. "server.js"),
// où require.resolve(path.join(__dirname, '..', relativePath)) et le
// require(spécificateur) fait par le code testé pointent forcément vers le
// même fichier. @google/genai est un PAQUET npm avec un champ "exports"
// conditionnel (require -> dist/node/index.cjs, différent de "main") : le
// résoudre via un chemin construit à la main ne tombe pas sur le même
// fichier que le `require('@google/genai')` fait par embedding-provider.js,
// donc le mock n'interceptait rien — un VRAI appel réseau partait (constaté :
// erreur "API key not valid" renvoyée par Google, donc requête bien envoyée).
// require.resolve('@google/genai') (spécificateur nu, résolu depuis CE
// fichier de test) retombe sur le même chemin que la résolution faite par
// embedding-provider.js, les deux fichiers étant dans le même arbre
// node_modules.
function injectFakeModule(specifier, exportsObj) {
  const abs = require.resolve(specifier);
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

async function run() {
  const originalKey = process.env.GEMINI_API_KEY;

  // --- Sans GEMINI_API_KEY : jamais d'exception, renvoie null ---
  delete process.env.GEMINI_API_KEY;
  delete require.cache[require.resolve('../embedding-provider')];
  {
    const { embedTexts, embedQuery } = require('../embedding-provider');
    const r1 = await embedTexts(['jean 3:16']);
    check('embedTexts sans clé: renvoie null', r1 === null);
    const r2 = await embedQuery('amour');
    check('embedQuery sans clé: renvoie null', r2 === null);
  }

  // --- Tableau vide : pas d'appel réseau, renvoie [] même sans clé ---
  {
    const { embedTexts } = require('../embedding-provider');
    const r = await embedTexts([]);
    check('embedTexts([]): renvoie [] sans appel réseau', Array.isArray(r) && r.length === 0);
  }

  // --- Avec clé, mock GoogleGenAI : appel réussi ---
  process.env.GEMINI_API_KEY = 'fake-key-for-test';
  let lastCall = null;
  injectFakeModule('@google/genai', {
    GoogleGenAI: class {
      constructor() {}
      get models() {
        return {
          embedContent: async (params) => {
            lastCall = params;
            return {
              embeddings: params.contents.map((_, i) => ({ values: [i, i + 1, i + 2] })),
            };
          },
        };
      }
    },
  });
  delete require.cache[require.resolve('../embedding-provider')];
  {
    const { embedTexts, embedQuery, CONFIG } = require('../embedding-provider');
    const r = await embedTexts(['Jean 3:16', 'Psaume 23:1']);
    check('embedTexts avec clé: 2 vecteurs pour 2 textes', Array.isArray(r) && r.length === 2);
    check('embedTexts: vecteur dans l\'ordre d\'entrée', r[0][0] === 0 && r[1][0] === 1);
    check('embedTexts: modèle correct transmis', lastCall.model === CONFIG.MODEL);
    check(
      'embedTexts: taskType par défaut = RETRIEVAL_DOCUMENT',
      lastCall.config.taskType === 'RETRIEVAL_DOCUMENT'
    );

    const q = await embedQuery('la grace de dieu');
    check('embedQuery: renvoie le premier (et seul) vecteur', Array.isArray(q) && q.length === 3);
    check('embedQuery: taskType = RETRIEVAL_QUERY', lastCall.config.taskType === 'RETRIEVAL_QUERY');
  }

  // --- Réponse Gemini incomplète (moins d'embeddings que de textes) ---
  injectFakeModule('@google/genai', {
    GoogleGenAI: class {
      constructor() {}
      get models() {
        return { embedContent: async () => ({ embeddings: [{ values: [1, 2, 3] }] }) };
      }
    },
  });
  delete require.cache[require.resolve('../embedding-provider')];
  {
    const { embedTexts } = require('../embedding-provider');
    const r = await embedTexts(['un', 'deux', 'trois']);
    check('embedTexts: réponse incomplète -> null (pas de crash, pas de silence)', r === null);
  }

  // --- Erreur réseau/API ---
  injectFakeModule('@google/genai', {
    GoogleGenAI: class {
      constructor() {}
      get models() {
        return {
          embedContent: async () => {
            throw new Error('quota exceeded');
          },
        };
      }
    },
  });
  delete require.cache[require.resolve('../embedding-provider')];
  {
    const { embedTexts } = require('../embedding-provider');
    const r = await embedTexts(['jean 3:16']);
    check('embedTexts: erreur API -> null (pas de crash)', r === null);
  }

  // --- Nettoyage ---
  delete require.cache[require.resolve('@google/genai')];
  delete require.cache[require.resolve('../embedding-provider')];
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalKey;

  console.log(`\n=== Résultat embedding-provider : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
}

run();
