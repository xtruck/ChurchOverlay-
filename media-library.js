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
const { findTriggerMatch, findPhoneticCollisions } = require('./voice-trigger-matcher');

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

// AJOUT (demande explicite — détails d'affichage média : durée + style
// d'apparition). Styles CSS-only côté overlay.html (transform/opacity,
// composités par le GPU — voir l'audit perf de cette même session), jamais
// de JS lourd par frame.
const TRANSITION_STYLES = new Set(['fade', 'slide', 'zoom', 'cut']);
const DEFAULT_TRANSITION_STYLE = 'fade';

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

/**
 * Liste tous les éléments de la médiathèque (métadonnées seulement, pas les
 * octets du fichier).
 * @returns {Array<Object>}
 */
/**
 * AJOUT (Partie 2.3 — Mur Média, état "fichier manquant") : l'index JSON et
 * le fichier réel sur disque peuvent diverger (suppression manuelle du
 * dossier media/, disque externe débranché, migration incomplète…) —
 * jusqu'ici listItems() renvoyait la métadonnée comme si de rien n'était,
 * et cliquer dessus échouait silencieusement côté overlay (image cassée).
 * `fileMissing` rend ce cas visible AVANT le clic, pas après, dans le mur
 * média (voir dashboard/features/media-library.js#renderMediaWall).
 */
function listItems() {
  return readIndex().map((item) => ({
    ...item,
    fileMissing: !mediaDir || !fs.existsSync(path.join(mediaDir, item.filename)),
  }));
}

/**
 * @param {string} id
 * @returns {Object|null}
 */
function getItem(id) {
  return readIndex().find((item) => item.id === id) || null;
}

function sanitizeTransitionStyle(style) {
  return TRANSITION_STYLES.has(style) ? style : DEFAULT_TRANSITION_STYLE;
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

  const label = (data.label || path.basename(data.sourcePath, ext)).slice(0, 200);
  let triggerPhrases = (Array.isArray(data.triggerPhrases) ? data.triggerPhrases : [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  // AJOUT (audit — écart avec l'intention "je nomme le média, je dis son nom
  // pour l'afficher") : un opérateur qui ne remplit que le champ "Nom" en
  // pensant que ça suffit se retrouvait avec un média silencieusement
  // inatteignable à la voix (triggerPhrases resté vide). Le nom sert
  // maintenant de phrase déclencheuse par défaut quand aucune n'est saisie —
  // un champ "phrases déclencheuses" toujours rempli reste prioritaire.
  if (triggerPhrases.length === 0 && label) {
    triggerPhrases = [label];
  }

  const item = {
    id,
    label,
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
    // AJOUT (détails d'affichage média — style d'apparition à l'écran).
    transitionStyle: sanitizeTransitionStyle(data.transitionStyle),
    // AJOUT (demande explicite — "poster principal") : voir setDefaultItem()
    // plus bas. Un seul élément à la fois peut être vrai.
    isDefault: false,
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
 * Modifie les détails d'affichage d'un élément déjà uploadé — durée et
 * style d'apparition (demande explicite : "pour les médias déjà composés").
 * Ne touche jamais au fichier ni aux phrases déclencheuses (utiliser
 * deleteItem() + addItem() pour ça) — uniquement les champs listés ici,
 * pour rester un patch simple et prévisible.
 * @param {string} id
 * @param {Object} patch
 * @param {number|null} [patch.displayDurationMs] - null = jusqu'à fin de vidéo/masquage manuel
 * @param {string} [patch.transitionStyle] - 'fade' | 'slide' | 'zoom' | 'cut'
 * @returns {Object|null} l'élément mis à jour, ou null si id inconnu
 */
function updateItem(id, patch) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return null;

  const item = items[idx];
  if (patch && typeof patch === 'object') {
    if (patch.displayDurationMs === null) {
      item.displayDurationMs = null;
    } else if (typeof patch.displayDurationMs === 'number' && patch.displayDurationMs > 0) {
      item.displayDurationMs = patch.displayDurationMs;
    }
    if (patch.transitionStyle !== undefined) {
      item.transitionStyle = sanitizeTransitionStyle(patch.transitionStyle);
    }
  }

  items[idx] = item;
  writeIndex(items);
  return item;
}

/**
 * @returns {Object|null} l'élément marqué "poster principal", ou null si aucun.
 */
function getDefaultItem() {
  return readIndex().find((item) => item.isDefault) || null;
}

/**
 * Marque un élément comme "poster principal" — affiché automatiquement sur
 * l'overlay dès que rien d'autre n'est à l'écran (ni verset, ni média
 * déclenché). Un seul élément à la fois : marquer celui-ci démarque
 * automatiquement l'ancien (voir server.js/overlay.html pour la diffusion
 * en direct de ce changement).
 *
 * displayDurationMs est forcé à null (jamais de minuterie automatique) :
 * un poster "principal" qui s'auto-masquerait après quelques secondes puis
 * réapparaîtrait aussitôt (voir maybeShowDefaultMedia() dans overlay.html)
 * ne ferait que clignoter sans raison.
 *
 * AJOUT (studio de scènes, lot 2/6 — arbitrage croisé) : un seul poster
 * principal à la fois DANS TOUTE L'APP, média OU scène — démarque donc aussi
 * toute scène par défaut existante côté scene-store.js, symétrique à
 * scene-store.js#setDefaultScene qui fait l'inverse.
 * @param {string} id
 * @returns {Object|null} l'élément désormais principal, ou null si id inconnu
 */
function setDefaultItem(id) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return null;

  // Requis en retard (pas en haut du fichier) pour éviter une dépendance
  // circulaire au chargement : scene-store.js requiert lui-même ce module
  // pour l'arbitrage symétrique (voir setDefaultScene() dans scene-store.js).
  const sceneStore = require('./scene-store');
  sceneStore.clearDefaultScene();

  for (const item of items) {
    item.isDefault = item.id === id;
  }
  items[idx].displayDurationMs = null;
  writeIndex(items);
  return items[idx];
}

/**
 * Retire le statut "poster principal" de l'élément qui l'a actuellement (s'il
 * y en a un). Sans effet si aucun élément n'est marqué principal.
 * @returns {Object|null} l'élément qui était principal, désormais démarqué — ou null
 */
function clearDefaultItem() {
  const items = readIndex();
  const idx = items.findIndex((item) => item.isDefault);
  if (idx === -1) return null;
  items[idx].isDefault = false;
  writeIndex(items);
  return items[idx];
}

/**
 * Cherche si un texte transcrit contient l'une des phrases déclencheuses
 * d'un élément de la médiathèque — voir voice-trigger-matcher.js (mutualisé
 * avec song-library.js, même mécanisme).
 * @param {string} text - texte transcrit (brut, pas encore normalisé)
 * @returns {Object|null} l'élément déclenché, ou null
 */
function matchTriggerPhrase(text) {
  return findTriggerMatch(readIndex(), text);
}

/**
 * Vérifie si des phrases déclencheuses candidates entrent en collision
 * phonétique avec des phrases déjà enregistrées dans CETTE médiathèque
 * (voir findPhoneticCollisions dans voice-trigger-matcher.js). Ne couvre PAS
 * la bibliothèque de chants par défaut — server.js combine les deux listes
 * lui-même s'il veut une vérification croisée (voir action WS
 * addMediaItem/updateMediaItem), pour ne pas coupler ce module à
 * song-library.js.
 * @param {string[]} candidatePhrases
 * @param {string} [excludeId] - id à ignorer (édition d'un élément existant)
 * @returns {Array} voir findPhoneticCollisions
 */
function checkTriggerCollisions(candidatePhrases, excludeId) {
  return findPhoneticCollisions(candidatePhrases, readIndex(), { excludeId });
}

module.exports = {
  setUserDataDir,
  listItems,
  getItem,
  addItem,
  updateItem,
  deleteItem,
  getDefaultItem,
  setDefaultItem,
  clearDefaultItem,
  matchTriggerPhrase,
  checkTriggerCollisions,
  // Exposées pour tests unitaires (test-media-library.js).
  ALLOWED_EXTENSIONS,
  DEFAULT_IMAGE_DURATION_MS,
  TRANSITION_STYLES,
  DEFAULT_TRANSITION_STYLE,
};
