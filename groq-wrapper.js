/**
 * ============================================================================
 * groq-wrapper.js — Transcription cloud Groq (Whisper large-v3), fournisseur
 * principal, avec repli en parallèle sur Deepgram (Nova-2) si configuré
 * + Chat Completion API pour les features IA (Gemini 3.6 Flash / Groq)
 * ----------------------------------------------------------------------------
 * PRINCIPE DIRECTEUR (cahier des charges — Point 5, "outil d'affichage,
 * jamais de génération théologique") : ce fichier est le SEUL point de
 * passage de tout appel LLM dans l'app (chatCompletion()/quickCompletion()
 * ci-dessous) — l'endroit naturel où écrire cette règle une fois plutôt que
 * de compter sur chaque appelant pour s'en souvenir.
 *
 *   1. Le TEXTE BIBLIQUE affiché sur l'overlay ne doit JAMAIS provenir d'un
 *      appel à ce fichier. Il vient uniquement de bible-lookup-with-api.js
 *      (fournisseurs réels helloao/getbible) ou de bible-offline-cache.js
 *      (même contenu, mis en cache) — jamais généré, paraphrasé, résumé ou
 *      "complété" par un modèle génératif, aussi tentant que ce soit pour
 *      combler un trou de traduction ou reformuler plus clairement.
 *   2. Toute fonctionnalité IA qui SYNTHÉTISE du texte à partir de ce
 *      fichier (résumés de prédication, assistant de questions/réponses —
 *      voir sermon-qa.js) doit rester un outil clairement identifié et
 *      SÉPARÉ de l'affichage des versets — jamais mélangé au même flux
 *      d'affichage public, et par défaut réservé à l'opérateur (jamais
 *      exposé sur companion.html/overlay.html sans une décision explicite).
 *   3. Concrètement pour sermon-qa.js : ne jamais appeler chatCompletion()
 *      "à vide" — seulement une fois qu'une recherche par mots-clés a déjà
 *      trouvé un contenu de prédication pertinent à citer. Sans contenu
 *      pertinent trouvé, répondre "aucun contenu correspondant" plutôt que
 *      de laisser le modèle répondre sans source réelle à citer.
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
// CORRECTIF (2026-08-07 — dépréciation Groq confirmée via console.groq.com/docs/deprecations) :
// llama-3.1-8b-instant est officiellement décommissionné le 16 août 2026
// (email Groq du 17 juin 2026) ; les requêtes échoueront après cette date.
// Remplacé par openai/gpt-oss-20b, la migration RECOMMANDÉE PAR GROQ
// lui-même pour ce modèle.
//
// ATTENTION — ce changement N'ÉLIMINE PAS le risque de quota partagé qui
// avait fait revenir ce projet sur 8b-instant après un essai de
// llama-3.3-70b-versatile (voir historique) : openai/gpt-oss-20b n'a QUE
// 1 000 req/jour en gratuit (30 req/min), contre 14 400/jour pour
// l'ancien 8b-instant. Vérifié le 2026-08-07 : sur le palier gratuit
// Groq actuel, TOUS les modèles de chat généralistes sont désormais à
// 1 000 req/jour (llama-3.3-70b-versatile, openai/gpt-oss-120b,
// openai/gpt-oss-20b, qwen/qwen3.6-27b...) — 8b-instant était le SEUL à
// 14 400/jour, et il disparaît. Il n'existe donc plus d'option gratuite
// Groq à quota élevé pour chatCompletion() (semantic-detector,
// transcription-corrector mode smart, ai-enricher, ambient mood — tous
// partagent ce même quota). Pour un culte long avec beaucoup d'appels IA,
// configurer GEMINI_API_KEY (déjà prioritaire sur Groq dans
// chatCompletion() ci-dessous) reste la meilleure protection contre ce
// nouveau plafond bas.
const GROQ_MODEL_CHAT = 'openai/gpt-oss-20b';
const FALLBACK_TIMEOUT_MS = 5000;
const CHECK_KEY_TIMEOUT_MS = 5000;

const WHISPER_PROMPT = buildWhisperPrompt();

// CORRECTIF (2026-08-07 — cause racine de "Groq muet, tout part sur Deepgram") :
// l'API Groq rejette le paramètre `prompt` de transcription au-delà de 896
// caractères ("prompt length must be 896 characters or fewer"), mais cette
// limite est en réalité mesurée en OCTETS UTF-8, pas en caractères JS —
// chaque lettre accentuée du vocabulaire biblique français (é, è, à, ç...)
// coûte 2 octets UTF-8 pour 1 seule unité de .length JS. L'ancien code
// tronquait avec `.slice(-900)` (900 CARACTÈRES JS, déjà au-dessus de 896),
// ce qui produisait couramment 920-950+ OCTETS réels une fois le texte
// plein d'accents pris en compte — 100% des requêtes de transcription avec
// contexte échouaient donc en 400, et WHISPER_PROMPT seul (sans contexte)
// pèse déjà 1051 octets, donc même les requêtes SANS contexte échouaient
// aussi (l'ancienne branche `else` ne tronquait pas du tout). Résultat
// observé : Deepgram (fallback) transcrivait 100% des segments, Groq ne
// répondait jamais avec succès.
const GROQ_PROMPT_MAX_BYTES = 896;

/**
 * Tronque une chaîne pour tenir dans maxBytes une fois encodée en UTF-8, en
 * conservant la FIN du texte (le contexte récent, plus utile au modèle que
 * le vocabulaire statique en tête de prompt — même logique que l'ancien
 * `.slice(-900)`, mais mesurée en octets réels au lieu de caractères JS).
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToUtf8ByteLimit(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // Avance jusqu'au début d'un caractère UTF-8 valide : un octet de
  // continuation multi-octet (forme binaire 10xxxxxx) coupé au milieu
  // produirait sinon un caractère de remplacement (�) en tête du prompt.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.slice(start).toString('utf8');
}

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
async function transcribeFile(audioFilePath, signal, contextHint, language) {
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
  const rawPrompt = contextHint
    ? `${WHISPER_PROMPT} Contexte récent : "${contextHint}"`
    : WHISPER_PROMPT;
  const prompt = truncateToUtf8ByteLimit(rawPrompt, GROQ_PROMPT_MAX_BYTES);
  formData.append('prompt', prompt);
  // AJOUT (audit — boost transcription ; étendu lot 4 du chantier bilingue
  // FR/EN) : verrouille la langue de décodage Whisper. Priorité : la
  // langue de SESSION (réglée en direct via la commande vocale "écoute en
  // français"/"listen in English", voir session-state.js >
  // transcriptionLanguage) prime sur TRANSCRIPTION_LANGUAGE (.env, réglage
  // fixe au démarrage) — sinon comportement inchangé : sans aucun des deux,
  // Whisper devine à partir des ~30 premières secondes de CHAQUE segment
  // (les segments ici ne durent que quelques secondes), ce qui se trompe
  // parfois de langue sur un segment court/bruité/commençant par un nom
  // propre. Deepgram (fournisseur de repli) fixe encore `language=fr` en
  // dur pour la même raison à ce lot (branché au lot 5).
  const resolvedLanguage = language || process.env.TRANSCRIPTION_LANGUAGE;
  if (resolvedLanguage) {
    formData.append('language', resolvedLanguage);
  }
  // AJOUT (rejet des segments inintelligibles — bruit, voix couverte,
  // glossolalie) : `json` (le défaut) ne renvoie que le texte, aucun signal
  // de confiance. `verbose_json` (même API OpenAI-compatible) ajoute
  // `segments[]` avec `avg_logprob`/`no_speech_prob` par segment — voir
  // computeGroqSpeechInfo() plus bas, seule consommatrice de ce champ.
  formData.append('response_format', 'verbose_json');

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
  return computeGroqSpeechInfo(data);
}

// AJOUT (rejet des segments inintelligibles) : seuil repris tel quel du
// décodeur Whisper d'OpenAI (decode.py, DecodingOptions par défaut) —
// un segment est considéré "silence/non-parole" quand no_speech_prob
// dépasse 0.6 ET que la confiance dérivée de avg_logprob reste sous
// exp(-1.0) (≈0.37). Combinaison, pas fusion en un seul score : un
// no_speech_prob élevé isolé ne suffit pas (peut arriver sur un segment
// court mais net), un avg_logprob faible isolé non plus (peut arriver sur
// un nom propre rare mais réel) — voir DEFAULT_TRANSCRIPTION_CONFIDENCE_THRESHOLD
// dans server.js pour le rejet "parole réelle mais confiance faible",
// une décision distincte de celle-ci ("probablement pas de la parole").
const NO_SPEECH_PROB_THRESHOLD = 0.6;
const NO_SPEECH_LOGPROB_CEILING = Math.exp(-1.0); // ≈0.37

/**
 * Dérive { text, confidence } à partir d'une réponse Groq verbose_json.
 * confidence est exp(avg_logprob) pondéré par la durée de chaque segment —
 * technique standard pour convertir une log-probabilité Whisper en un score
 * comparable (même échelle 0-1) à la confidence native de Deepgram (voir
 * deepgram-wrapper.js). Ne lève jamais d'exception : une forme de réponse
 * inattendue (segments absents) retombe sur confidence: undefined, jamais
 * bloquant pour l'appelant (voir le garde `typeof confidence === 'number'`
 * dans server.js).
 * @param {{text?: string, segments?: Array}} data
 * @returns {{text: string, confidence?: number}}
 */
function computeGroqSpeechInfo(data) {
  const segments = Array.isArray(data && data.segments) ? data.segments : null;
  if (!segments || segments.length === 0) {
    return { text: (data && data.text) || '', confidence: undefined };
  }

  let logprobSum = 0;
  let weightSum = 0;
  let maxNoSpeech = 0;
  for (const seg of segments) {
    const dur =
      typeof seg.end === 'number' && typeof seg.start === 'number' && seg.end > seg.start
        ? seg.end - seg.start
        : 1;
    logprobSum += (typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0) * dur;
    weightSum += dur;
    if (typeof seg.no_speech_prob === 'number') {
      maxNoSpeech = Math.max(maxNoSpeech, seg.no_speech_prob);
    }
  }
  const confidence = Math.exp(weightSum > 0 ? logprobSum / weightSum : 0);
  const isSilence =
    maxNoSpeech > NO_SPEECH_PROB_THRESHOLD && confidence < NO_SPEECH_LOGPROB_CEILING;
  return isSilence ? { text: '', confidence: 0 } : { text: data.text || '', confidence };
}

// AJOUT (Chantier 2 — fiabilité, visibilité des pannes silencieuses) : la
// course Groq/Deepgram (voir transcribeWithFallback ci-dessous) masque
// délibérément un échec Groq isolé — Deepgram prend le relais, la
// transcription globale réussit quand même, `consecutiveTranscriptionFailures`
// (server.js) ne s'incrémente donc JAMAIS pour un Groq cassé tant que
// Deepgram tient. Compteur SÉPARÉ, purement passif (aucun appel réseau
// dédié — ne fait qu'observer les tentatives déjà déclenchées par le
// pipeline réel), pour que /api/health puisse signaler "Groq répond
// systématiquement en échec" même quand la transcription elle-même ne
// s'en trouve jamais interrompue. Trouvé en conditions réelles pendant le
// Chantier 0.1 : GROQ_API_KEY invalide en silence (401 sur /v1/models ET
// /v1/chat/completions), tout le service tournait déjà sur le seul repli
// Deepgram sans qu'aucun signal ne le rende visible.
let consecutiveGroqFailures = 0;
let lastGroqError = null;

// AJOUT (§6b.1 — circuit breaker, pas seulement un repli) : test-groq-
// fallback-race.js/transcribeWithFallback() essaie déjà Groq à CHAQUE
// segment avant de basculer sur Deepgram, même si Groq échoue en boucle
// depuis le début du culte — un vrai timeout réseau (pas une erreur HTTP
// immédiate) coûte jusqu'à FALLBACK_TIMEOUT_MS (5000 ms) de latence
// supplémentaire par segment pendant toute la panne. Seuil à 5 (pas 3,
// contrairement au seuil de "signal fiable" de buildHealthReport() dans
// server.js) : DÉLIBÉRÉMENT au-dessus des 3 échecs + 1 succès exercés par
// test-groq-health-tracking.js, pour ne rien changer à ce contrat déjà
// testé — seule une panne VRAIMENT prolongée (5+ segments consécutifs, pas
// un aléa réseau isolé) ouvre le circuit. Après COOLDOWN_MS, un essai
// "semi-ouvert" retente Groq une fois ; un succès referme le circuit
// (compteur remis à 0, comme un succès normal), un nouvel échec relance le
// cooldown.
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30000;
let circuitOpenedAt = null;

function isCircuitOpen() {
  if (consecutiveGroqFailures < CIRCUIT_FAILURE_THRESHOLD || circuitOpenedAt === null) {
    return false;
  }
  return Date.now() - circuitOpenedAt < CIRCUIT_COOLDOWN_MS;
}

/**
 * @returns {{ consecutiveFailures: number, lastError: string|null, circuitOpen: boolean, circuitOpenedAt: number|null }}
 */
function getGroqHealthState() {
  return {
    consecutiveFailures: consecutiveGroqFailures,
    lastError: lastGroqError,
    circuitOpen: isCircuitOpen(),
    circuitOpenedAt,
  };
}

/**
 * Lance Groq et Deepgram EN PARALLÈLE — sauf circuit ouvert (voir
 * isCircuitOpen()) ET Deepgram disponible, auquel cas Groq est sauté
 * entièrement pour ce segment (repli direct sur Deepgram, sans attendre
 * FALLBACK_TIMEOUT_MS). Jamais sauté si Deepgram n'est pas configuré : sans
 * lui, retenter Groq reste la seule chance de transcrire, même faible.
 */
async function transcribeWithFallback(
  audioFilePath,
  timeoutMs = FALLBACK_TIMEOUT_MS,
  contextHint,
  language
) {
  const deepgramEnabled = deepgram.isConfigured();

  if (isCircuitOpen() && deepgramEnabled) {
    console.warn(
      '[groq-wrapper] Circuit Groq ouvert (%d échecs consécutifs) — repli Deepgram direct, Groq sauté.',
      consecutiveGroqFailures
    );
    try {
      const result = await deepgram.transcribeFile(
        audioFilePath,
        new AbortController().signal,
        language
      );
      return { text: result.text, confidence: result.confidence, source: 'deepgram' };
    } catch (err) {
      throw lastGroqError ? new Error(lastGroqError) : err;
    }
  }

  const groqAbort = new AbortController();
  const deepgramAbort = new AbortController();
  const groqPromise = transcribeFile(audioFilePath, groqAbort.signal, contextHint, language)
    .then((result) => {
      consecutiveGroqFailures = 0;
      lastGroqError = null;
      circuitOpenedAt = null;
      return result;
    })
    .catch((err) => {
      consecutiveGroqFailures++;
      lastGroqError = err.message;
      if (consecutiveGroqFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        circuitOpenedAt = Date.now();
      }
      return { error: err };
    });
  const deepgramPromise = deepgramEnabled
    ? deepgram
        .transcribeFile(audioFilePath, deepgramAbort.signal, language)
        .catch((err) => ({ error: err }))
    : Promise.resolve({ error: new Error('Deepgram non configuré') });

  const startedAt = Date.now();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const groqRace = await Promise.race([groqPromise, timeoutPromise]);

  if (groqRace && !groqRace.timedOut && !groqRace.error) {
    if (deepgramEnabled) deepgramAbort.abort();
    return { text: groqRace.text, confidence: groqRace.confidence, source: 'groq' };
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
      return { text: deepgramRace.text, confidence: deepgramRace.confidence, source: 'deepgram' };
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
  // AJOUT (Chantier 2 — santé) : voir buildHealthReport() dans server.js.
  getGroqHealthState,
  // Exposée pour tests unitaires (test-groq-prompt-truncation.js).
  truncateToUtf8ByteLimit,
  GROQ_PROMPT_MAX_BYTES,
  // Exposée pour tests unitaires (test-groq-speech-info.js).
  computeGroqSpeechInfo,
};
