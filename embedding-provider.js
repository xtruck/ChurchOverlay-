'use strict';
/**
 * ============================================================================
 * embedding-provider.js — Génération d'embeddings de texte (Gemini)
 * ----------------------------------------------------------------------------
 * AJOUT (chantier 4.2 — recherche sémantique biblique) : bible-semantic-search.js
 * a besoin d'un vecteur par verset (index, à la construction) ET d'un vecteur
 * par requête (à l'exécution, recherche par sujet). Seul GEMINI_API_KEY donne
 * accès à un modèle d'embedding dans cette stack (Groq n'expose pas
 * d'endpoint d'embeddings) — voir groq-wrapper.js pour le même choix de
 * fournisseur côté chat. Absent délibérément du mode "gratuit/léger" suivi
 * par sermon-qa.js/sermon-archive.js (voir leurs en-têtes) : cette extension
 * a été demandée explicitement pour bible-semantic-search.js malgré le coût
 * d'un appel API, décision prise en session le 2026-08-18 (voir
 * JOURNAL-MISSION.md).
 *
 * Comportement en l'absence de GEMINI_API_KEY : embedTexts()/embedQuery()
 * renvoient null (jamais d'exception non attrapée) — même discipline que
 * chatCompletion() ailleurs dans ce dépôt (mode dégradé, pas de crash).
 * ============================================================================
 */

const { GoogleGenAI } = require('@google/genai');

const CONFIG = {
  MODEL: 'text-embedding-004',
  // 768 = dimension native de text-embedding-004. sqlite-vec ne demande
  // aucune dimension particulière — ce choix fixe simplement la taille de
  // colonne vec0 utilisée par bible-vector-store.js, à garder synchronisée
  // avec elle si ce modèle change un jour.
  OUTPUT_DIMENSIONALITY: 768,
  // L'API Gemini limite la taille des lots d'embedContent — valeur prudente,
  // pas de valeur officielle documentée dans le SDK à ce jour.
  BATCH_SIZE: 100,
};

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

/**
 * Génère un embedding par texte, dans l'ordre. Renvoie null (pas
 * d'exception) si GEMINI_API_KEY est absent ou si l'appel échoue.
 * @param {string[]} texts
 * @param {{ taskType?: string }} [options]
 * @returns {Promise<number[][]|null>}
 */
async function embedTexts(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[embedding-provider] GEMINI_API_KEY non défini — embeddings indisponibles.');
    return null;
  }

  const { taskType = 'RETRIEVAL_DOCUMENT' } = options;
  const ai = new GoogleGenAI({ apiKey });
  const results = [];

  try {
    for (const batch of chunk(texts, CONFIG.BATCH_SIZE)) {
      const res = await ai.models.embedContent({
        model: CONFIG.MODEL,
        contents: batch,
        config: {
          taskType,
          outputDimensionality: CONFIG.OUTPUT_DIMENSIONALITY,
        },
      });
      const embeddings = res.embeddings || [];
      if (embeddings.length !== batch.length) {
        throw new Error(
          `Réponse Gemini incomplète : ${embeddings.length} embeddings pour ${batch.length} textes.`
        );
      }
      for (const e of embeddings) {
        if (!Array.isArray(e.values)) {
          throw new Error('Embedding sans champ values dans la réponse Gemini.');
        }
        results.push(e.values);
      }
    }
    return results;
  } catch (err) {
    console.warn('[embedding-provider] Échec embedContent:', err.message);
    return null;
  }
}

/**
 * Raccourci pour un seul texte de requête (taskType=RETRIEVAL_QUERY —
 * asymétrique par rapport à RETRIEVAL_DOCUMENT utilisé à l'indexation,
 * recommandation Google pour ce modèle).
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embedQuery(text) {
  const result = await embedTexts([text], { taskType: 'RETRIEVAL_QUERY' });
  return result && result.length > 0 ? result[0] : null;
}

module.exports = { embedTexts, embedQuery, CONFIG };
