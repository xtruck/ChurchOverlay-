'use strict';
/**
 * ============================================================================
 * bible-vector-store.js — Index vectoriel biblique (sqlite-vec)
 * ----------------------------------------------------------------------------
 * AJOUT (chantier 4.2 — recherche sémantique biblique). Wrapper fin autour
 * de sqlite-vec (extension SQLite native, via better-sqlite3) : stocke un
 * vecteur par verset dans une table virtuelle vec0, cherche par plus proches
 * voisins (KNN). Fichier LIVRÉ avec l'app, LECTURE SEULE (généré une fois par
 * scripts/generate-bible-embeddings.js, jamais réécrit à l'exécution) — même
 * discipline que models/silero_vad.onnx (voir asarUnpack dans package.json,
 * "models/**\/*" couvre déjà ce fichier sans changement de config).
 *
 * Deux tables :
 *   - vec_verses (vec0)  : embedding seul, rowid auto-assigné par SQLite.
 *     CORRECTIF (mesuré en écrivant ce fichier) : vec0 refuse un rowid fourni
 *     explicitement ("Only integers are allowed for primary key values") —
 *     comportement de cette version (0.1.9), pas un choix. On laisse donc
 *     SQLite assigner le rowid à l'insertion vectorielle, puis on l'utilise
 *     comme clé explicite dans verses_meta (table normale, sans cette
 *     restriction).
 *   - verses_meta (normale) : rowid (= même id que vec_verses), reference,
 *     book, chapter, verse, text.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const DEFAULT_DB_PATH = path.join(__dirname, 'models', 'bible-vector-index.sqlite3');

function toVecBuffer(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

class BibleVectorStore {
  /** @param {{ dbPath?: string, vectorDim?: number }} [options] */
  constructor(options = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.vectorDim = options.vectorDim || 768;
    this.db = null;
  }

  isAvailable() {
    return fs.existsSync(this.dbPath);
  }

  /**
   * Ouvre le fichier existant en lecture seule. Ne crée jamais le fichier —
   * c'est le rôle de createForWriting() (utilisé par le script de build
   * uniquement). Renvoie false sans lever si le fichier est absent ou
   * illisible (mode dégradé — voir bible-semantic-search.js).
   * @returns {boolean}
   */
  openReadOnly() {
    if (this.db) return true;
    if (!this.isAvailable()) return false;
    try {
      this.db = new Database(this.dbPath, {
        readonly: true,
        fileMustExist: true,
        allowExtension: true,
      });
      sqliteVec.load(this.db);
      return true;
    } catch (err) {
      console.warn('[bible-vector-store] Échec ouverture index vectoriel:', err.message);
      this.db = null;
      return false;
    }
  }

  /**
   * Crée (ou écrase) le fichier pour écriture — utilisé uniquement par
   * scripts/generate-bible-embeddings.js, jamais à l'exécution normale.
   */
  createForWriting() {
    if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { allowExtension: true });
    sqliteVec.load(this.db);
    this.db.exec(`CREATE VIRTUAL TABLE vec_verses USING vec0(embedding float[${this.vectorDim}])`);
    this.db.exec(
      `CREATE TABLE verses_meta (
         rowid INTEGER PRIMARY KEY,
         reference TEXT NOT NULL,
         book TEXT NOT NULL,
         chapter INTEGER NOT NULL,
         verse INTEGER NOT NULL,
         text TEXT NOT NULL
       )`
    );
  }

  /**
   * @param {{ reference: string, book: string, chapter: number, verse: number, text: string, embedding: number[] }} row
   */
  insertVerse(row) {
    const insertVec = this.db.prepare('INSERT INTO vec_verses(embedding) VALUES (?)');
    const info = insertVec.run(toVecBuffer(row.embedding));
    const id = info.lastInsertRowid;
    this.db
      .prepare(
        'INSERT INTO verses_meta(rowid, reference, book, chapter, verse, text) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, row.reference, row.book, row.chapter, row.verse, row.text);
    return id;
  }

  /**
   * Recherche par plus proches voisins.
   * @param {number[]} queryVector
   * @param {number} [topK]
   * @returns {Array<{reference: string, book: string, chapter: number, verse: number, text: string, distance: number}>}
   */
  knnSearch(queryVector, topK = 5) {
    if (!this.db) return [];
    // CORRECTIF (mesuré en écrivant ce fichier) : sqlite-vec (0.1.9) exige
    // "LIMIT <litéral>" OU "k = ?" pour planifier une requête KNN sur vec0 —
    // "LIMIT ?" (paramètre lié) échoue avec "A LIMIT or 'k = ?' constraint is
    // required", le nombre de voisins devant être connu avant la liaison des
    // paramètres. On utilise donc "k = ?" plutôt qu'un LIMIT littéral, pour
    // garder topK comme un paramètre lié classique (pas d'interpolation SQL).
    const rows = this.db
      .prepare(
        `SELECT v.rowid as id, v.distance as distance,
                m.reference, m.book, m.chapter, m.verse, m.text
         FROM vec_verses v
         JOIN verses_meta m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`
      )
      .all(toVecBuffer(queryVector), topK);
    return rows.map((r) => ({
      reference: r.reference,
      book: r.book,
      chapter: r.chapter,
      verse: r.verse,
      text: r.text,
      distance: r.distance,
    }));
  }

  count() {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as n FROM verses_meta').get();
    return row ? row.n : 0;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { BibleVectorStore, DEFAULT_DB_PATH };
