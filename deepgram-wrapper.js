/**
 * ============================================================================
 *  deepgram-wrapper.js — Transcription cloud Deepgram (Nova-2), 2e fournisseur
 * ----------------------------------------------------------------------------
 *  Même forme de résultat que groq-wrapper.js (result.text), pour que
 *  server.js puisse traiter les deux sources de façon identique dans la
 *  course à 2 niveaux (Groq → Deepgram).
 *
 *  Paramètres optimisés pour environnements bruyants (lieux de culte, musique,
 *  écho) :
 *  - denoise=true : Suppression active du bruit ambiant.
 *  - filler_words=false : Élimination des bruits de remplissage vocaux.
 *  - Filtrage par seuil de confiance au niveau des mots (DEFAULT_WORD_CONFIDENCE_THRESHOLD).
 *
 *  Prérequis : DEEPGRAM_API_KEY doit être défini en variable d'environnement.
 * ============================================================================
 */

const fs = require('fs');
const { buildDeepgramKeywords } = require('./bible-keyterms');

const DEEPGRAM_ENDPOINT = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_PROJECTS_ENDPOINT = 'https://api.deepgram.com/v1/projects';
const DEEPGRAM_MODEL = 'nova-2';
const DEEPGRAM_LANGUAGE = 'fr';
const DEFAULT_WORD_CONFIDENCE_THRESHOLD = 0.4;
const CHECK_KEY_TIMEOUT_MS = 5000;

// Construit une fois au chargement du module (liste statique)
const KEYWORDS_PARAM = buildDeepgramKeywords();

/**
 * Indique si une clé Deepgram est configurée (utilisé par server.js).
 * @returns {boolean}
 */
function isConfigured() {
  return !!process.env.DEEPGRAM_API_KEY;
}

/**
 * Vérification légère de la validité de la clé Deepgram, sans frais de
 * transcription : liste les projets accessibles avec cette clé. Utilisé par
 * le bouton "Tester avant le culte" du tableau de bord (checklist mise en
 * production, point 9).
 * @returns {Promise<{configured: boolean, ok: boolean, error: string|null}>}
 */
async function checkKey(timeoutMs = CHECK_KEY_TIMEOUT_MS) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return { configured: false, ok: false, error: 'DEEPGRAM_API_KEY non défini (optionnel).' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(DEEPGRAM_PROJECTS_ENDPOINT, {
      headers: { Authorization: `Token ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return { configured: true, ok: false, error: `Deepgram a répondu ${response.status}` };
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
 * Envoie le fichier audio à l'API Deepgram et retourne { text, confidence }.
 * CORRECTIF (audit round 7) : `signal` optionnel — même correctif que
 * groq-wrapper.transcribeFile, pour permettre à transcribeWithFallback
 * d'annuler la requête Deepgram encore en vol si Groq répond entre-temps
 * (au lieu de la laisser tourner en arrière-plan pour rien).
 * @param {string} audioFilePath
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ text: string, confidence?: number }>}
 */
async function transcribeFile(audioFilePath, signal) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY non défini dans l'environnement.");
  }
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Fichier audio non trouvé: ${audioFilePath}`);
  }

  const audioBuffer = fs.readFileSync(audioFilePath);

  // Boosting vocabulaire biblique
  const keywordsQuery = KEYWORDS_PARAM.map((kw) => `keywords=${encodeURIComponent(kw)}`).join('&');

  // Paramètres optimisés pour la réduction de bruit de fond et la précision en milieu bruyant
  const queryParams = [
    `model=${DEEPGRAM_MODEL}`,
    `language=${DEEPGRAM_LANGUAGE}`,
    'smart_format=true',
    'denoise=true',
    'punctuate=true',
    'filler_words=false',
    'endpointing=300',
    keywordsQuery,
  ]
    .filter(Boolean)
    .join('&');

  const url = `${DEEPGRAM_ENDPOINT}?${queryParams}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/wav',
    },
    body: audioBuffer,
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Deepgram API a répondu ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const alternative =
    data &&
    data.results &&
    data.results.channels &&
    data.results.channels[0] &&
    data.results.channels[0].alternatives &&
    data.results.channels[0].alternatives[0];

  if (!alternative) {
    return { text: '', confidence: 0 };
  }

  const rawTranscript = alternative.transcript || '';
  const wordConfidenceThreshold =
    Number(process.env.DEEPGRAM_WORD_CONFIDENCE_THRESHOLD) || DEFAULT_WORD_CONFIDENCE_THRESHOLD;

  let text = rawTranscript;
  let overallConfidence = typeof alternative.confidence === 'number' ? alternative.confidence : 0;

  // Optimisation par seuil de confiance au niveau des mots
  if (Array.isArray(alternative.words) && alternative.words.length > 0) {
    const validWords = alternative.words.filter((w) => {
      if (typeof w.confidence === 'number') {
        return w.confidence >= wordConfidenceThreshold;
      }
      return true;
    });

    if (validWords.length > 0) {
      text = validWords
        .map((w) => w.punctuated_word || w.word || '')
        .join(' ')
        .trim();
      const totalConf = validWords.reduce(
        (sum, w) => sum + (typeof w.confidence === 'number' ? w.confidence : 1),
        0
      );
      overallConfidence = totalConf / validWords.length;
    } else {
      // Si aucun mot ne dépasse le seuil, il s'agit de bruit de fond parasite
      text = '';
      overallConfidence = 0;
    }
  }

  return { text, confidence: overallConfidence };
}

module.exports = { transcribeFile, isConfigured, checkKey, DEFAULT_WORD_CONFIDENCE_THRESHOLD };
