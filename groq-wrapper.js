/**
 * ============================================================================
 * groq-wrapper.js — Transcription cloud Groq (Whisper large-v3), fournisseur
 * principal, avec repli en parallèle sur Deepgram (Nova-2) si configuré
 * + NOUVEAU : Chat Completion API pour les features IA (semantic detection,
 * transcription correction, theme generation)
 * ----------------------------------------------------------------------------
 * CHANGELOG v0.4.0 — Ajout Chat Completion
 * - chatCompletion() : appel à l'API Groq Chat Completions pour les
 *   features IA (semantic-detector.js, transcription-corrector.js,
 *   ai-theme-generator.js). Supporte json_mode, temperature, max_tokens.
 * - quickCompletion() : wrapper court pour les corrections rapides.
 * - Gestion unifiée des erreurs API (rate limit, timeout, clé invalide).
 * ============================================================================
 */

const fs = require('fs');
const deepgram = require('./deepgram-wrapper');
const { buildWhisperPrompt } = require('./bible-keyterms');

const GROQ_ENDPOINT_TRANSCRIBE = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_ENDPOINT_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL_TRANSCRIBE = 'whisper-large-v3';
const GROQ_MODEL_CHAT = 'llama-3.1-8b-instant';
const FALLBACK_TIMEOUT_MS = 5000;

const WHISPER_PROMPT = buildWhisperPrompt();

/**
 * Envoie le fichier audio à l'API Groq et retourne { text }.
 */
async function transcribeFile(audioFilePath) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY non défini dans l'environnement.");
  }
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Fichier audio non trouvé: ${audioFilePath}`);
  }

  const audioBuffer = fs.readFileSync(audioFilePath);
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), 'audio.wav');
  formData.append('model', GROQ_MODEL_TRANSCRIBE);
  formData.append('prompt', WHISPER_PROMPT);

  const response = await fetch(GROQ_ENDPOINT_TRANSCRIBE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Groq API a répondu ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return { text: data.text || '' };
}

/**
 * Lance Groq et Deepgram EN PARALLÈLE.
 */
async function transcribeWithFallback(audioFilePath, timeoutMs = FALLBACK_TIMEOUT_MS) {
  const deepgramEnabled = deepgram.isConfigured();

  const groqPromise = transcribeFile(audioFilePath).catch((err) => ({ error: err }));
  const deepgramPromise = deepgramEnabled
    ? deepgram.transcribeFile(audioFilePath).catch((err) => ({ error: err }))
    : Promise.resolve({ error: new Error('Deepgram non configuré') });

  const startedAt = Date.now();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const groqRace = await Promise.race([groqPromise, timeoutPromise]);

  if (groqRace && !groqRace.timedOut && !groqRace.error) {
    return { text: groqRace.text, source: 'groq' };
  }
  let groqError = null;
  if (groqRace && groqRace.timedOut) {
    groqError = new Error(`Timeout Groq (${timeoutMs}ms)`);
    console.warn('[groq-wrapper] Timeout Groq (%dms) — bascule sur Deepgram.', timeoutMs);
  } else if (groqRace && groqRace.error) {
    groqError = groqRace.error;
    console.warn('[groq-wrapper] Échec Groq (%s) — bascule sur Deepgram.', groqRace.error.message);
  }

  if (deepgramEnabled) {
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
    const deepgramTimeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), remainingMs);
    });
    const deepgramRace = await Promise.race([deepgramPromise, deepgramTimeoutPromise]);

    if (deepgramRace && !deepgramRace.timedOut && !deepgramRace.error) {
      return { text: deepgramRace.text, source: 'deepgram' };
    }
    if (deepgramRace && deepgramRace.timedOut) {
      console.warn('[groq-wrapper] Timeout Deepgram également — segment perdu.');
      throw groqError || new Error('Timeout Deepgram');
    }
    console.warn('[groq-wrapper] Échec Deepgram également (%s) — segment perdu.', deepgramRace.error.message);
    throw deepgramRace.error;
  }

  throw groqError || new Error('Échec de la transcription (Groq)');
}

// ============================================================================
// NOUVEAU : Chat Completion API (pour les features IA)
// ============================================================================

/**
 * Appelle l'API Groq Chat Completions.
 * @param {string} prompt - Le prompt utilisateur
 * @param {Object} options - Options
 * @param {string} [options.model='llama-3.1-8b-instant'] - Modèle
 * @param {number} [options.temperature=0.1] - Température
 * @param {number} [options.max_tokens=256] - Max tokens
 * @param {boolean} [options.json_mode=false] - Forcer JSON output
 * @param {number} [options.timeoutMs=8000] - Timeout
 * @returns {Promise<{text: string, model: string, usage: Object}>}
 */
async function chatCompletion(prompt, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY non défini dans l'environnement.");
  }

  const {
    model = GROQ_MODEL_CHAT,
    temperature = 0.1,
    max_tokens = 256,
    json_mode = false,
    timeoutMs = 8000,
  } = options;

  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant for a church sermon transcription system. Be concise and accurate.' },
      { role: 'user', content: prompt },
    ],
    temperature,
    max_tokens,
  };

  if (json_mode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(GROQ_ENDPOINT_CHAT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 429) {
        throw new Error('Rate limit Groq atteint — réessayez dans quelques secondes.');
      }
      throw new Error(`Groq Chat API a répondu ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      model: data.model,
      usage: data.usage || {},
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Timeout Groq Chat (${timeoutMs}ms)`);
    }
    throw err;
  }
}

/**
 * Wrapper court pour les corrections rapides (transcription-corrector.js).
 * @param {string} prompt
 * @param {Object} options
 * @returns {Promise<string>} - Le texte de réponse uniquement
 */
async function quickCompletion(prompt, options = {}) {
  const result = await chatCompletion(prompt, {
    temperature: 0.05,
    max_tokens: 500,
    timeoutMs: 5000,
    ...options,
  });
  return result.text;
}

module.exports = { transcribeFile, transcribeWithFallback, chatCompletion, quickCompletion };
