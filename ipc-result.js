'use strict';
/**
 * ============================================================================
 *  ipc-result.js — Modèle de type Result pour les handlers ipcMain.handle()
 * ----------------------------------------------------------------------------
 *  AJOUT (chantier durcissement v1.0 — Sécurité IPC type-safe). Avant ce
 *  module, les handlers IPC de main.js renvoyaient un mélange de formes au
 *  succès/échec : { ok, ...champs, error }, une valeur brute (string/null),
 *  ou un `throw` (rejet de la Promise côté renderer) — trois conventions
 *  différentes selon le handler, aucune garantie côté appelant sur la forme
 *  reçue.
 *
 *  Modèle UNIQUE désormais utilisé par les handlers qui peuvent échouer
 *  (config, thèmes, intégrations OBS/ProPresenter/Planning Center) :
 *    { success: true,  data?: T }
 *    { success: false, error: string }
 *  jamais les deux à la fois, jamais de troisième forme. Toujours une
 *  RÉSOLUTION de la Promise IPC (jamais un rejet) pour un échec métier
 *  attendu (mauvaise config, service distant indisponible…) — un renderer
 *  n'a besoin que d'un seul chemin (`if (!result.success)`) au lieu de
 *  mélanger try/catch ET vérification de champ selon le handler appelé.
 *
 *  Les handlers purement "accès disque système" (sélecteurs de fichiers
 *  dialog.showOpenDialog, get-status, get-settings…) restent inchangés :
 *  ils n'ont pas de branche d'échec métier significative (annulation
 *  utilisateur = null, pas une erreur), et un rejet de Promise pour une
 *  vraie exception inattendue reste le comportement Electron standard.
 * ============================================================================
 */

/**
 * @template T
 * @param {T} [data] - payload optionnel (omis si l'action ne renvoie rien
 *   d'utile au-delà du succès lui-même, ex. un simple enregistrement).
 * @returns {{success: true, data?: T}}
 */
function okResult(data) {
  return data === undefined ? { success: true } : { success: true, data };
}

/**
 * @param {string|Error} error - message d'erreur, ou une Error dont
 *   `.message` est extrait (jamais l'objet Error lui-même : IPC sérialise en
 *   JSON, une Error perdrait sa classe et la plupart de ses champs en route).
 * @returns {{success: false, error: string}}
 */
function errResult(error) {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Vrai si `value` a la forme Result ci-dessus (utilisé par
 * test/test-ipc-security.js pour vérifier que chaque handler migré renvoie
 * bien cette forme, jamais un mélange des deux).
 * @param {*} value
 * @returns {boolean}
 */
function isResult(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.success === true) return !('error' in value);
  if (value.success === false) return typeof value.error === 'string' && !('data' in value);
  return false;
}

module.exports = { okResult, errResult, isResult };
