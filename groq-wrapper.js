/**
 * ============================================================================
 * groq-wrapper.js — Transcription cloud Groq (Whisper large-v3), fournisseur
 * principal, avec repli en parallèle sur Deepgram (Nova-2) si configuré
 * + Chat Completion API pour les features IA (Gemini 3.6 Flash / Groq)
 * ============================================================================
 */

const fs = require('fs');
const deepgram = require('./deepgram-wrapper');
const { buildWhisperPrompt } = require('./bible-keyterms');
const { GoogleGenAI } = require('@google/genai');

const GROQ_ENDPOINT_TRANSCRIBE = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_ENDPOINT_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_ENDPOINT_MODELS = 'https://api.groq.com/openai/v1/models';
// AJOUT (audit — reflexes plus rapides, gratuit) : Turbo transcrit à 216x
// temps réel (contre un débit bien plus faible pour le modèle large-v3
// complet) pour un coût par heure INFÉRIEUR sur le palier gratuit Groq — un
// strict gain, sans changement de code au-delà du nom de modèle. Écart de
// précision (~1% WER) négligeable pour un vocabulaire déjà biaisé par
// buildWhisperPrompt() (voir bible-keyterms.js).
const GROQ_MODEL_TRANSCRIBE = 'whisper-large-v3-turbo';
// CORRECTIF (audit — retour sur 8b-instant, contrainte "gratuit fiable") :
// llama-3.3-70b-versatile a été essayé pour un raisonnement plus fin, mais
// son palier gratuit (1 000 req/jour, 30 req/min) est PARTAGÉ par tous les
// appelants de chatCompletion() dans l'app (semantic-detector,
// transcription-corrector en mode smart, ai-enricher, ambient mood) — un
// seul culte peut dépasser ce quota et faire échouer l'IA en plein direct.
// 8b-instant (14 400 req/jour) reste le choix par défaut sûr ; voir
// ai-theme-generator.js et transcription-corrector.js, qui l'utilisaient
// déjà explicitement et n'ont jamais été changés.
const GROQ_MODEL_CHAT = 'llama-3.1-8b-instant';
const FALLBACK_TIMEOUT_MS = 5000;
const CHECK_KEY_TIMEOUT_MS = 5000;

const WHISPER_PROMPT = buildWhisperPrompt();

/**
 * Indique si une clé Groq est configurée (utilisé par server.js).
 * @returns {boolean}
 */
function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

/**
 * Vérification légère de la validité de la clé Groq, sans frais de
 * transcription : appelle la liste des modèles disponibles. Utilisé par le
 * bouton "Tester avant le culte" du tableau de bord (checklist mise en
 * production, point 9).
 * @returns {Promise<{configured: boolean, ok: boolean, error: string|null}>}
 */
async function checkKey(timeoutMs = CHECK_KEY_TIMEOUT_MS) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { configured: false, ok: false, error: 'GROQ_API_KEY non défini.' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(GROQ_ENDPOINT_MODELS, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return { configured: true, ok: false, error: `Groq a répondu ${response.status}` };
    }
    return { configured: true, ok: true, error: null };
  } catch (err) {
    clearTimeout(timeoutId);
    const message =
      err && err.name === 'AbortError'
        ? `Timeout (${timeoutMs}ms)`
        : (err && err.message) || 'Erreur inconnue';
    return { configured: true, ok: false, error: message };
  }
}

/**
 * Envoie le fichier audio à l'API Groq et retourne { text }.
 * CORRECTIF (audit round 7) : `signal` optionnel pour permettre l'annulation
 * — voir transcribeWithFallback ci-dessous, qui abandonnait auparavant la
 * requête fetch en arrière-plan (sans jamais l'annuler) dès que le budget de
 * 5s expirait et que le relais passait à Deepgram. Sur un service de
 * plusieurs heures avec un réseau instable, chaque segment en timeout
 * laissait une requête HTTP orpheline ouverte (parfois plusieurs minutes,
 * le temps du timeout TCP par défaut), accumulant des connexions inutiles.
 */
async function transcribeFile(audioFilePath, signal, contextHint) {
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
  // AJOUT (audit — boost transcription) : Whisper utilise `prompt` comme
  // contexte de décodage (biaise le vocabulaire, ne s'exécute pas comme une
  // instruction). En plus du vocabulaire biblique statique, on ajoute la fin
  // du segment précédent déjà transcrit/corrigé : ça donne au modèle la
  // continuité de la phrase en cours (noms propres déjà prononcés, sujet du
  // moment) au lieu de repartir à zéro toutes les ~5s. Whisper ne regarde que
  // les ~224 derniers tokens du prompt, donc on garde le total court.
  const prompt = contextHint
    ? `${WHISPER_PROMPT} Contexte récent : "${contextHint}"`.slice(-900)
    : WHISPER_PROMPT;
  formData.append('prompt', prompt);
  // AJOUT (audit — boost transcription) : verrouille la langue de décodage
  // Whisper si l'opérateur l'a explicitement configurée (TRANSCRIPTION_LANGUAGE
  // dans .env). Sans indice de langue, Whisper doit deviner à partir des
  // ~30 premières secondes de CHAQUE segment (les segments ici ne durent que
  // quelques secondes) — sur un segment court, bruité, ou qui commence par un
  // nom propre, la détection automatique se trompe parfois de langue et
  // transcrit phonétiquement dans la mauvaise langue. Deepgram (fournisseur
  // de repli, voir deepgram-wrapper.js) fixe déjà `language=fr` en dur pour
  // la même raison ; ici c'est opt-in pour ne pas casser les cultes bilingues
  // qui comptent sur la détection auto (voir detector-compat.js FR+EN).
  const language = process.env.TRANSCRIPTION_LANGUAGE;
  if (language) {
    formData.append('language', language);
  }

  const response = await fetch(GROQ_ENDPOINT_TRANSCRIBE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal,
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
async function transcribeWithFallback(audioFilePath, timeoutMs = FALLBACK_TIMEOUT_MS, contextHint) {
  const deepgramEnabled = deepgram.isConfigured();

  const groqAbort = new AbortController();
  const deepgramAbort = new AbortController();
  const groqPromise = transcribeFile(audioFilePath, groqAbort.signal, contextHint).catch((err) => ({
    error: err,
  }));
  const deepgramPromise = deepgramEnabled
    ? deepgram.transcribeFile(audioFilePath, deepgramAbort.signal).catch((err) => ({ error: err }))
    : Promise.resolve({ error: new Error('Deepgram non configuré') });

  const startedAt = Date.now();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const groqRace = await Promise.race([groqPromise, timeoutPromise]);

  if (groqRace && !groqRace.timedOut && !groqRace.error) {
    if (deepgramEnabled) deepgramAbort.abort();
    return { text: groqRace.text, source: 'groq' };
  }
  let groqError = null;
  if (groqRace && groqRace.timedOut) {
    groqAbort.abort();
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
    console.warn(
      '[groq-wrapper] Échec Deepgram également (%s) — segment perdu.',
      deepgramRace.error.message
    );
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
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  const {
    model = GROQ_MODEL_CHAT,
    temperature = 0.1,
    max_tokens = 256,
    json_mode = false,
    timeoutMs = 8000,
  } = options;

  // Try Google Gemini if key is provided
  if (geminiApiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const geminiModel = 'gemini-2.5-flash';
      const config = {
        temperature,
        maxOutputTokens: max_tokens,
      };
      if (json_mode) {
        config.responseMimeType = 'application/json';
      }
      const res = await ai.models.generateContent({
        model: geminiModel,
        contents: prompt,
        config,
      });
      return {
        text: res.text || '',
        model: geminiModel,
        usage: {},
      };
    } catch (geminiErr) {
      console.warn(
        '[ai-wrapper] Échec Gemini API (repli Groq):',
        geminiErr.status || geminiErr.message?.substring(0, 100)
      );
      if (!groqApiKey) {
        throw geminiErr;
      }
    }
  }

  if (!groqApiKey) {
    throw new Error("Ni GEMINI_API_KEY ni GROQ_API_KEY ne sont définis dans l'environnement.");
  }

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful assistant for a church sermon transcription system. Be concise and accurate.',
      },
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
        Authorization: `Bearer ${groqApiKey}`,
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
      throw new Error(`Timeout Groq Chat (${timeoutMs}ms)`, { cause: err });
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

module.exports = {
  transcribeFile,
  transcribeWithFallback,
  chatCompletion,
  quickCompletion,
  isConfigured,
  checkKey,
};
