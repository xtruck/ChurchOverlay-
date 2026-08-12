/**
 * ============================================================================
 * scene-store.js — Scènes composées (texte + logo + image, "poster" enrichi)
 * ----------------------------------------------------------------------------
 * Même discipline que media-library.js/song-library.js : petit index JSON
 * local dans userData, aucun appel API, aucune dépendance externe.
 *
 * AJOUT (studio de scènes, lot 1/6) : une scène ne possède AUCUN fichier —
 * elle référence des éléments déjà présents dans media-library.js par leur
 * id (`background.mediaId`, `elements[].mediaId` pour un élément image/logo).
 * Un seul endroit possède réellement un fichier média sur le disque
 * (media-library.js), et sa propre logique de suppression/éviction reste la
 * source de vérité unique — une scène dont l'élément référencé a été
 * supprimé se dégrade simplement (pas d'image pour cet élément), jamais une
 * erreur ni un plantage.
 *
 * PORTÉE DE CE LOT : store pur, additif — aucun branchement server.js/
 * overlay.html/dashboard pour l'instant (voir les lots suivants). L'arbitrage
 * "un seul poster principal à la fois, scène OU média" (setDefaultScene()
 * démarque le média par défaut et vice versa) est le lot 2, pas celui-ci —
 * setDefaultScene() ici ne touche qu'à cet index, volontairement.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SCENES = 100; // médiathèque d'un culte, pas un CMS — même borne que media-library.js
const MAX_ELEMENTS_PER_SCENE = 20; // large marge pour un usage réel, évite un index qui explose
const MAX_NAME_LENGTH = 200; // même borne que le label d'un élément de médiathèque
const MAX_TEXT_LENGTH = 500; // un bloc de texte de scène, pas un sermon entier

// AJOUT (studio de scènes) : constrainte volontaire — "presets plutôt que
// libre" est déjà le style de la maison pour ce type de réglage (voir les 4
// positions/3 tailles fixes de branding-store.js pour le logo, déjà en
// production sans réclamation). Grille 3x3, résolue en pourcentages du cadre
// par POSITION_PRESETS_PCT — même table utilisée par le dashboard (aperçu)
// et overlay.html (rendu réel), pour que les deux ne puissent jamais diverger.
const POSITION_PRESETS = new Set([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);
const DEFAULT_POSITION = 'center';

// AJOUT (studio de scènes) : polices déjà chargées par overlay.html (voir son
// @import) — zéro nouvelle dépendance réseau. Étendre cette liste plus tard
// exige d'abord d'ajouter la police au @import d'overlay.html, sinon elle
// retomberait silencieusement sur la police système par défaut du navigateur.
const FONT_FAMILIES = new Set([
  'Merriweather',
  'Manrope',
  'Cormorant Garamond',
  'Plus Jakarta Sans',
]);
const DEFAULT_FONT_FAMILY = 'Merriweather'; // même défaut que le texte de verset (theme-loader.js)

const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right']);
const DEFAULT_TEXT_ALIGN = 'center';

const FONT_WEIGHTS = new Set([400, 700]);
const DEFAULT_FONT_WEIGHT = 400;

const DEFAULT_FONT_SIZE_PCT = 6; // % de la hauteur du cadre — cohérent avec le dimensionnement de theme-loader.js
const MIN_FONT_SIZE_PCT = 1;
const MAX_FONT_SIZE_PCT = 30;

const DEFAULT_IMAGE_WIDTH_PCT = 18; // taille "logo" raisonnable par défaut
const MIN_ELEMENT_WIDTH_PCT = 1;
const MAX_ELEMENT_WIDTH_PCT = 100;

const DEFAULT_TEXT_COLOR = '#FFFFFF';
const BACKGROUND_TYPES = new Set(['media', 'color', 'none']);
const DEFAULT_BACKGROUND_COLOR = '#0b0f1a';

let indexPath = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  indexPath = path.join(dir, 'scenes.json');
}

function readIndex() {
  if (!indexPath || !fs.existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[scene-store] Lecture impossible, index ignoré:', e.message);
    return [];
  }
}

function writeIndex(items) {
  if (!indexPath) return;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), 'utf8');
}

/**
 * Liste toutes les scènes (métadonnées complètes — une scène n'a pas de gros
 * binaire associé, contrairement à un élément de médiathèque).
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

function sanitizeBackground(input) {
  const type = BACKGROUND_TYPES.has(input && input.type) ? input.type : 'none';
  return {
    type,
    mediaId: type === 'media' && input && typeof input.mediaId === 'string' ? input.mediaId : null,
    color:
      type === 'color' && input && typeof input.color === 'string'
        ? input.color
        : type === 'color'
          ? DEFAULT_BACKGROUND_COLOR
          : null,
  };
}

function sanitizeElement(input) {
  if (!input || typeof input !== 'object') return null;
  const position = POSITION_PRESETS.has(input.position) ? input.position : DEFAULT_POSITION;
  const rotationDeg = typeof input.rotationDeg === 'number' ? input.rotationDeg : 0;
  // AJOUT (studio de scènes) : id assigné/regénéré ici, jamais fait confiance
  // au client — même discipline que media-library.js#addItem qui génère
  // toujours son propre id via crypto.randomUUID(), jamais reçu de l'appelant.
  const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : crypto.randomUUID();

  if (input.type === 'image') {
    if (typeof input.mediaId !== 'string' || !input.mediaId) return null;
    const widthPct = clampNumber(
      input.widthPct,
      DEFAULT_IMAGE_WIDTH_PCT,
      MIN_ELEMENT_WIDTH_PCT,
      MAX_ELEMENT_WIDTH_PCT
    );
    return { id, type: 'image', mediaId: input.mediaId, position, widthPct, rotationDeg };
  }

  // Par défaut (y compris type absent/inconnu) : élément texte — le type le
  // plus courant, une scène "vide" ajoutée par erreur reste au moins du texte
  // vide plutôt que d'être silencieusement rejetée.
  const text = typeof input.text === 'string' ? input.text.slice(0, MAX_TEXT_LENGTH) : '';
  const fontFamily = FONT_FAMILIES.has(input.fontFamily) ? input.fontFamily : DEFAULT_FONT_FAMILY;
  const align = TEXT_ALIGNMENTS.has(input.align) ? input.align : DEFAULT_TEXT_ALIGN;
  const fontWeight = FONT_WEIGHTS.has(input.fontWeight) ? input.fontWeight : DEFAULT_FONT_WEIGHT;
  const fontSizePct = clampNumber(
    input.fontSizePct,
    DEFAULT_FONT_SIZE_PCT,
    MIN_FONT_SIZE_PCT,
    MAX_FONT_SIZE_PCT
  );
  const color =
    typeof input.color === 'string' && input.color.trim() ? input.color.trim() : DEFAULT_TEXT_COLOR;

  return {
    id,
    type: 'text',
    text,
    position,
    align,
    fontFamily,
    fontSizePct,
    fontWeight,
    color,
    rotationDeg,
  };
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeElements(input) {
  if (!Array.isArray(input)) return [];
  return input.map(sanitizeElement).filter(Boolean).slice(0, MAX_ELEMENTS_PER_SCENE);
}

/**
 * Crée une nouvelle scène.
 * @param {Object} data
 * @param {string} data.name
 * @param {Object} [data.background] - {type:'media'|'color'|'none', mediaId, color}
 * @param {Array<Object>} [data.elements]
 * @returns {Object} la scène créée
 */
function addScene(data) {
  if (!indexPath) throw new Error('scene-store: setUserDataDir() non appelé');
  if (!data || typeof data.name !== 'string' || !data.name.trim()) {
    throw new Error('Nom de scène manquant');
  }

  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    name: data.name.trim().slice(0, MAX_NAME_LENGTH),
    addedAt: now,
    updatedAt: now,
    background: sanitizeBackground(data.background),
    elements: sanitizeElements(data.elements),
    // AJOUT (demande explicite — "poster principal") : voir setDefaultScene()
    // plus bas. Un seul élément à la fois peut être vrai — TOUJOURS FAUX ici
    // à la création ; passer par setDefaultScene() explicitement.
    isDefault: false,
  };

  const items = readIndex();
  items.unshift(item);
  if (items.length > MAX_SCENES) {
    items.length = MAX_SCENES;
  }
  writeIndex(items);
  return item;
}

/**
 * Modifie une scène déjà créée — nom, fond, éléments. Patch partiel : seuls
 * les champs présents dans `patch` sont modifiés (même discipline que
 * media-library.js#updateItem, généralisée à plus de champs puisqu'une scène
 * a davantage de contenu éditable qu'un simple média).
 * @param {string} id
 * @param {Object} patch
 * @returns {Object|null} la scène mise à jour, ou null si id inconnu
 */
function updateScene(id, patch) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return null;

  const item = items[idx];
  if (patch && typeof patch === 'object') {
    if (typeof patch.name === 'string' && patch.name.trim()) {
      item.name = patch.name.trim().slice(0, MAX_NAME_LENGTH);
    }
    if (patch.background !== undefined) {
      item.background = sanitizeBackground(patch.background);
    }
    if (patch.elements !== undefined) {
      item.elements = sanitizeElements(patch.elements);
    }
  }
  item.updatedAt = new Date().toISOString();

  items[idx] = item;
  writeIndex(items);
  return item;
}

/**
 * Supprime une scène (entrée d'index seulement — une scène ne possède aucun
 * fichier propre, voir l'en-tête du fichier).
 * @param {string} id
 * @returns {boolean} true si une scène a bien été supprimée
 */
function deleteItem(id) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeIndex(items);
  return true;
}

/**
 * @returns {Object|null} la scène marquée "poster principal", ou null si aucune.
 */
function getDefaultScene() {
  return readIndex().find((item) => item.isDefault) || null;
}

/**
 * Marque une scène comme "poster principal" — affichée automatiquement sur
 * l'overlay dès que rien d'autre n'est à l'écran. Un seul élément à la fois
 * DANS CET INDEX : marquer celle-ci démarque automatiquement l'ancienne.
 *
 * NE touche PAS à media-library.js — l'arbitrage "un seul poster principal
 * à la fois, scène OU média" est le lot 2 (voir l'en-tête du fichier),
 * volontairement absent de ce lot pour rester un store pur et additif.
 * @param {string} id
 * @returns {Object|null} la scène désormais principale, ou null si id inconnu
 */
function setDefaultScene(id) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return null;

  for (const item of items) {
    item.isDefault = item.id === id;
  }
  writeIndex(items);
  return items[idx];
}

/**
 * Retire le statut "poster principal" de la scène qui l'a actuellement (s'il
 * y en a une). Sans effet si aucune scène n'est marquée principale.
 * @returns {Object|null} la scène qui était principale, désormais démarquée — ou null
 */
function clearDefaultScene() {
  const items = readIndex();
  const idx = items.findIndex((item) => item.isDefault);
  if (idx === -1) return null;
  items[idx].isDefault = false;
  writeIndex(items);
  return items[idx];
}

module.exports = {
  setUserDataDir,
  listItems,
  getItem,
  addScene,
  updateScene,
  deleteItem,
  getDefaultScene,
  setDefaultScene,
  clearDefaultScene,
  // Exposées pour tests unitaires (test-scene-store.js).
  POSITION_PRESETS,
  DEFAULT_POSITION,
  FONT_FAMILIES,
  DEFAULT_FONT_FAMILY,
  TEXT_ALIGNMENTS,
  DEFAULT_TEXT_ALIGN,
  FONT_WEIGHTS,
  DEFAULT_FONT_WEIGHT,
  MAX_ELEMENTS_PER_SCENE,
  MAX_SCENES,
  MIN_FONT_SIZE_PCT,
  MAX_FONT_SIZE_PCT,
};
