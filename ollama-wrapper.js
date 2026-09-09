'use strict';
/**
 * ============================================================================
 *  ollama-wrapper.js — Chat completion via Ollama local (DeepSeek/Qwen)
 * ----------------------------------------------------------------------------
 *  AJOUT (durcissement Sermon Q&A — résilience LLM). Même philosophie et
 *  mêmes conventions que embedding-provider.js#embedTextsViaOllama :
 *  Ollama tourne EN LOCAL (aucune clé, aucun quota, aucun coût), interrogé
 *  via son API HTTP (`/api/generate`, non-streaming). Un timeout court
 *  (AbortSignal.timeout, comme partout ailleurs dans ce dépôt — voir
 *  groq-wrapper.js#chatCompletion) signale "indisponible" plutôt que de
 *  bloquer l'appelant si le serveur local est absent ou surchargé.
 *
 *  Ce module ne fait JAMAIS de repli lui-même (contrairement à
 *  embedding-provider.js, qui bascule en interne vers Gemini) — c'est
 *  sermon-qa.js#chatCompletionResilient() qui décide de retomber sur
 *  groq-wrapper.js en cas d'échec ici, pour garder la politique de repli au
 *  niveau de l'appelant plutôt que dupliquée dans chaque wrapper fournisseur.
 * ============================================================================
 */

const OLLAMA_CONFIG = {
  BASE_URL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  // DeepSeek-R1/Qwen2.5 — modèles locaux courants pour du raisonnement en
  // français correct sans clé API ; surchargeable si un autre modèle est
  // déjà installé localement (voir OLLAMA_EMBED_MODEL dans
  // embedding-provider.js pour la même convention côté embeddings).
  MODEL: process.env.OLLAMA_CHAT_MODEL || 'qwen2.5',
  DEFAULT_TIMEOUT_MS: 5000,
};

/**
 * Vérifie qu'un serveur Ollama répond réellement — pas juste que l'URL est
 * configurée. Ne lève jamais (toute erreur réseau = indisponible).
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function isOllamaAvailable(timeoutMs = 1500) {
  try {
    const res = await fetch(`${OLLAMA_CONFIG.BASE_URL}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch (_err) {
    return false;
  }
}

/**
 * Appelle l'API Ollama /api/generate (chat non-streaming, une seule
 * complétion). Signature volontairement alignée sur
 * groq-wrapper.js#chatCompletion() ({text, model, usage}) pour rester
 * interchangeable côté appelant.
 * @param {string} prompt
 * @param {Object} [options]
 * @param {string} [options.model]
 * @param {number} [options.temperature=0.1]
 * @param {number} [options.max_tokens=500]
 * @param {number} [options.timeoutMs] - défaut OLLAMA_CONFIG.DEFAULT_TIMEOUT_MS (5s)
 * @returns {Promise<{text: string, model: string, usage: Object}>}
 */
async function chatCompletion(prompt, options = {}) {
  const {
    model = OLLAMA_CONFIG.MODEL,
    temperature = 0.1,
    max_tokens: maxTokens = 500,
    timeoutMs = OLLAMA_CONFIG.DEFAULT_TIMEOUT_MS,
  } = options;

  const res = await fetch(`${OLLAMA_CONFIG.BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Ollama a répondu ${res.status} : ${bodyText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.response || '').trim();
  if (!text) {
    throw new Error('Réponse Ollama vide.');
  }

  return { text, model, usage: {} };
}

module.exports = { chatCompletion, isOllamaAvailable, OLLAMA_CONFIG };
