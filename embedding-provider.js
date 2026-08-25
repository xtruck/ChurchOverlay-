'use strict';
/**
 * ============================================================================
 * embedding-provider.js — Génération d'embeddings de texte (Ollama local, repli Gemini)
 * ----------------------------------------------------------------------------
 * AJOUT (chantier 4.2 — recherche sémantique biblique) : bible-semantic-search.js
 * a besoin d'un vecteur par verset (index, à la construction) ET d'un vecteur
 * par requête (à l'exécution, recherche par sujet).
 *
 * CORRECTIF (2026-08-25) : Gemini (seul fournisseur au départ, Groq n'expose
 * pas d'endpoint d'embeddings) s'est révélé imprévisible pour ce volume —
 * générer l'index réel (~31 000 versets) s'est heurté à un plafond
 * JOURNALIER gratuit (voir JOURNAL-MISSION.md), qui ne s'est même pas révélé
 * fiable d'un jour à l'autre (une tentative a échoué au tout premier lot).
 * Ollama tourne EN LOCAL (aucune clé, aucun quota, aucun coût — voir
 * JOURNAL-MISSION.md pour l'installation) : préféré quand disponible
 * (`bge-m3`, modèle multilingue — vérifié en session sur du français réel,
 * bonne séparation sémantique). Gemini reste un repli automatique si Ollama
 * n'est pas joignable ET qu'une clé est configurée — jamais supprimé,
 * seulement rétrogradé, pour ne rien casser chez qui n'a pas Ollama installé.
 *
 * Les deux fournisseurs produisent des espaces vectoriels DIFFÉRENTS et
 * INCOMPATIBLES (dimensions différentes, 1024 vs 768) : mélanger les deux
 * dans le même index n'aurait aucun sens. getActiveProviderInfo() permet à
 * scripts/generate-bible-embeddings.js de savoir, AVANT de créer le fichier,
 * quel fournisseur sera réellement utilisé et quelle dimension configurer.
 *
 * Comportement si NI Ollama NI GEMINI_API_KEY ne sont disponibles :
 * embedTexts()/embedQuery() renvoient null (jamais d'exception non
 * attrapée) — même discipline que chatCompletion() ailleurs dans ce dépôt
 * (mode dégradé, pas de crash) — bible-semantic-search.js retombe alors sur
 * la recherche mot-clé, honnête et fonctionnelle.
 * ============================================================================
 */

const { GoogleGenAI } = require('@google/genai');

const OLLAMA_CONFIG = {
  BASE_URL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  MODEL: process.env.OLLAMA_EMBED_MODEL || 'bge-m3',
  // Dimension native de bge-m3 (pas de troncature Matryoshka comme Gemini —
  // vérifié : le modèle ne prend aucun paramètre de dimension de sortie).
  DIMENSION: 1024,
  BATCH_SIZE: 50,
  // Une requête localhost qui ne répond pas en 1,5s signale un serveur
  // absent/bloqué, pas une génération lente — évite d'attendre longtemps
  // avant de basculer vers le repli Gemini.
  AVAILABILITY_TIMEOUT_MS: 1500,
};

const CONFIG = {
  // CORRECTIF (2026-08-25) : text-embedding-004 n'existe plus côté API
  // (404 "not found for API version v1beta, or is not supported for
  // embedContent") — vérifié en session contre une vraie clé, voir
  // JOURNAL-MISSION.md. gemini-embedding-001 est le modèle stable actuel
  // (ListModels le confirme). embedTexts() dégrade en repli silencieux
  // (renvoie null, jamais d'exception) sur un échec d'appel — ce qui
  // signifie que la recherche sémantique était rendue INDISPONIBLE en
  // permanence par ce nom de modèle périmé, quelle que soit la clé fournie,
  // sans jamais que rien ne le signale (repli mot-clé silencieux).
  MODEL: 'gemini-embedding-001',
  // 768 = dimension choisie pour la colonne vec0 de bible-vector-store.js.
  // gemini-embedding-001 supporte une troncature Matryoshka vers 768/1536/
  // 3072 via outputDimensionality (passé ci-dessous) — 768 reste la valeur
  // à garder synchronisée avec bible-vector-store.js si ce modèle change.
  OUTPUT_DIMENSIONALITY: 768,
  // L'API Gemini limite la taille des lots d'embedContent — valeur prudente,
  // pas de valeur officielle documentée dans le SDK à ce jour.
  BATCH_SIZE: 100,
  // CORRECTIF (2026-08-25) : constaté en générant l'index réel (voir
  // JOURNAL-MISSION.md) — le palier gratuit renvoie 429 "RESOURCE_EXHAUSTED"
  // bien avant la fin d'un index de ~31 000 versets/~312 lots. err.status
  // (champ numérique du SDK @google/genai, pas juste err.message) identifie
  // sans ambiguïté ce cas précis — jamais déclenché par une erreur générique
  // (voir test/test-embedding-provider.js, qui vérifie ce non-déclenchement).
  MAX_RETRIES_ON_RATE_LIMIT: 6,
  RETRY_BASE_DELAY_MS: 5000, // doublé à chaque tentative (5s, 10s, 20s, ...)
};

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Vérifie qu'un serveur Ollama répond réellement — pas juste que l'URL est
 * configurée. Ne lève jamais (toute erreur réseau = indisponible).
 * @returns {Promise<boolean>}
 */
async function isOllamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_CONFIG.BASE_URL}/api/version`, {
      signal: AbortSignal.timeout(OLLAMA_CONFIG.AVAILABILITY_TIMEOUT_MS),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function embedTextsViaOllama(texts) {
  const results = [];
  for (const batch of chunk(texts, OLLAMA_CONFIG.BATCH_SIZE)) {
    const res = await fetch(`${OLLAMA_CONFIG.BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_CONFIG.MODEL, input: batch }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Ollama a répondu ${res.status} : ${bodyText.slice(0, 300)}`);
    }
    const data = await res.json();
    const embeddings = data.embeddings || [];
    if (embeddings.length !== batch.length) {
      throw new Error(
        `Réponse Ollama incomplète : ${embeddings.length} embeddings pour ${batch.length} textes.`
      );
    }
    results.push(...embeddings);
  }
  return results;
}

// CORRECTIF (2026-08-25) : constaté en générant l'index réel — un même code
// HTTP 429 recouvre en réalité DEUX quotas Gemini bien distincts, visibles
// uniquement dans le "quotaId" du corps JSON de l'erreur :
//   - "...PerMinute..." : un palier de DÉBIT, transitoire — retenter après
//     un court délai fonctionne (constaté : la génération réelle a progressé
//     de 100 à ~900 versets grâce à ces nouvelles tentatives).
//   - "...PerDay..." : un plafond JOURNALIER — aucun délai raisonnable dans
//     cette même journée ne le fait revenir. Le distinguer est important :
//     avant ce correctif, une tentative sur un plafond journalier épuisait
//     encore plus vite le reste du quota du jour en le retentant 6 fois en
//     pure perte (chaque tentative, même rejetée, compte contre ce quota),
//     plutôt que d'échouer immédiatement en préservant ce qu'il en restait.
function isDailyQuotaError(err) {
  try {
    const parsed = JSON.parse(err.message);
    const violations = parsed?.error?.details?.find((d) => d.violations)?.violations || [];
    return violations.some((v) => typeof v.quotaId === 'string' && /PerDay/i.test(v.quotaId));
  } catch (_) {
    return false; // message non-JSON (mock de test, etc.) -- comportement inchangé, jamais ce cas
  }
}

async function embedTextsViaGemini(texts, options) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const { taskType = 'RETRIEVAL_DOCUMENT' } = options;
  const ai = new GoogleGenAI({ apiKey });
  const results = [];

  try {
    for (const batch of chunk(texts, CONFIG.BATCH_SIZE)) {
      let res;
      let attempt = 0;
      for (;;) {
        try {
          res = await ai.models.embedContent({
            model: CONFIG.MODEL,
            contents: batch,
            config: {
              taskType,
              outputDimensionality: CONFIG.OUTPUT_DIMENSIONALITY,
            },
          });
          break;
        } catch (err) {
          if (err.status !== 429 || attempt >= CONFIG.MAX_RETRIES_ON_RATE_LIMIT) throw err;
          if (isDailyQuotaError(err)) {
            console.warn(
              '[embedding-provider] Gemini 429 (quota JOURNALIER, pas un simple palier de débit) — abandon immédiat, retenter demain plutôt que de gaspiller le reste du quota en tentatives vaines.'
            );
            throw err;
          }
          const delayMs = CONFIG.RETRY_BASE_DELAY_MS * 2 ** attempt;
          console.warn(
            `[embedding-provider] Gemini 429 (palier gratuit) — nouvelle tentative dans ${delayMs}ms (${attempt + 1}/${CONFIG.MAX_RETRIES_ON_RATE_LIMIT})`
          );
          await sleep(delayMs);
          attempt++;
        }
      }
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
    console.warn('[embedding-provider] Échec embedContent (Gemini):', err.message);
    return null;
  }
}

/**
 * Indique quel fournisseur SERAIT utilisé maintenant, sans faire d'appel
 * d'embedding réel — utilisé par scripts/generate-bible-embeddings.js pour
 * savoir quelle dimension configurer AVANT de créer le fichier d'index (les
 * deux fournisseurs produisent des espaces vectoriels incompatibles).
 * @returns {Promise<{provider: 'ollama'|'gemini'|null, dimension: number|null}>}
 */
async function getActiveProviderInfo() {
  if (await isOllamaAvailable()) {
    return { provider: 'ollama', dimension: OLLAMA_CONFIG.DIMENSION };
  }
  if (process.env.GEMINI_API_KEY) {
    return { provider: 'gemini', dimension: CONFIG.OUTPUT_DIMENSIONALITY };
  }
  return { provider: null, dimension: null };
}

/**
 * Génère un embedding par texte, dans l'ordre. Préfère Ollama (local, sans
 * clé ni quota) s'il répond ; sinon retombe sur Gemini si GEMINI_API_KEY est
 * défini. Renvoie null (jamais d'exception) si aucun des deux n'est
 * disponible ou si l'appel échoue.
 * @param {string[]} texts
 * @param {{ taskType?: string }} [options]
 * @returns {Promise<number[][]|null>}
 */
async function embedTexts(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  if (await isOllamaAvailable()) {
    try {
      return await embedTextsViaOllama(texts);
    } catch (err) {
      console.warn(
        '[embedding-provider] Échec embedContent (Ollama), repli sur Gemini si disponible :',
        err.message
      );
      // Continue vers Gemini plutôt que de renvoyer null tout de suite —
      // un Ollama momentanément instable ne doit pas priver d'un repli
      // fonctionnel s'il existe.
    }
  }

  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      '[embedding-provider] Ni Ollama (voir OLLAMA_BASE_URL) ni GEMINI_API_KEY — embeddings indisponibles.'
    );
    return null;
  }
  return embedTextsViaGemini(texts, options);
}

/**
 * Raccourci pour un seul texte de requête (taskType=RETRIEVAL_QUERY côté
 * Gemini — asymétrique par rapport à RETRIEVAL_DOCUMENT utilisé à
 * l'indexation, recommandation Google pour ce modèle ; ignoré côté Ollama,
 * bge-m3 ne distingue pas document/requête).
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embedQuery(text) {
  const result = await embedTexts([text], { taskType: 'RETRIEVAL_QUERY' });
  return result && result.length > 0 ? result[0] : null;
}

module.exports = {
  embedTexts,
  embedQuery,
  getActiveProviderInfo,
  isOllamaAvailable,
  CONFIG,
  OLLAMA_CONFIG,
};
