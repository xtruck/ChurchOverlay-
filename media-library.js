/**
 * ============================================================================
 * media-library.js — Médiathèque locale (photos/vidéos déclenchées à la voix)
 * ----------------------------------------------------------------------------
 * Même discipline que sermon-archive.js : petit index JSON local dans
 * userData, aucun appel API, aucune dépendance externe. Les fichiers média
 * eux-mêmes (copiés depuis le disque via le sélecteur natif, voir main.js
 * 'pick-media-file') vivent dans <userData>/media/, référencés par nom de
 * fichier dans l'index — jamais dans app.asar (lecture seule) ni dans le
 * dépôt git.
 *
 * matchTriggerPhrase() généralise le mécanisme déjà utilisé par
 * detectCommand() (voice-commands.js) : une correspondance de sous-chaîne sur
 * un texte normalisé (pas de LLM, pas de coût, résultat prévisible en plein
 * culte) — ici appliquée à des phrases déclencheuses définies par
 * l'opérateur plutôt qu'à un vocabulaire de commandes fixe.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 100; // médiathèque d'un culte, pas un CMS — largement suffisant
const DEFAULT_IMAGE_DURATION_MS = 15000; // "moment poster" court, pas un verset (120s par défaut)
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.mp4',
  '.webm',
  '.mov',
]);

let indexPath = null;
let mediaDir = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  indexPath = path.join(dir, 'media-library.json');
  mediaDir = path.join(dir, 'media');
}

function readIndex() {
  if (!indexPath || !fs.existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[media-library] Lecture impossible, index ignoré:', e.message);
    return [];
  }
}

function writeIndex(items) {
  if (!indexPath) return;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), 'utf8');
}

// Même approche que sermon-archive.js (\p{M} après décomposition NFD) plutôt
// que la plage ̀-ͯ utilisée dans detector.js/voice-commands.js :
// équivalente en résultat, mais ne dépend pas d'échapper des points de code
// combinants à la main dans le code source.
function normalize(text) {
  return (text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
}

/**
 * Liste tous les éléments de la médiathèque (métadonnées seulement, pas les
 * octets du fichier).
 * @returns {Array<Object>}
 */
function listItems() {
  return readIndex();
}

/**
 * @param {string} id
 * @returns {Object|null}
 */
function getItem(id) {
  return readIndex().find((item) => item.id === id) || null;
}

/**
 * Copie un fichier choisi par l'opérateur (chemin absolu sur disque, depuis
 * le sélecteur natif 'pick-media-file') dans <userData>/media/ et l'ajoute à
 * l'index.
 * @param {Object} data
 * @param {string} data.sourcePath - chemin absolu du fichier source
 * @param {string} data.label - nom affiché dans le tableau de bord
 * @param {string[]} data.triggerPhrases - phrases déclencheuses (texte brut, normalisées ici)
 * @param {number} [data.displayDurationMs] - durée d'affichage auto (ms) ; null/absent = jusqu'à fin de vidéo ou masquage manuel
 * @returns {Object} l'élément ajouté
 */
function addItem(data) {
  if (!indexPath || !mediaDir) throw new Error('media-library: setUserDataDir() non appelé');
  if (!data || !data.sourcePath) throw new Error('sourcePath manquant');
  if (!fs.existsSync(data.sourcePath)) throw new Error('Fichier source introuvable');

  const ext = path.extname(data.sourcePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Type de fichier non supporté : ${ext || '(aucune extension)'}`);
  }
  const mediaType = ['.mp4', '.webm', '.mov'].includes(ext) ? 'video' : 'image';

  const id = crypto.randomUUID();
  const filename = `${id}${ext}`;

  fs.mkdirSync(mediaDir, { recursive: true });
  fs.copyFileSync(data.sourcePath, path.join(mediaDir, filename));

  const triggerPhrases = (Array.isArray(data.triggerPhrases) ? data.triggerPhrases : [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);

  const item = {
    id,
    label: (data.label || path.basename(data.sourcePath, ext)).slice(0, 200),
    triggerPhrases: triggerPhrases.slice(0, 20).map((p) => p.slice(0, 200)),
    mediaType,
    filename,
    addedAt: new Date().toISOString(),
    displayDurationMs:
      typeof data.displayDurationMs === 'number' && data.displayDurationMs > 0
        ? data.displayDurationMs
        : mediaType === 'image'
          ? DEFAULT_IMAGE_DURATION_MS
          : null,
    // AJOUT (diaporama d'annonces — recommandation "présentation secondaire
    // indépendante") : inclus dans announcement-loop.html si vrai, sinon cet
    // élément reste uniquement déclenchable à la voix/manuellement comme
    // avant. Indépendant de displayDurationMs (voir DEFAULT_LOOP_DURATION_MS
    // dans announcement-loop.html pour la durée utilisée en boucle).
    includeInLoop: !!data.includeInLoop,
  };

  const items = readIndex();
  items.unshift(item);
  if (items.length > MAX_ITEMS) {
    // Supprime aussi les fichiers correspondant aux entrées évincées, pour
    // ne pas laisser le dossier media/ grossir indéfiniment sans limite.
    for (const evicted of items.slice(MAX_ITEMS)) {
      deleteMediaFile(evicted.filename);
    }
    items.length = MAX_ITEMS;
  }
  writeIndex(items);
  return item;
}

function deleteMediaFile(filename) {
  if (!mediaDir || !filename) return;
  try {
    fs.unlinkSync(path.join(mediaDir, filename));
  } catch (_e) {
    // Fichier déjà absent : sans conséquence, l'index reste la source de vérité.
  }
}

/**
 * Supprime un élément (fichier + entrée d'index).
 * @param {string} id
 * @returns {boolean} true si un élément a bien été supprimé
 */
function deleteItem(id) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  deleteMediaFile(items[idx].filename);
  items.splice(idx, 1);
  writeIndex(items);
  return true;
}

/**
 * Cherche si un texte transcrit contient l'une des phrases déclencheuses
 * d'un élément de la médiathèque. Correspondance par sous-chaîne sur texte
 * normalisé (pas de LLM) — même philosophie que detectCommand()
 * (voice-commands.js) : rapide, gratuit, prévisible en plein culte.
 * @param {string} text - texte transcrit (brut, pas encore normalisé)
 * @returns {Object|null} l'élément déclenché, ou null
 */
function matchTriggerPhrase(text) {
  const normalizedText = normalize(text);
  if (!normalizedText) return null;

  for (const item of readIndex()) {
    for (const phrase of item.triggerPhrases || []) {
      const normalizedPhrase = normalize(phrase);
      if (normalizedPhrase && normalizedText.includes(normalizedPhrase)) {
        return item;
      }
    }
  }
  return null;
}

module.exports = {
  setUserDataDir,
  listItems,
  getItem,
  addItem,
  deleteItem,
  matchTriggerPhrase,
  // Exposées pour tests unitaires (test-media-library.js).
  ALLOWED_EXTENSIONS,
  DEFAULT_IMAGE_DURATION_MS,
};
