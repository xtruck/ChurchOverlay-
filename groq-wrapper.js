/**
 * ============================================================================
 *  groq-wrapper.js — Transcription cloud Groq (Whisper large-v3), fournisseur
 *  principal, avec course en parallèle à 3 niveaux : Groq → Deepgram → local
 * ----------------------------------------------------------------------------
 *  LOGIQUE RETENUE :
 *    - Le système ATTEND Groq avant d'afficher (précision > vitesse).
 *    - Groq, Deepgram (si configuré) et la transcription locale sont lancés
 *      EN PARALLÈLE dès la réception du segment audio (pas de perte de temps
 *      à attendre un timeout avant de démarrer les autres).
 *    - Si Groq ne répond pas dans les 5 secondes (ou échoue), on bascule sur
 *      Deepgram s'il a déjà répondu ou répond à temps ; sinon sur le résultat
 *      local déjà en cours/terminé. L'overlay n'est jamais vide, et perdre
 *      internet pendant le culte ne coupe jamais la transcription : le
 *      fallback local (whisper-wrapper.js) fonctionne hors ligne.
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
 * Lance Groq, Deepgram (si DEEPGRAM_API_KEY est configuré) et la
 * transcription locale EN PARALLÈLE pour un même segment audio, dès la
 * réception du segment — aucun des trois n'attend qu'un autre échoue avant
 * de démarrer.
 *
 * Ordre de préférence : Groq → Deepgram → local.
 *   1. On attend Groq jusqu'à timeoutMs.
 *   2. S'il n'a pas répondu (timeout) ou a échoué, on regarde Deepgram :
 *      s'il a déjà un résultat, on l'utilise immédiatement ; sinon on
 *      l'attend jusqu'au même timeoutMs (mesuré depuis le début, pas
 *      redémarré à zéro — Deepgram tourne depuis le début lui aussi).
 *   3. Si ni Groq ni Deepgram n'aboutissent à temps ou sans erreur, on
 *      bascule sur le résultat local (déjà en cours depuis le début) —
 *      c'est le filet de sécurité qui fonctionne même sans internet.
 *
 * @param {string} audioFilePath - chemin du segment audio
 * @param {(path: string) => Promise<{text: string}>} localTranscribeFn -
 *        typiquement whisper.transcribeFile
 * @param {number} [timeoutMs=FALLBACK_TIMEOUT_MS]
 * @returns {Promise<{ text: string, source: 'groq' | 'deepgram' | 'local' }>}
 */
async function transcribeWithFallback(audioFilePath, localTranscribeFn, timeoutMs = FALLBACK_TIMEOUT_MS) {
  const deepgramEnabled = deepgram.isConfigured();

  // Démarrer les trois (ou deux, si Deepgram n'est pas configuré) en
  // parallèle dès maintenant — aucun fallback ne perd de temps à attendre
  // un timeout avant de commencer son propre travail.
  const groqPromise = transcribeFile(audioFilePath).catch((err) => ({ error: err }));
  const deepgramPromise = deepgramEnabled
    ? deepgram.transcribeFile(audioFilePath).catch((err) => ({ error: err }))
    : Promise.resolve({ error: new Error('Deepgram non configuré') });
  const localPromise = Promise.resolve(localTranscribeFn(audioFilePath)).catch((err) => ({ error: err }));

  const startedAt = Date.now();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  // --- Étape 1 : attendre Groq (jusqu'à timeoutMs) -----------------------
  const groqRace = await Promise.race([groqPromise, timeoutPromise]);

  if (groqRace && !groqRace.timedOut && !groqRace.error) {
    return { text: groqRace.text, source: 'groq' };
  }
  if (groqRace && groqRace.timedOut) {
    console.warn('[groq-wrapper] Timeout Groq (%dms) — bascule sur Deepgram/local.', timeoutMs);
  } else if (groqRace && groqRace.error) {
    console.warn('[groq-wrapper] Échec Groq (%s) — bascule sur Deepgram/local.', groqRace.error.message);
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
      console.warn('[groq-wrapper] Timeout Deepgram — bascule sur local.');
    } else if (deepgramRace && deepgramRace.error) {
      console.warn('[groq-wrapper] Échec Deepgram (%s) — bascule sur local.', deepgramRace.error.message);
    }
  }

  // --- Étape 3 : local, filet de sécurité ultime (fonctionne hors ligne) -
  const localResult = await localPromise;
  if (localResult && localResult.error) {
    // Aucune des sources n'a abouti — on remonte l'erreur locale, c'est la
    // source qu'on considère "de secours ultime".
    throw localResult.error;
  }
  return { text: localResult.text || '', source: 'local' };
}

module.exports = { transcribeFile, transcribeWithFallback };
