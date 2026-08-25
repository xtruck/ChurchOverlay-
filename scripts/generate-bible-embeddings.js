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
// CORRECTIF (2026-08-25) : constaté en générant l'index réel — le palier
// gratuit Gemini renvoie 429 (RESOURCE_EXHAUSTED) bien avant la fin d'un
// index de ~312 lots à la suite. embedTexts() gère déjà les 429 isolés avec
// sa propre nouvelle tentative (voir embedding-provider.js), mais un rythme
// poli ENTRE lots (même principe que REQUEST_DELAY_MS dans
// bible-offline-cache.js) réduit combien de fois ce cas se produit du tout.
const EMBED_BATCH_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // CORRECTIF (2026-08-25) : createForWriting() écrit directement sur
  // dbPath dès le premier verset — le commentaire d'erreur ci-dessous disait
  // déjà "index partiel non écrit sur disque final" mais le code n'honorait
  // pas cette intention : un échec à mi-parcours (ex. 429 persistant)
  // laissait un index INCOMPLET au VRAI chemin de production
  // (models/bible-vector-index.sqlite3), silencieusement pris pour un index
  // complet par bible-semantic-search.js au prochain démarrage. Écrit
  // maintenant dans un fichier temporaire, renommé vers DEFAULT_DB_PATH
  // seulement après un succès complet — un ancien index valide (s'il en
  // existe un) reste donc intact tant qu'un nouveau n'a pas fini.
  const buildingPath = `${DEFAULT_DB_PATH}.building`;
  const store = new BibleVectorStore({ dbPath: buildingPath, vectorDim: 768 });
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
        `[generate-bible-embeddings] Échec embedTexts — arrêt (index partiel supprimé, ${buildingPath} jamais promu vers ${DEFAULT_DB_PATH}).`
      );
      store.close();
      try {
        fs.unlinkSync(buildingPath);
      } catch (_) {}
      process.exit(1);
    }
    for (let i = 0; i < batch.length; i++) {
      store.insertVerse({ ...batch[i], embedding: vectors[i] });
    }
    done += batch.length;
    console.log(`[generate-bible-embeddings] ${done}/${verses.length} versets embeddés.`);
    if (done < verses.length) await sleep(EMBED_BATCH_DELAY_MS);
  }

  store.close();
  fs.renameSync(buildingPath, DEFAULT_DB_PATH);
  console.log(`[generate-bible-embeddings] Terminé : ${DEFAULT_DB_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[generate-bible-embeddings] Erreur fatale:', err);
    process.exit(1);
  });
}

module.exports = { flattenVerses };
