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

/**
 * Extrait un objet JSON depuis une réponse LLM qui peut contenir du texte
 * superflu autour (blocs markdown ```json, commentaires, explications).
 * Renvoie l'objet parsé, ou null si aucun JSON valide n'est trouvé.
 * @param {string} text
 * @returns {Object|null}
 */
function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Essai direct (réponse JSON pure — json_mode Groq/Gemini)
  try {
    return JSON.parse(text);
  } catch (_) {
    // continue
  }

  // 2. Extraction depuis un bloc ```json ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {
      // continue
    }
  }

  // 3. Extraction du premier objet { ... } ou tableau [ ... ]
  //    Priorité au pattern qui commence le plus tôt dans le texte.
  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (objMatch && arrMatch) {
    if (objMatch.index < arrMatch.index) {
      try {
        return JSON.parse(objMatch[0]);
      } catch (_) {
        /* try arr */
      }
      try {
        return JSON.parse(arrMatch[0]);
      } catch (_) {
        /* continue */
      }
    } else {
      try {
        return JSON.parse(arrMatch[0]);
      } catch (_) {
        /* try obj */
      }
      try {
        return JSON.parse(objMatch[0]);
      } catch (_) {
        /* continue */
      }
    }
  } else if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (_) {
      /* continue */
    }
  } else if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch (_) {
      /* continue */
    }
  }

  console.warn('[llm-utils] extractJsonObject: aucun JSON valide trouvé dans la réponse');
  return null;
}

module.exports = { extractResponseText, extractJsonObject };
