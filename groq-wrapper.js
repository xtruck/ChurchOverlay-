/**
 * ============================================================================
 *  groq-wrapper.js — Transcription cloud Groq (Whisper large-v3) avec
 *  fallback automatique sur la transcription locale whisper-wrapper.js
 * ----------------------------------------------------------------------------
 *  LOGIQUE RETENUE :
 *    - Le système ATTEND Groq avant d'afficher (précision > vitesse).
 *    - Groq et la transcription locale sont lancés EN PARALLÈLE dès la
 *      réception du segment audio (pas de perte de temps à attendre le
 *      timeout avant de démarrer le fallback local).
 *    - Si Groq ne répond pas dans les 5 secondes (ou échoue), on utilise
 *      le résultat local déjà en cours/terminé — l'overlay n'est jamais vide.
 *
 *  Prérequis : GROQ_API_KEY doit être défini en variable d'environnement.
 *  Ne jamais coder la clé en dur ni la committer.
 * ============================================================================
 */

const fs = require('fs');

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3';
const FALLBACK_TIMEOUT_MS = 5000; // 5 secondes, choisi comme équilibre

/**
 * Envoie le fichier audio à l'API Groq et retourne { text }.
 * Même forme de résultat que whisper-wrapper.js (result.text), pour que
 * server.js puisse traiter les deux sources de façon identique.
 * @param {string} audioFilePath
 * @returns {Promise<{ text: string }>}
 */
async function transcribeFile(audioFilePath) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY non défini dans l\'environnement.');
  }
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Fichier audio non trouvé: ${audioFilePath}`);
  }

  const audioBuffer = fs.readFileSync(audioFilePath);
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), 'audio.wav');
  formData.append('model', GROQ_MODEL);

  const response = await fetch(GROQ_ENDPOINT, {
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
 * Lance Groq et la transcription locale EN PARALLÈLE pour un même segment
 * audio, attend Groq jusqu'à timeoutMs, et bascule sur le résultat local
 * si Groq n'a pas répondu (ou a échoué) à ce moment-là.
 *
 * @param {string} audioFilePath - chemin du segment audio
 * @param {(path: string) => Promise<{text: string}>} localTranscribeFn -
 *        typiquement whisper.transcribeFile
 * @param {number} [timeoutMs=FALLBACK_TIMEOUT_MS]
 * @returns {Promise<{ text: string, source: 'groq' | 'local' }>}
 */
async function transcribeWithFallback(audioFilePath, localTranscribeFn, timeoutMs = FALLBACK_TIMEOUT_MS) {
  // Démarrer les deux en parallèle dès maintenant — le fallback ne perd
  // aucun temps à attendre le timeout avant de commencer.
  const groqPromise = transcribeFile(audioFilePath).catch((err) => ({ error: err }));
  const localPromise = Promise.resolve(localTranscribeFn(audioFilePath)).catch((err) => ({ error: err }));

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const raceResult = await Promise.race([groqPromise, timeoutPromise]);

  if (raceResult && raceResult.timedOut) {
    console.warn('[groq-wrapper] Timeout Groq (%dms) — fallback local.', timeoutMs);
  } else if (raceResult && raceResult.error) {
    console.warn('[groq-wrapper] Échec Groq (%s) — fallback local.', raceResult.error.message);
  } else {
    // Groq a répondu à temps et sans erreur
    return { text: raceResult.text, source: 'groq' };
  }

  // On attend ici le résultat local, déjà en cours depuis le début
  const localResult = await localPromise;
  if (localResult && localResult.error) {
    // Ni Groq ni le local n'ont abouti — on remonte l'erreur locale,
    // c'est la source qu'on considère "de secours ultime".
    throw localResult.error;
  }
  return { text: localResult.text || '', source: 'local' };
}

module.exports = { transcribeFile, transcribeWithFallback };
