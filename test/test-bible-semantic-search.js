'use strict';
/**
 * Tests unitaires pour bible-semantic-search.js — BibleSemanticSearch.
 * Chemin mot-clé (TOPIC_INDEX) inchangé depuis avant le chantier 4.2 — testé
 * ici pour non-régression. Chemin vectoriel : embedding-provider.js mocké
 * (injection de module, voir test-embedding-provider.js pour la même
 * technique), bible-vector-store.js réel (sqlite-vec, fichier temporaire).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

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
  // --- Chemin mot-clé : loadIndex() sans fichier -> mode dégradé, mais
  // search() continue de fonctionner (non-régression du comportement
  // d'avant ce chantier) ---
  {
    delete require.cache[require.resolve('../bible-semantic-search')];
    const { BibleSemanticSearch } = require('../bible-semantic-search');
    const search = new BibleSemanticSearch();
    await search.loadIndex();
    check('loadIndex sans index: loaded = false', search.loaded === false);

    const r = await search.search('amour');
    check('search mot-clé (sujet direct): résultats non vides', r.length > 0);
    check('search mot-clé: source = keyword', r[0].source === 'keyword');
    check('search mot-clé: référence attendue présente', r.some((x) => x.reference === 'Jean 3:16'));

    const r2 = await search.search('galaxie lointaine improbable xyz');
    check('search: aucun mot-clé ni index vectoriel -> []', Array.isArray(r2) && r2.length === 0);
  }

  // --- Chemin vectoriel : index sqlite-vec réel + embedding mocké ---
  {
    const dbPath = path.join(
      os.tmpdir(),
      `test-bible-semantic-search-${Date.now()}.sqlite3`
    );

    // Construit un petit index réel à 3 dimensions (facile à raisonner).
    const { BibleVectorStore } = require('../bible-vector-store');
    const store = new BibleVectorStore({ dbPath, vectorDim: 3 });
    store.createForWriting();
    store.insertVerse({
      reference: 'Jean 3:16',
      book: 'jean',
      chapter: 3,
      verse: 16,
      text: 'Car Dieu a tant aimé le monde...',
      embedding: [1, 0, 0],
    });
    store.insertVerse({
      reference: 'Romains 8:28',
      book: 'romains',
      chapter: 8,
      verse: 28,
      text: 'Toutes choses concourent au bien...',
      embedding: [0.9, 0.1, 0],
    });
    store.close();

    // Mock embedding-provider.js : la "requête" embeddée renvoie toujours
    // le même vecteur, proche de Jean 3:16 dans l'index ci-dessus. On ne
    // teste pas Gemini ici (voir test-embedding-provider.js) — seulement
    // que bible-semantic-search.js consomme correctement un vecteur reçu.
    injectFakeModule(require.resolve('../embedding-provider'), {
      embedQuery: async () => [1, 0, 0],
      embedTexts: async () => null,
      CONFIG: { MODEL: 'fake', OUTPUT_DIMENSIONALITY: 3, BATCH_SIZE: 100 },
    });

    delete require.cache[require.resolve('../bible-semantic-search')];
    const { BibleSemanticSearch } = require('../bible-semantic-search');
    const search = new BibleSemanticSearch();
    // Force le store à pointer vers notre fichier de test plutôt que
    // models/bible-vector-index.sqlite3 (absent dans ce dépôt — voir
    // scripts/generate-bible-embeddings.js).
    search.store = new BibleVectorStore({ dbPath, vectorDim: 3 });
    await search.loadIndex();
    check('loadIndex avec index réel: loaded = true', search.loaded === true);

    // "galaxie lointaine" ne matche aucun TOPIC_INDEX -> tombe sur le
    // vectoriel, où le mock renvoie toujours [1,0,0] (proche de Jean 3:16).
    const r = await search.search('galaxie lointaine improbable xyz', 2);
    check('search vectoriel: résultats non vides', r.length > 0);
    check('search vectoriel: source = vector', r[0].source === 'vector');
    check('search vectoriel: Jean 3:16 en premier (distance 0)', r[0].reference === 'Jean 3:16');
    check('search vectoriel: score décroissant avec la distance', r[0].score >= (r[1] ? r[1].score : 0));

    // Un sujet connu (TOPIC_INDEX) doit toujours passer par le mot-clé
    // d'abord, même avec un index vectoriel chargé (ordre de priorité
    // inchangé par ce chantier).
    const r2 = await search.search('amour');
    check('search: mot-clé reste prioritaire sur le vectoriel', r2[0].source === 'keyword');

    delete require.cache[require.resolve('../embedding-provider')];
    search.store.close();
    fs.unlinkSync(dbPath);
  }

  console.log(`\n=== Résultat bible-semantic-search : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
}

run();
