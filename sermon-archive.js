/**
 * ============================================================================
 * sermon-archive.js — Mémoire locale et gratuite des cultes passés
 * ----------------------------------------------------------------------------
 * Même discipline que bible-semantic-search.js : aucun modèle d'embedding,
 * aucun appel API en direct — un petit fichier JSON local et une recherche
 * par recouvrement de mots-clés (le même mécanisme que TOPIC_INDEX/
 * searchByKeyword dans bible-semantic-search.js, appliqué aux cultes de
 * l'église plutôt qu'au texte biblique). Une entrée est ajoutée chaque fois
 * que l'opérateur clôture un culte via "Récap fin de culte" (voir
 * l'action 'getPostServiceRecap' dans server.js) — le seul signal explicite
 * de fin de service déjà présent dans l'app.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 200; // ~4 ans de cultes hebdomadaires — largement suffisant, fichier toujours petit

let archivePath = null;

/**
 * @param {string} userDataDir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(userDataDir) {
  archivePath = path.join(userDataDir, 'sermon-archive.json');
}

function readArchive() {
  if (!archivePath || !fs.existsSync(archivePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[sermon-archive] Lecture impossible, archive ignorée:', e.message);
    return [];
  }
}

function writeArchive(entries) {
  if (!archivePath) return;
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * Enregistre un culte terminé.
 * @param {Object} data
 * @param {string} [data.theme] - Titre court (ex. recap.title, déjà généré)
 * @param {string[]} [data.keyPoints] - Points clés déjà générés (recap.keyPoints)
 * @param {string} [data.transcriptExcerpt] - Extrait de transcription (borné)
 * @param {Array<string|{reference:string}>} [data.versesShown] - Versets affichés
 * @returns {Object} l'entrée enregistrée
 */
function saveServiceEntry(data) {
  if (!archivePath) return null;
  const versesShown = Array.isArray(data.versesShown)
    ? data.versesShown
        .map((v) => (typeof v === 'string' ? v : v.reference || v.raw || ''))
        .filter(Boolean)
    : [];

  const entry = {
    date: new Date().toISOString(),
    theme: data.theme || null,
    keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints.slice(0, 10) : [],
    transcriptExcerpt: (data.transcriptExcerpt || '').slice(0, 4000),
    versesShown,
  };

  const entries = readArchive();
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  writeArchive(entries);
  return entry;
}

function normalize(text) {
  // \p{M} (propriété Unicode "Mark") retire tous les diacritiques après
  // décomposition NFD — plus robuste que la plage ̀-ͯ utilisée
  // ailleurs dans le dépôt (ex. detector.js), sans dépendre d'échapper des
  // points de code combinants à la main dans le code source.
  return (text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
}

/**
 * Recherche locale par recouvrement de mots — pas d'embedding, pas d'API.
 * @param {string} query
 * @param {number} [topK=5]
 * @returns {Array<{date:string, theme:string|null, keyPoints:string[], versesShown:string[], score:number}>}
 */
function search(query, topK = 5) {
  const qWords = normalize(query)
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (qWords.length === 0) return [];

  const entries = readArchive();
  const scored = entries.map((entry) => {
    const haystack = normalize(
      [
        entry.theme,
        ...(entry.keyPoints || []),
        ...(entry.versesShown || []),
        entry.transcriptExcerpt,
      ]
        .filter(Boolean)
        .join(' ')
    );
    const hits = qWords.filter((w) => haystack.includes(w)).length;
    return { entry, score: hits / qWords.length };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.entry.date) - new Date(a.entry.date))
    .slice(0, topK)
    .map((s) => ({
      date: s.entry.date,
      theme: s.entry.theme,
      keyPoints: s.entry.keyPoints,
      versesShown: s.entry.versesShown,
      score: Math.round(s.score * 100) / 100,
    }));
}

/**
 * Liste les cultes archivés les plus récents (pour une future UI de parcours).
 * @param {number} [limit=20]
 */
function listEntries(limit = 20) {
  return readArchive()
    .slice(0, limit)
    .map((e) => ({ date: e.date, theme: e.theme, versesShown: e.versesShown }));
}

module.exports = { setUserDataDir, saveServiceEntry, search, listEntries };
