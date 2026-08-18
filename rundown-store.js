/**
 * ============================================================================
 * rundown-store.js — Feuille de route (rundown/cue-list)
 * ----------------------------------------------------------------------------
 * AJOUT (chantier 4.3 — sortie broadcast, référence SPX-GC) : une séquence
 * PRÉ-PLANIFIÉE de repères (verset/média/scène) que l'opérateur construit à
 * l'avance et déclenche dans l'ordre pendant le culte, plutôt que de ne
 * réagir qu'en direct. Distinct de verse-queue.js (file d'attente de VERSETS
 * seulement, purement côté dashboard, perdue au rechargement) : ici, mixte
 * (verset/média/scène) et PERSISTÉ côté serveur — survit à un rechargement
 * du tableau de bord et reste synchronisé entre plusieurs postes opérateur.
 *
 * Même discipline que scene-store.js/media-library.js : petit index JSON
 * local dans userData, aucun appel API, aucune dépendance externe. Un repère
 * (cue) ne possède aucun fichier propre — il référence un média/une scène
 * déjà existant par son id (mêmes dégradations propres que scene-store.js si
 * l'élément référencé disparaît ensuite : le repère reste dans la liste,
 * l'échec au déclenchement seul est signalé, jamais un plantage).
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CUES = 200; // un ordre de culte complet, large marge — pas un CMS
const MAX_LABEL_LENGTH = 200; // même borne que le label d'un élément de médiathèque
const CUE_TYPES = new Set(['verse', 'media', 'scene']);

let indexPath = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  indexPath = path.join(dir, 'rundown.json');
}

function readIndex() {
  if (!indexPath || !fs.existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[rundown-store] Lecture impossible, index ignoré:', e.message);
    return [];
  }
}

function writeIndex(items) {
  if (!indexPath) return;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), 'utf8');
}

/**
 * Liste tous les repères, dans l'ordre de déclenchement.
 * @returns {Array<Object>}
 */
function listCues() {
  return readIndex();
}

/**
 * @param {string} id
 * @returns {Object|null}
 */
function getCue(id) {
  return readIndex().find((cue) => cue.id === id) || null;
}

/**
 * Ajoute un repère à la fin de la feuille de route.
 * @param {Object} data
 * @param {'verse'|'media'|'scene'} data.type
 * @param {string} data.label - libellé affiché dans la liste (jamais résolu à nouveau depuis reference/mediaId/sceneId — pour qu'un média supprimé plus tard reste identifiable dans la liste)
 * @param {string} [data.reference] - requis si type==='verse' (ex. "Jean 3:16", parsée comme showVerse)
 * @param {string} [data.mediaId] - requis si type==='media'
 * @param {string} [data.sceneId] - requis si type==='scene'
 * @returns {Object} le repère créé
 */
function addCue(data) {
  if (!indexPath) throw new Error('rundown-store: setUserDataDir() non appelé');
  if (!data || !CUE_TYPES.has(data.type)) {
    throw new Error('Type de repère invalide (attendu: verse, media ou scene)');
  }
  const label =
    typeof data.label === 'string' && data.label.trim()
      ? data.label.trim().slice(0, MAX_LABEL_LENGTH)
      : '';
  if (!label) throw new Error('Libellé de repère manquant');

  const cue = {
    id: crypto.randomUUID(),
    type: data.type,
    label,
    addedAt: new Date().toISOString(),
  };
  if (data.type === 'verse') {
    if (typeof data.reference !== 'string' || !data.reference.trim()) {
      throw new Error('Référence biblique manquante pour un repère de type verset');
    }
    cue.reference = data.reference.trim();
  } else if (data.type === 'media') {
    if (typeof data.mediaId !== 'string' || !data.mediaId) {
      throw new Error('mediaId manquant pour un repère de type média');
    }
    cue.mediaId = data.mediaId;
  } else {
    if (typeof data.sceneId !== 'string' || !data.sceneId) {
      throw new Error('sceneId manquant pour un repère de type scène');
    }
    cue.sceneId = data.sceneId;
  }

  const items = readIndex();
  if (items.length >= MAX_CUES) {
    throw new Error(`Feuille de route pleine (maximum ${MAX_CUES} repères)`);
  }
  items.push(cue);
  writeIndex(items);
  return cue;
}

/**
 * Retire un repère de la feuille de route.
 * @param {string} id
 * @returns {boolean} true si un repère a bien été supprimé
 */
function removeCue(id) {
  const items = readIndex();
  const idx = items.findIndex((cue) => cue.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeIndex(items);
  return true;
}

/**
 * Réordonne la feuille de route selon l'ordre d'ids fourni (glisser-déposer
 * côté tableau de bord). Les ids inconnus sont ignorés silencieusement ; les
 * repères existants absents de `orderedIds` sont ajoutés à la fin dans leur
 * ordre relatif d'origine — un réordonnancement partiel (ex. bug client) ne
 * fait jamais disparaître un repère.
 * @param {Array<string>} orderedIds
 * @returns {Array<Object>} la nouvelle liste, dans son ordre définitif
 */
function reorderCues(orderedIds) {
  const items = readIndex();
  if (!Array.isArray(orderedIds)) return items;

  const byId = new Map(items.map((cue) => [cue.id, cue]));
  const reordered = [];
  const seen = new Set();
  for (const id of orderedIds) {
    const cue = byId.get(id);
    if (cue && !seen.has(id)) {
      reordered.push(cue);
      seen.add(id);
    }
  }
  for (const cue of items) {
    if (!seen.has(cue.id)) {
      reordered.push(cue);
      seen.add(cue.id);
    }
  }
  writeIndex(reordered);
  return reordered;
}

/**
 * Vide entièrement la feuille de route (nouveau culte, "on repart de zéro").
 */
function clearCues() {
  writeIndex([]);
}

module.exports = {
  setUserDataDir,
  listCues,
  getCue,
  addCue,
  removeCue,
  reorderCues,
  clearCues,
  // Exposées pour tests unitaires (test-rundown-store.js).
  CUE_TYPES,
  MAX_CUES,
  MAX_LABEL_LENGTH,
};
