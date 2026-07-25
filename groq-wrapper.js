/**
 * ============================================================================
 *  groq-wrapper.js — Transcription cloud Groq (Whisper large-v3), fournisseur
 *  principal, avec repli en parallèle sur Deepgram (Nova-2) si configuré
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.3.0 — Suppression du 3e niveau (Whisper local)
 *    whisper-server.exe était le plus gros consommateur CPU de l'app
 *    (~40-70% d'un cœur en continu). Il a été retiré entièrement du
 *    projet : plus de filet de secours hors-ligne. Sans internet (ou si
 *    Groq ET Deepgram échouent/expirent), la transcription du segment
 *    échoue et server.js diffuse un événement transcriptionError —
 *    l'overlay reste affiché, seule la détection auto s'interrompt tant
 *    que la connexion n'est pas rétablie.
 *
 *  LOGIQUE RETENUE :
 *    - Le système ATTEND Groq avant d'afficher (précision > vitesse).
 *    - Groq et Deepgram (si configuré) sont lancés EN PARALLÈLE dès la
 *      réception du segment audio (pas de perte de temps à attendre un
 *      timeout avant de démarrer l'autre).
 *    - Si Groq ne répond pas dans les 5 secondes (ou échoue), on bascule
 *      sur Deepgram s'il a déjà répondu ou répond à temps.
 *
 *  Prérequis : GROQ_API_KEY doit être défini en variable d'environnement.
 *  Ne jamais coder la clé en dur ni la committer.
 * ============================================================================
 */

const fs = require('fs');
const deepgram = require('./deepgram-wrapper');

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
 * Lance Groq et Deepgram (si DEEPGRAM_API_KEY est configuré) EN PARALLÈLE
 * pour un même segment audio, dès la réception du segment — Deepgram
 * n'attend pas que Groq échoue avant de démarrer son propre travail.
 *
 * Ordre de préférence : Groq → Deepgram.
 *   1. On attend Groq jusqu'à timeoutMs.
 *   2. S'il n'a pas répondu (timeout) ou a échoué, on regarde Deepgram :
 *      s'il a déjà un résultat, on l'utilise immédiatement ; sinon on
 *      l'attend jusqu'au même timeoutMs (mesuré depuis le début, pas
 *      redémarré à zéro — Deepgram tourne depuis le début lui aussi).
 *   3. Si ni Groq ni Deepgram n'aboutissent (pas de clé Deepgram, panne,
 *      pas d'internet), l'erreur Groq (ou Deepgram si Groq a réussi à
 *      répondre avec une erreur non-réseau) remonte à l'appelant, qui
 *      diffuse un événement transcriptionError — sans filet de secours
 *      hors-ligne (Whisper local a été retiré, voir CHANGELOG v0.3.0).
 *
 * @param {string} audioFilePath - chemin du segment audio
 * @param {number} [timeoutMs=FALLBACK_TIMEOUT_MS]
 * @returns {Promise<{ text: string, source: 'groq' | 'deepgram' }>}
 */
async function transcribeWithFallback(audioFilePath, timeoutMs = FALLBACK_TIMEOUT_MS) {
  const deepgramEnabled = deepgram.isConfigured();

  // Démarrer les deux (ou un seul, si Deepgram n'est pas configuré) en
  // parallèle dès maintenant.
  const groqPromise = transcribeFile(audioFilePath).catch((err) => ({ error: err }));
  const deepgramPromise = deepgramEnabled
    ? deepgram.transcribeFile(audioFilePath).catch((err) => ({ error: err }))
    : Promise.resolve({ error: new Error('Deepgram non configuré') });

  const startedAt = Date.now();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  // --- Étape 1 : attendre Groq (jusqu'à timeoutMs) -----------------------
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

  // --- Étape 2 : Deepgram, s'il est configuré -----------------------------
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

  // Ni Groq ni Deepgram (non configuré) n'ont abouti.
  throw groqError || new Error('Échec de la transcription (Groq)');
}

module.exports = { transcribeFile, transcribeWithFallback };
