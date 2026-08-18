'use strict';
/**
 * ============================================================================
 * scripts/generate-bible-embeddings.js — Génère models/bible-vector-index.sqlite3
 * ----------------------------------------------------------------------------
 * AJOUT (chantier 4.2 — recherche sémantique biblique). Étape de BUILD, pas
 * d'exécution normale de l'app :
 *   1. Télécharge la Bible complète (fra_lsg) via bible-offline-cache.js
 *      (même source/rythme que le cache hors-ligne déjà utilisé en
 *      production — bible.helloao.org, aucune clé requise pour cette étape).
 *   2. Embed chaque verset (Gemini text-embedding-004, voir
 *      embedding-provider.js — REQUIERT GEMINI_API_KEY).
 *   3. Écrit le tout dans models/bible-vector-index.sqlite3 via
 *      bible-vector-store.js (sqlite-vec) — fichier binaire volumineux,
 *      délibérément PAS committé (voir .gitignore), livré via le pipeline de
 *      build/release comme models/silero_vad.onnx.
 *
 * Usage : GEMINI_API_KEY=... node scripts/generate-bible-embeddings.js
 * (~66 livres à télécharger si le cache local n'existe pas encore : prévoir
 * plusieurs minutes rien que pour cette étape, à cause du rythme poli
 * REQUEST_DELAY_MS envers l'API gratuite helloao. L'embedding d'environ
 * 31 000 versets suit, par lots — coût et durée dépendent du quota Gemini.)
 * ============================================================================
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const bibleOfflineCache = require('../bible-offline-cache');
const { embedTexts } = require('../embedding-provider');
const { BibleVectorStore, DEFAULT_DB_PATH } = require('../bible-vector-store');

const TRANSLATION = bibleOfflineCache.DEFAULT_TRANSLATION;
const EMBED_BATCH_SIZE = 100;

async function ensureBibleTextDownloaded() {
  // Répertoire de travail dédié à ce script — distinct du userData d'une
  // vraie installation Electron (ce script tourne en Node pur, hors
  // Electron). Réutilisable d'une exécution à l'autre (idempotent, voir
  // isAvailable() dans bible-offline-cache.js).
  const workDir = path.join(os.tmpdir(), 'churchoverlay-bible-build');
  bibleOfflineCache.setUserDataDir(workDir);
  if (!bibleOfflineCache.isAvailable(TRANSLATION)) {
    console.log('[generate-bible-embeddings] Téléchargement de la Bible complète...');
    await bibleOfflineCache.downloadFullBible(TRANSLATION);
  } else {
    console.log('[generate-bible-embeddings] Bible déjà en cache local, téléchargement sauté.');
  }
  // downloadFullBible() écrit directement le fichier JSON — pas d'accesseur
  // exporté vers les données en mémoire (loadedData est privé à ce module),
  // donc on relit le fichier nous-mêmes plutôt que d'ajouter un export
  // seulement utilisé par ce script de build. Chemin reconstruit à
  // l'identique de filePathFor()/setUserDataDir() dans bible-offline-cache.js.
  const filePath = path.join(workDir, 'bible-offline', `${TRANSLATION}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {object} books - { [bookKey]: { [chapter]: { [verse]: text } } }
 * @returns {Array<{reference: string, book: string, chapter: number, verse: number, text: string}>}
 */
function flattenVerses(books) {
  const out = [];
  for (const [book, chapters] of Object.entries(books)) {
    for (const [chapterStr, verses] of Object.entries(chapters)) {
      const chapter = Number(chapterStr);
      for (const [verseStr, text] of Object.entries(verses)) {
        const verse = Number(verseStr);
        if (!text) continue;
        out.push({
          reference: `${book} ${chapter}:${verse}`,
          book,
          chapter,
          verse,
          text,
        });
      }
    }
  }
  return out;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      '[generate-bible-embeddings] GEMINI_API_KEY non défini — impossible de générer des embeddings. ' +
        'Voir embedding-provider.js.'
    );
    process.exit(1);
  }

  const books = await ensureBibleTextDownloaded();
  const verses = flattenVerses(books);
  console.log(`[generate-bible-embeddings] ${verses.length} versets à embedder.`);

  const store = new BibleVectorStore({ dbPath: DEFAULT_DB_PATH, vectorDim: 768 });
  store.createForWriting();

  const batches = chunk(verses, EMBED_BATCH_SIZE);
  let done = 0;
  for (const batch of batches) {
    const vectors = await embedTexts(
      batch.map((v) => v.text),
      { taskType: 'RETRIEVAL_DOCUMENT' }
    );
    if (!vectors) {
      console.error(
        '[generate-bible-embeddings] Échec embedTexts — arrêt (index partiel non écrit sur disque final).'
      );
      store.close();
      process.exit(1);
    }
    for (let i = 0; i < batch.length; i++) {
      store.insertVerse({ ...batch[i], embedding: vectors[i] });
    }
    done += batch.length;
    console.log(`[generate-bible-embeddings] ${done}/${verses.length} versets embeddés.`);
  }

  store.close();
  console.log(`[generate-bible-embeddings] Terminé : ${DEFAULT_DB_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[generate-bible-embeddings] Erreur fatale:', err);
    process.exit(1);
  });
}

module.exports = { flattenVerses };
