/**
 * ============================================================================
 *  deepgram-wrapper.js — Transcription cloud Deepgram (Nova-2), 2e fournisseur
 * ----------------------------------------------------------------------------
 *  Même forme de résultat que groq-wrapper.js (result.text), pour que
 *  server.js puisse traiter les deux sources de façon identique dans la
 *  course à 2 niveaux (Groq → Deepgram).
 *
 *  Prérequis : DEEPGRAM_API_KEY doit être défini en variable d'environnement.
 *  Optionnel : si absent, ce module reste inerte (transcribeFile rejette
 *  immédiatement) — Deepgram est un fournisseur additionnel, pas obligatoire.
 *  Ne jamais coder la clé en dur ni la committer.
 * ============================================================================
 */

const fs = require('fs');

const DEEPGRAM_ENDPOINT = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = 'nova-2';
const DEEPGRAM_LANGUAGE = 'fr';

/**
 * Indique si une clé Deepgram est configurée (utilisé par server.js pour
 * savoir si ce fournisseur doit entrer dans la course en parallèle).
 * @returns {boolean}
 */
function isConfigured() {
  return !!process.env.DEEPGRAM_API_KEY;
}

/**
 * Envoie le fichier audio à l'API Deepgram et retourne { text }.
 * @param {string} audioFilePath
 * @returns {Promise<{ text: string }>}
 */
async function transcribeFile(audioFilePath) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPGRAM_API_KEY non défini dans l\'environnement.');
  }
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Fichier audio non trouvé: ${audioFilePath}`);
  }

  const audioBuffer = fs.readFileSync(audioFilePath);
  const url = `${DEEPGRAM_ENDPOINT}?model=${DEEPGRAM_MODEL}&language=${DEEPGRAM_LANGUAGE}&smart_format=true`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/wav',
    },
    body: audioBuffer,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Deepgram API a répondu ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data
    && data.results
    && data.results.channels
    && data.results.channels[0]
    && data.results.channels[0].alternatives
    && data.results.channels[0].alternatives[0]
    && data.results.channels[0].alternatives[0].transcript
    || '';

  return { text };
}

module.exports = { transcribeFile, isConfigured };
