'use strict';
/**
 * ============================================================================
 *  llm-utils.js — utilitaires pour la normalisation des réponses LLM
 * ----------------------------------------------------------------------------
 *  centralise l'extraction du texte brut depuis les réponses de
 *  groq-wrapper.chatCompletion() / quickCompletion() (format :
 *  `{text: string, model: string, usage: Object}`).
 *
 *  Avant ce correctif, chaque appelant faisait `(response.text || response).trim()`
 *  — le fallback || response passait l'objet brut au .trim() quand la clé text
 *  était absente (format inattendu), ou crashait si la réponse était autre chose
 *  qu'une string. extractResponseText() est un garde-fou défensif qui normalise
 *  le tout en une seule string propre, sans crash.
 * ============================================================================
 */
function extractResponseText(response) {
  if (response && typeof response.text === 'string') {
    return response.text.trim();
  }
  if (typeof response === 'string') {
    return response.trim();
  }
  console.warn('[llm-utils] extractResponseText: réponse inattendue', typeof response);
  return '';
}

module.exports = { extractResponseText };
