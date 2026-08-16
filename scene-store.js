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
 * PORTÉE : store pur, aucun branchement server.js/overlay.html/dashboard
 * pour l'instant (voir les lots suivants). setDefaultScene()/setDefaultItem()
 * (media-library.js) s'arbitrent mutuellement depuis le lot 2 — un seul
 * poster principal à la fois dans toute l'app, scène OU média (voir
 * setDefaultScene() plus bas pour le détail du mécanisme).
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
const MAX_TRIGGER_PHRASES = 20; // même borne que media-library.js#addItem

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

// Même approche que media-library.js#normalize (\p{M} après décomposition
// NFD) — équivalente en résultat, réutilisée ici pour que matchTriggerPhrase()
// se comporte identiquement (une phrase déclencheuse accentuée doit matcher
// que la parole retranscrite le soit ou non, et vice versa).
function normalize(text) {
  return (text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
}

function sanitizeTriggerPhrases(input) {
  return (Array.isArray(input) ? input : [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_TRIGGER_PHRASES)
    .map((p) => p.slice(0, MAX_NAME_LENGTH));
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
  const name = data.name.trim().slice(0, MAX_NAME_LENGTH);
  let triggerPhrases = sanitizeTriggerPhrases(data.triggerPhrases);
  // AJOUT (déclenchement vocal des scènes — même écart que media-library.js#addItem
  // "je nomme, je dis le nom pour l'afficher") : le nom sert de phrase
  // déclencheuse par défaut quand aucune n'est saisie, pour qu'une scène
  // composée sans jamais toucher le champ "phrases déclencheuses" reste
  // atteignable à la voix plutôt que muette silencieusement.
  if (triggerPhrases.length === 0 && name) {
    triggerPhrases = [name];
  }
  const item = {
    id: crypto.randomUUID(),
    name,
    addedAt: now,
    updatedAt: now,
    background: sanitizeBackground(data.background),
    elements: sanitizeElements(data.elements),
    triggerPhrases,
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
    if (patch.triggerPhrases !== undefined) {
      item.triggerPhrases = sanitizeTriggerPhrases(patch.triggerPhrases);
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
 * AJOUT (studio de scènes, lot 2/6 — arbitrage croisé) : un seul poster
 * principal à la fois DANS TOUTE L'APP, scène OU média — jamais les deux en
 * même temps (sinon lequel l'overlay devrait-il réafficher ?). Démarque donc
 * aussi tout média par défaut existant côté media-library.js, symétrique à
 * media-library.js#setDefaultItem qui fait l'inverse.
 * @param {string} id
 * @returns {Object|null} la scène désormais principale, ou null si id inconnu
 */
function setDefaultScene(id) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return null;

  // Requis en retard (pas en haut du fichier) pour éviter une dépendance
  // circulaire au chargement : media-library.js requiert lui-même ce module
  // pour l'arbitrage symétrique (voir setDefaultItem() dans media-library.js).
  const mediaLibrary = require('./media-library');
  mediaLibrary.clearDefaultItem();

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

/**
 * Cherche si un texte transcrit contient l'une des phrases déclencheuses
 * d'une scène — même mécanisme et même philosophie que
 * media-library.js#matchTriggerPhrase (sous-chaîne sur texte normalisé, pas
 * de LLM). Permet à une scène composée (fond + texte + logo) d'être
 * déclenchée à la voix exactement comme un média, en plus du déclenchement
 * manuel déjà disponible (bouton "Afficher" de la galerie).
 * @param {string} text - texte transcrit (brut, pas encore normalisé)
 * @returns {Object|null} la scène déclenchée, ou null
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
  addScene,
  updateScene,
  deleteItem,
  getDefaultScene,
  setDefaultScene,
  clearDefaultScene,
  matchTriggerPhrase,
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
  MAX_TRIGGER_PHRASES,
  MIN_FONT_SIZE_PCT,
  MAX_FONT_SIZE_PCT,
};
