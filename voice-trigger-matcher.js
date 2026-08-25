'use strict';
/**
 * voice-trigger-matcher.js — correspondance de phrases déclencheuses à la
 * voix, mutualisée (Chantier D, mission autonome).
 *
 * AJOUT (Partie 2.3 — Mur Média, collisions phonétiques) : findPhoneticCollisions()
 * détecte, DÈS L'IMPORT (pas seulement quand la confusion frappe en plein
 * culte), deux phrases déclencheuses trop proches l'une de l'autre au sens
 * Levenshtein — deux formulations proches ont de fortes chances d'être
 * confondues par la reconnaissance vocale (ex. "photo groupe jeunes" vs
 * "photo groupe jeudi"). Générique comme le reste de ce module : accepte
 * n'importe quelle liste d'éléments avec des `triggerPhrases`, donc
 * réutilisable pour vérifier des collisions ENTRE médiathèque et
 * bibliothèque de chants, pas seulement au sein d'une seule des deux.
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

const { levenshteinDistance } = require('./levenshtein');

/**
 * Seuil de tolérance adaptatif, même esprit que toleranceForLength() dans
 * levenshtein.js (noms de livres) mais calibré pour des phrases
 * déclencheuses plus longues (plusieurs mots) : plus la phrase la plus
 * courte des deux est longue, plus on tolère de caractères de différence
 * avant de la considérer comme une vraie collision plutôt qu'une simple
 * formulation voisine mais distincte.
 * @param {number} len
 * @returns {number}
 */
function toleranceForPhraseLength(len) {
  if (len <= 6) return 1;
  if (len <= 12) return 2;
  return 3;
}

/**
 * Détecte les collisions phonétiques entre des phrases déclencheuses
 * CANDIDATES (ex. celles d'un nouveau média en cours d'ajout) et celles
 * d'éléments déjà existants (media-library.js, song-library.js, ou les
 * deux combinés par l'appelant).
 *
 * @param {string[]} candidatePhrases - phrases à vérifier (pas encore
 *   enregistrées, ou en cours de modification)
 * @param {Array<Object>} existingItems - éléments déjà enregistrés
 * @param {Object} [opts]
 * @param {string} [opts.excludeId] - id à ignorer (édition d'un élément
 *   existant : ne pas se comparer à soi-même)
 * @param {(item: Object) => string[]} [opts.getTriggerPhrases] - défaut :
 *   `item.triggerPhrases`
 * @returns {Array<{phrase: string, withItem: Object, withPhrase: string, distance: number, exact: boolean}>}
 *   une entrée par paire en collision, triée par distance croissante
 *   (les collisions les plus dangereuses — quasi identiques — en premier).
 */
function findPhoneticCollisions(candidatePhrases, existingItems, opts = {}) {
  const excludeId = opts.excludeId;
  const getTriggerPhrases = opts.getTriggerPhrases || ((item) => item.triggerPhrases);
  const collisions = [];

  const candidates = (candidatePhrases || [])
    .map((p) => ({ original: p, normalized: normalizeTriggerText(p) }))
    .filter((c) => c.normalized);

  for (const item of existingItems || []) {
    if (excludeId && item.id === excludeId) continue;
    for (const existingPhrase of getTriggerPhrases(item) || []) {
      const normalizedExisting = normalizeTriggerText(existingPhrase);
      if (!normalizedExisting) continue;
      for (const candidate of candidates) {
        if (candidate.normalized === normalizedExisting) {
          collisions.push({
            phrase: candidate.original,
            withItem: item,
            withPhrase: existingPhrase,
            distance: 0,
            exact: true,
          });
          continue;
        }
        const shorterLen = Math.min(candidate.normalized.length, normalizedExisting.length);
        const threshold = toleranceForPhraseLength(shorterLen);
        const dist = levenshteinDistance(candidate.normalized, normalizedExisting);
        if (dist <= threshold) {
          collisions.push({
            phrase: candidate.original,
            withItem: item,
            withPhrase: existingPhrase,
            distance: dist,
            exact: false,
          });
        }
      }
    }
  }

  collisions.sort((a, b) => a.distance - b.distance);
  return collisions;
}

module.exports = { normalizeTriggerText, findTriggerMatch, findPhoneticCollisions };
