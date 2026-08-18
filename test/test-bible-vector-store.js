'use strict';
/**
 * Tests unitaires pour bible-vector-store.js — BibleVectorStore (sqlite-vec).
 * Vecteurs synthétiques (dimension 3, faciles à raisonner à la main) — pas
 * de réseau, pas de clé API, pas de dépendance à un vrai index généré.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BibleVectorStore } = require('../bible-vector-store');

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

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `test-bible-vec-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`
  );
}

// --- isAvailable() sur fichier absent ---
{
  const store = new BibleVectorStore({ dbPath: tmpDbPath() });
  check('isAvailable: false sur fichier absent', store.isAvailable() === false);
  check('openReadOnly: false sur fichier absent', store.openReadOnly() === false);
}

// --- createForWriting + insertVerse + knnSearch ---
{
  const dbPath = tmpDbPath();
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
    reference: 'Psaume 23:1',
    book: 'psaumes',
    chapter: 23,
    verse: 1,
    text: "L'Éternel est mon berger...",
    embedding: [0, 1, 0],
  });
  store.insertVerse({
    reference: 'Romains 8:28',
    book: 'romains',
    chapter: 8,
    verse: 28,
    text: 'Toutes choses concourent au bien...',
    embedding: [0.9, 0.1, 0],
  });

  check('count: 3 versets insérés', store.count() === 3);

  const nearest = store.knnSearch([1, 0, 0], 2);
  check('knnSearch: 2 résultats demandés = 2 reçus', nearest.length === 2);
  check(
    'knnSearch: le plus proche est Jean 3:16 (distance 0)',
    nearest[0].reference === 'Jean 3:16' && nearest[0].distance === 0
  );
  check(
    'knnSearch: 2e résultat est Romains 8:28 (vecteur le plus proche après Jean 3:16)',
    nearest[1].reference === 'Romains 8:28'
  );
  check(
    'knnSearch: résultats triés par distance croissante',
    nearest[0].distance <= nearest[1].distance
  );
  check(
    'knnSearch: champs meta présents (book/chapter/verse/text)',
    nearest[0].book === 'jean' &&
      nearest[0].chapter === 3 &&
      nearest[0].verse === 16 &&
      typeof nearest[0].text === 'string'
  );

  store.close();

  // Réouverture en lecture seule — les données doivent survivre à la fermeture.
  const reader = new BibleVectorStore({ dbPath, vectorDim: 3 });
  check('isAvailable: true après createForWriting', reader.isAvailable() === true);
  check('openReadOnly: true sur fichier existant', reader.openReadOnly() === true);
  const reopened = reader.knnSearch([0, 1, 0], 1);
  check(
    'knnSearch (réouvert): retrouve Psaume 23:1',
    reopened.length === 1 && reopened[0].reference === 'Psaume 23:1'
  );
  reader.close();

  fs.unlinkSync(dbPath);
}

// --- knnSearch sur store non ouvert ---
{
  const store = new BibleVectorStore({ dbPath: tmpDbPath() });
  check(
    "knnSearch: [] si le store n'a jamais été ouvert",
    Array.isArray(store.knnSearch([1, 0, 0], 5)) && store.knnSearch([1, 0, 0], 5).length === 0
  );
  check("count: 0 si le store n'a jamais été ouvert", store.count() === 0);
}

console.log(`\n=== Résultat bible-vector-store : ${passed}/${passed + failed} ===`);
if (failed > 0) process.exit(1);
