/**
 * ============================================================================
 * song-library.js — Bibliothèque de chants (paroles couplets/refrains)
 * ----------------------------------------------------------------------------
 * Même discipline que media-library.js/sermon-archive.js : petit index JSON
 * local dans userData, aucun appel API, aucune dépendance externe. Contenu
 * purement textuel (pas de fichier à copier, contrairement à media-library.js).
 *
 * Réutilise volontairement l'affichage overlay des versets plutôt que d'en
 * créer un nouveau : voir server.js showSongSection(), qui diffuse une
 * section de chant comme un 'showVerse' synthétique (reference = "Titre —
 * Étiquette", text = paroles) — overlay.html n'a besoin d'aucune
 * modification pour afficher un chant.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findTriggerMatch } = require('./voice-trigger-matcher');

const MAX_SONGS = 300; // recueil d'une église, pas un catalogue commercial — largement suffisant
const MAX_SECTIONS_PER_SONG = 40;

let indexPath = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  indexPath = path.join(dir, 'song-library.json');
}

function readIndex() {
  if (!indexPath || !fs.existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[song-library] Lecture impossible, index ignoré:', e.message);
    return [];
  }
}

function writeIndex(songs) {
  if (!indexPath) return;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(songs, null, 2), 'utf8');
}

/**
 * Découpe un bloc de paroles collé par l'opérateur en sections, séparées par
 * une ou plusieurs lignes vides — convention universelle des feuilles de
 * chant (couplet/refrain séparés par un saut de ligne). Chaque section
 * reçoit une étiquette générique (Couplet 1, Couplet 2...) ; l'opérateur
 * peut la modifier après coup si besoin (non fait ici, hors scope v1).
 * @param {string} rawText
 * @returns {Array<{type: string, label: string, text: string}>}
 */
function parseSections(rawText) {
  const blocks = (rawText || '')
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.slice(0, MAX_SECTIONS_PER_SONG).map((text, i) => ({
    type: 'verse',
    label: `Couplet ${i + 1}`,
    text: text.slice(0, 4000),
  }));
}

/**
 * @returns {Array<Object>} métadonnées seulement (sans le texte complet, pour une liste légère)
 */
function listSongs() {
  return readIndex().map((song) => ({
    id: song.id,
    title: song.title,
    artist: song.artist,
    sectionCount: song.sections.length,
    triggerPhrases: song.triggerPhrases,
  }));
}

/**
 * @param {string} id
 * @returns {Object|null} chant complet (avec toutes les sections)
 */
function getSong(id) {
  return readIndex().find((song) => song.id === id) || null;
}

/**
 * @param {Object} data
 * @param {string} data.title
 * @param {string} [data.artist]
 * @param {string} data.lyrics - paroles brutes, sections séparées par une ligne vide
 * @param {string[]} [data.triggerPhrases]
 * @returns {Object} le chant ajouté
 */
function addSong(data) {
  if (!indexPath) throw new Error('song-library: setUserDataDir() non appelé');
  if (!data || !data.title || !data.title.trim()) throw new Error('Titre manquant');
  const sections = parseSections(data.lyrics);
  if (sections.length === 0) throw new Error('Aucune parole fournie');

  const triggerPhrases = (Array.isArray(data.triggerPhrases) ? data.triggerPhrases : [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .slice(0, 20)
    .map((p) => p.slice(0, 200));

  const song = {
    id: crypto.randomUUID(),
    title: data.title.trim().slice(0, 200),
    artist: (data.artist || '').trim().slice(0, 200),
    sections,
    triggerPhrases,
    addedAt: new Date().toISOString(),
  };

  const songs = readIndex();
  songs.unshift(song);
  if (songs.length > MAX_SONGS) songs.length = MAX_SONGS;
  writeIndex(songs);
  return song;
}

/**
 * @param {string} id
 * @returns {boolean} true si un chant a bien été supprimé
 */
function deleteSong(id) {
  const songs = readIndex();
  const idx = songs.findIndex((song) => song.id === id);
  if (idx === -1) return false;
  songs.splice(idx, 1);
  writeIndex(songs);
  return true;
}

/**
 * Cherche si un texte transcrit contient l'une des phrases déclencheuses
 * d'un chant — voir voice-trigger-matcher.js (mutualisé avec
 * media-library.js, même mécanisme).
 * @param {string} text
 * @returns {{song: Object, sectionIndex: number}|null}
 */
function matchTriggerPhrase(text) {
  const song = findTriggerMatch(readIndex(), text);
  return song ? { song, sectionIndex: 0 } : null;
}

module.exports = {
  setUserDataDir,
  listSongs,
  getSong,
  addSong,
  deleteSong,
  matchTriggerPhrase,
  // Exposée pour tests unitaires (test-song-library.js).
  parseSections,
};
