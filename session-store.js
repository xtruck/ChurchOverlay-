'use strict';
/**
 * session-store.js — Persistance SQLite de l'historique de session
 *
 * Chantier de fiabilité (2026-08-05) : jusqu'ici, sessionState.getVerseHistory()
 * ne vivait qu'en mémoire (tableau JS). Si le process crashait pendant un
 * culte — même avec l'auto-restart déjà en place côté main.js — l'historique
 * des versets affichés jusque-là était perdu, et il n'existait aucune trace
 * consultable après coup des erreurs de pipeline (transcriptionError /
 * audioError) survenues pendant le service.
 *
 * Ce module ajoute une persistance légère (fichier SQLite unique, aucun
 * serveur de DB requis — cohérent avec l'app desktop mono-poste) : chaque
 * verset affiché et chaque erreur de pipeline sont écrits ici en plus de
 * l'état en mémoire, sans le remplacer. sessionState.js reste la source de
 * vérité pour la session EN COURS (lecture rapide, pas de disque impliqué
 * dans le chemin chaud) ; session-store.js est la trace durable consultable
 * après le culte.
 *
 * Best-effort : une erreur d'écriture ici ne doit JAMAIS interrompre le
 * pipeline live (l'affichage du verset reste la priorité), donc toutes les
 * méthodes avalent leurs erreurs et se contentent de logger.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;
let insertVerseStmt = null;
let insertErrorStmt = null;

/**
 * Initialise la base SQLite dans <userDataDir>/data/session-history.db.
 * Idempotent — un second appel avec le même dossier réutilise la connexion.
 * @param {string} userDataDir - USER_DATA_DIR de server.js
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.onError] - callback pour logger un échec (ex. warn())
 */
function init(userDataDir, opts = {}) {
  const onError = opts.onError || (() => {});
  if (db) return; // déjà initialisé

  try {
    const dataDir = path.join(userDataDir, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, 'session-history.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS verse_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference TEXT NOT NULL,
        text TEXT,
        detected_by TEXT,
        reading_mode INTEGER DEFAULT 0,
        triggered_by_voice INTEGER DEFAULT 0,
        shown_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verse_history_shown_at ON verse_history(shown_at);

      CREATE TABLE IF NOT EXISTS pipeline_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        message TEXT,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_errors_occurred_at ON pipeline_errors(occurred_at);
    `);

    insertVerseStmt = db.prepare(`
      INSERT INTO verse_history (reference, text, detected_by, reading_mode, triggered_by_voice, shown_at)
      VALUES (@reference, @text, @detectedBy, @readingMode, @triggeredByVoice, @shownAt)
    `);
    insertErrorStmt = db.prepare(`
      INSERT INTO pipeline_errors (type, message, occurred_at)
      VALUES (@type, @message, @occurredAt)
    `);
  } catch (err) {
    db = null;
    onError(
      'session-store: initialisation impossible (' +
        err.message +
        ') — persistance désactivée, la session continue en mémoire seule.'
    );
  }
}

/**
 * Enregistre un verset affiché. Best-effort — n'interrompt jamais l'appelant.
 */
function recordVerseShown(entry) {
  if (!insertVerseStmt) return;
  try {
    insertVerseStmt.run({
      reference: entry.reference || '',
      text: (entry.text || '').slice(0, 500),
      detectedBy: entry.detectedBy || null,
      readingMode: entry.readingMode ? 1 : 0,
      triggeredByVoice: entry.triggeredByVoice ? 1 : 0,
      shownAt: entry.timestamp || Date.now(),
    });
  } catch (_err) {
    // Best-effort : une panne d'écriture disque ne doit pas casser l'affichage live.
  }
}

/**
 * Enregistre une erreur de pipeline (transcription/audio). Best-effort.
 */
function recordPipelineError(type, message) {
  if (!insertErrorStmt) return;
  try {
    insertErrorStmt.run({
      type: String(type || 'unknown'),
      message: String(message || '').slice(0, 1000),
      occurredAt: Date.now(),
    });
  } catch (_err) {
    // Best-effort.
  }
}

/**
 * @param {number} [sinceMs] - timestamp epoch ; si fourni, ne retourne que
 *   les versets affichés après cette date.
 * @returns {Array<object>} versets les plus récents en premier.
 */
function getVerseHistorySince(sinceMs = 0) {
  if (!db) return [];
  try {
    return db
      .prepare('SELECT * FROM verse_history WHERE shown_at >= ? ORDER BY shown_at DESC')
      .all(sinceMs);
  } catch (_err) {
    return [];
  }
}

/**
 * @returns {Array<object>} erreurs de pipeline les plus récentes en premier.
 */
function getPipelineErrorsSince(sinceMs = 0) {
  if (!db) return [];
  try {
    return db
      .prepare('SELECT * FROM pipeline_errors WHERE occurred_at >= ? ORDER BY occurred_at DESC')
      .all(sinceMs);
  } catch (_err) {
    return [];
  }
}

/**
 * Ferme proprement la connexion SQLite (utilisé au shutdown du serveur).
 */
function close() {
  if (db) {
    try {
      db.close();
    } catch (_err) {
      // Rien à faire — le process s'arrête de toute façon.
    }
    db = null;
    insertVerseStmt = null;
    insertErrorStmt = null;
  }
}

/**
 * @returns {boolean} true si la persistance est active (utile pour les tests
 *   et pour un futur indicateur dans le dashboard).
 */
function isEnabled() {
  return db !== null;
}

module.exports = {
  init,
  recordVerseShown,
  recordPipelineError,
  getVerseHistorySince,
  getPipelineErrorsSince,
  close,
  isEnabled,
};
