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
const { writeJsonAtomic } = require('./persistence/atomic-json-store');

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
let groupsPath = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  indexPath = path.join(dir, 'media-library.json');
  mediaDir = path.join(dir, 'media');
  groupsPath = path.join(dir, 'media-groups.json');
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

// AJOUT (Partie 2.3 — groupes nommés déclenchables à la voix) : fichier JSON
// SÉPARÉ (media-groups.json) plutôt qu'un champ de plus dans l'index média —
// un groupe référence des `memberIds` (media-library.js) mais pourrait tout
// aussi bien un jour référencer des chants ; les garder distincts évite de
// coupler la forme de l'index média à ce concept transversal.
function readGroups() {
  if (!groupsPath || !fs.existsSync(groupsPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[media-library] Lecture des groupes impossible, ignorée:', e.message);
    return [];
  }
}

function writeGroups(groups) {
  if (!groupsPath) return;
  writeJsonAtomic(groupsPath, groups);
}

/**
 * Liste les groupes (nom, phrases déclencheuses, membres, curseur de
 * rotation) — métadonnées seulement.
 * @returns {Array<Object>}
 */
function listGroups() {
  return readGroups();
}

/**
 * Crée un groupe nommé, déclenchable à la voix par ses PROPRES phrases
 * déclencheuses (distinctes de celles de ses membres). DÉCISION DE SCOPE
 * (aucune autre interprétation univoque dans le cahier des charges) : dire
 * la phrase du groupe affiche le PROCHAIN membre non encore montré depuis
 * le début du culte (rotation), pas tous les membres à la fois — sert le cas
 * d'usage réel "j'ai 5 photos de la sortie jeunesse, une seule phrase à
 * retenir, chacune apparaît à son tour au fil du culte".
 * @param {{name: string, triggerPhrases?: string[]}} data
 * @returns {Object} le groupe créé
 */
function addGroup(data) {
  if (!data || !data.name || !data.name.trim()) throw new Error('Nom de groupe manquant');
  const groups = readGroups();
  const triggerPhrases = (Array.isArray(data.triggerPhrases) ? data.triggerPhrases : [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .slice(0, 20)
    .map((p) => p.slice(0, 200));
  const group = {
    id: crypto.randomUUID(),
    name: data.name.trim().slice(0, 200),
    triggerPhrases: triggerPhrases.length ? triggerPhrases : [data.name.trim()],
    memberIds: [],
    cursor: 0,
    addedAt: new Date().toISOString(),
  };
  groups.unshift(group);
  writeGroups(groups);
  return group;
}

function deleteGroup(id) {
  const groups = readGroups();
  const idx = groups.findIndex((g) => g.id === id);
  if (idx === -1) return false;
  groups.splice(idx, 1);
  writeGroups(groups);
  // Les membres perdent leur rattachement (le champ `group` de chaque item
  // pointait vers cet id — voir setItemGroup) : nettoyé pour ne pas laisser
  // un item pointer vers un groupe qui n'existe plus.
  const items = readIndex();
  let changed = false;
  for (const item of items) {
    if (item.group === id) {
      item.group = null;
      changed = true;
    }
  }
  if (changed) writeIndex(items);
  return true;
}

/**
 * Rattache (ou détache si groupId est null) un média à un groupe. Un média
 * appartient à AU PLUS UN groupe à la fois — le retirer d'abord de tout
 * groupe précédent évite qu'il soit montré deux fois par deux phrases
 * différentes.
 * @param {string} itemId
 * @param {string|null} groupId
 * @returns {boolean} true si l'item existe et a été mis à jour
 */
function setItemGroup(itemId, groupId) {
  const items = readIndex();
  const item = items.find((i) => i.id === itemId);
  if (!item) return false;

  const groups = readGroups();
  for (const g of groups) {
    g.memberIds = g.memberIds.filter((id) => id !== itemId);
  }
  item.group = null;

  if (groupId) {
    const target = groups.find((g) => g.id === groupId);
    if (!target) return false;
    target.memberIds.push(itemId);
    item.group = groupId;
  }

  writeGroups(groups);
  writeIndex(items);
  return true;
}

/**
 * Cherche si un texte transcrit contient la phrase déclencheuse d'un
 * groupe, et si oui renvoie le PROCHAIN membre (rotation, curseur persisté)
 * — jamais le même membre deux fois de suite tant que le groupe compte plus
 * d'un élément. Groupe vide (aucun membre) : correspondance ignorée,
 * comportement identique à "aucune correspondance" plutôt que de planter ou
 * de déclencher un média inexistant.
 * @param {string} text
 * @returns {Object|null} l'élément média à afficher, ou null
 */
/**
 * @param {string} text
 * @param {{dryRun?: boolean}} [opts] - dryRun: ne fait AVANCER ni persister le
 *   curseur de rotation — utilisé par le bouton "essayer" (server.js,
 *   action WS testTriggerPhrase) pour vérifier qu'une phrase de groupe
 *   matche sans consommer un tour de rotation destiné au vrai culte.
 */
function matchGroupTriggerPhrase(text, opts = {}) {
  const groups = readGroups();
  const matchedGroup = findTriggerMatch(groups, text);
  if (!matchedGroup || matchedGroup.memberIds.length === 0) return null;

  const items = readIndex();
  const nextIndex = matchedGroup.cursor % matchedGroup.memberIds.length;
  const nextItem = items.find((i) => i.id === matchedGroup.memberIds[nextIndex]);

  if (!opts.dryRun) {
    // Curseur avancé et persisté même si l'item référencé a depuis été
    // supprimé (nextItem null) — une entrée fantôme dans memberIds ne doit
    // jamais bloquer la rotation des suivantes indéfiniment sur la même case.
    matchedGroup.cursor = (matchedGroup.cursor + 1) % matchedGroup.memberIds.length;
    writeGroups(groups);
  }

  return nextItem || null;
}

function writeIndex(items) {
  if (!indexPath) return;
  writeJsonAtomic(indexPath, items);
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
    // AJOUT (Partie 2.3 — groupes) : id du groupe (media-groups.json) auquel
    // cet élément appartient, ou null. Rattaché après coup via setItemGroup(),
    // jamais à la création (le groupe doit déjà exister).
    group: null,
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
  listGroups,
  addGroup,
  deleteGroup,
  setItemGroup,
  matchGroupTriggerPhrase,
  // Exposées pour tests unitaires (test-media-library.js).
  ALLOWED_EXTENSIONS,
  DEFAULT_IMAGE_DURATION_MS,
  TRANSITION_STYLES,
  DEFAULT_TRANSITION_STYLE,
};
