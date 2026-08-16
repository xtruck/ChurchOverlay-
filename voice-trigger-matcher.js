'use strict';
/**
 * voice-trigger-matcher.js — correspondance de phrases déclencheuses à la
 * voix, mutualisée (Chantier D, mission autonome).
 * ----------------------------------------------------------------------------
 * AVANT ce module : media-library.js et song-library.js dupliquaient
 * chacun exactement la même paire normalize()/matchTriggerPhrase() (même
 * corps de fonction, même commentaire d'origine — voir l'historique git de
 * ces deux fichiers). Un correctif à la logique de correspondance (ex. un
 * garde-fou anti-collision phonétique entre déclencheurs, Chantier F)
 * n'aurait profité qu'à un seul des deux fichiers si personne ne pensait à
 * répercuter le changement dans l'autre — exactement le risque qu'une
 * mutualisation élimine.
 *
 * Correspondance par sous-chaîne sur texte normalisé (pas de LLM) — même
 * philosophie que detectCommand() (voice-commands.js) : rapide, gratuit,
 * prévisible en plein culte.
 */

/**
 * @param {string} text
 * @returns {string} texte normalisé (minuscules, accents retirés, espaces
 *   de bord retirés) — pas de \p{M} après décomposition NFD, comme
 *   sermon-archive.js.
 */
function normalizeTriggerText(text) {
  return (text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
}

/**
 * Cherche le premier élément de `items` dont une phrase déclencheuse est
 * une sous-chaîne du texte transcrit normalisé.
 * @param {Array<Object>} items - éléments à examiner (déjà chargés par
 *   l'appelant — ce module ne fait aucune I/O)
 * @param {string} text - texte transcrit (brut, pas encore normalisé)
 * @param {(item: Object) => string[]} [getTriggerPhrases] - extrait les
 *   phrases déclencheuses d'un item ; défaut : `item.triggerPhrases`
 * @returns {Object|null} le premier élément déclenché, ou null
 */
function findTriggerMatch(items, text, getTriggerPhrases = (item) => item.triggerPhrases) {
  const normalizedText = normalizeTriggerText(text);
  if (!normalizedText) return null;

  for (const item of items || []) {
    for (const phrase of getTriggerPhrases(item) || []) {
      const normalizedPhrase = normalizeTriggerText(phrase);
      if (normalizedPhrase && normalizedText.includes(normalizedPhrase)) {
        return item;
      }
    }
  }
  return null;
}

module.exports = { normalizeTriggerText, findTriggerMatch };
