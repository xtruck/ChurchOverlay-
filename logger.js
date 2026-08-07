'use strict';

// -----------------------------------------------------------------------------
// logger.js — Journalisation persistante sur disque.
//
// CORRECTIF (checklist mise en production, point 6) : jusqu'ici, tous les
// logs ne passaient que par console.log/console.warn. Si un problème
// survenait un dimanche et que personne ne regardait l'écran au bon moment,
// il n'y avait aucune trace après coup pour comprendre ce qui s'était passé.
//
// Ce module écrit chaque ligne dans un fichier journalier (rotation par
// date, ex: 2026-07-30.log) dans le sous-dossier "logs/" du dossier
// utilisateur (USER_DATA_DIR, déjà inscriptible — jamais dans l'app.asar en
// lecture seule). Les fichiers de plus de 30 jours sont purgés
// automatiquement pour ne pas accumuler indéfiniment.
//
// Conçu pour ne JAMAIS faire planter le serveur : toute erreur d'écriture
// disque (dossier supprimé, disque plein, permissions...) est avalée et
// silencieusement ignorée après un seul avertissement console — la
// journalisation fichier est un confort de diagnostic, pas une dépendance
// critique du pipeline en direct.
// -----------------------------------------------------------------------------

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
// AJOUT (audit performance) : append() utilisait fs.appendFileSync — une
// écriture disque SYNCHRONE, bloquante, sur le thread du worker server.js,
// appelée à CHAQUE log() (donc plusieurs fois par segment de transcription,
// sur le chemin le plus chaud du pipeline). Sur un disque lent ou sous
// contention, ça ajoute de la latence directement à la détection de verset
// en direct. File d'attente bornée + vidage asynchrone séquentiel : append()
// ne bloque plus jamais l'appelant, l'ordre des lignes reste garanti (un
// seul writer actif à la fois), et un disque bloqué ne fait pas grossir la
// mémoire indéfiniment (plafond, plus vieilles lignes abandonnées au-delà).
const MAX_QUEUE_LINES = 2000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStamp(d) {
  return `${dateStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Crée un logger fichier écrivant dans `logsDir`, avec rotation quotidienne
 * et purge automatique des fichiers de plus de 30 jours.
 *
 * @param {string} logsDir Dossier où écrire les fichiers .log (créé si absent)
 * @returns {{ append: (line: string, isError?: boolean) => void }}
 */
function createFileLogger(logsDir) {
  let warnedOnce = false;
  let lastPurgeCheck = 0;
  const PURGE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // vérifie la purge au plus 1x/heure

  function safeWarnOnce(err) {
    if (warnedOnce) return;
    warnedOnce = true;
    console.warn(
      `[logger] Journalisation fichier désactivée (erreur non bloquante) : ${err && err.message}`
    );
  }

  function ensureDir() {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      return true;
    } catch (err) {
      safeWarnOnce(err);
      return false;
    }
  }

  function purgeOldLogs() {
    const now = Date.now();
    if (now - lastPurgeCheck < PURGE_CHECK_INTERVAL_MS) return;
    lastPurgeCheck = now;
    try {
      const entries = fs.readdirSync(logsDir);
      for (const entry of entries) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(entry)) continue; // ignore fichiers étrangers
        const filePath = path.join(logsDir, entry);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > MAX_LOG_AGE_MS) {
            fs.unlinkSync(filePath);
          }
        } catch (_) {
          // fichier déjà supprimé entre-temps ou inaccessible : on ignore
        }
      }
    } catch (_) {
      // dossier illisible : rien à purger, pas grave
    }
  }

  // Crée le dossier une première fois (best-effort, ne bloque pas si échec :
  // append() retentera à chaque appel).
  ensureDir();

  const queue = [];
  let draining = false;
  let droppedSinceWarning = 0;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const { filePath, text } = queue.shift();
        try {
          await fsp.appendFile(filePath, text);
        } catch (err) {
          safeWarnOnce(err);
          // Le fichier/dossier a disparu ou le disque est indisponible :
          // vider le reste de la file ne servirait qu'à empiler des échecs
          // identiques. On abandonne cette ligne et on continue avec la
          // suivante (peut-être qu'une purge/permission change entre-temps).
        }
      }
      purgeOldLogs();
    } finally {
      draining = false;
    }
  }

  function append(line, isError) {
    if (!ensureDir()) return;
    const now = new Date();
    const filePath = path.join(logsDir, `${dateStamp(now)}.log`);
    const prefix = isError ? 'ERROR' : 'INFO';
    const text = `[${timeStamp(now)}] [${prefix}] ${line}\n`;

    if (queue.length >= MAX_QUEUE_LINES) {
      // Disque manifestement à la traîne (ou indisponible) : on privilégie
      // les lignes les plus RÉCENTES (plus utiles pour diagnostiquer un
      // problème en cours) plutôt que de laisser la file grossir sans fin.
      queue.shift();
      droppedSinceWarning++;
      if (droppedSinceWarning === 1 || droppedSinceWarning % 500 === 0) {
        console.warn(`[logger] File d'attente saturée (${MAX_QUEUE_LINES}) — ${droppedSinceWarning} ligne(s) de log abandonnée(s) depuis.`);
      }
    }
    queue.push({ filePath, text });
    drain(); // fire-and-forget — append() ne bloque jamais l'appelant
  }

  return { append };
}

module.exports = { createFileLogger };
