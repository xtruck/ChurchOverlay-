'use strict';
/**
 * ============================================================================
 *  asr-engine.js — Interface ASR unifiée
 * ----------------------------------------------------------------------------
 *  server.js appelait directement groq-wrapper.transcribeWithFallback() —
 *  couplage direct à un fournisseur précis. Ce module l'encapsule derrière
 *  une interface unique pour que server.js n'ait plus jamais à savoir quel
 *  moteur répond, seulement { text, isFinal, confidence, timestamp, engine }.
 *
 *  PROVIDERS (ASR_PROVIDER, voir .env.example) :
 *    - 'auto' (défaut, AUCUN changement de comportement pour les
 *      déploiements existants) : groq-wrapper.transcribeWithFallback() tel
 *      quel — Groq et Deepgram lancés en parallèle, premier qui répond gagne,
 *      Deepgram en repli si Groq échoue/timeout. C'est l'algorithme déjà
 *      testé (voir test-groq-fallback-race.js) — ce module ne le réécrit
 *      pas, il l'enveloppe.
 *    - 'groq' : force Groq seul (pas de repli Deepgram).
 *    - 'deepgram' : force Deepgram seul (batch — voir deepgram-wrapper.js).
 *    - 'qwen-local' : RÉSERVÉ, PAS IMPLÉMENTÉ dans cet environnement — voir
 *      getStatus(). Le seul chemin réaliste pour un exécutable Windows sans
 *      Python (cohérent avec le choix déjà fait par ce projet en v0.3.0 de
 *      retirer Whisper local pour garder un installeur léger, voir
 *      README.md) est l'implémentation C d'antirez/qwen-asr (zéro
 *      dépendance hors libc), qui nécessite un compilateur C/C++ pour être
 *      construite — AUCUN (cl.exe/MSVC, gcc/MinGW, cmake) n'a été trouvé
 *      dans cet environnement de développement (vérifié via `where`,
 *      pas supposé). L'alternative (pile Python/PyTorch/transformers
 *      officielle, plusieurs Go) inverserait ce choix architectural
 *      existant sans pouvoir être vérifiée ici — voir §40 du cahier des
 *      charges ("éviter une solution qui fonctionne seulement dans
 *      l'environnement de développement"). Ce provider existe donc comme
 *      EMPLACEMENT RÉSERVÉ : le jour où l'un des deux chemins est confirmé
 *      viable sur un poste Windows cible, l'implémentation vient ici sans
 *      toucher server.js (déjà découplé par cette interface).
 * ============================================================================
 */

const groq = require('./groq-wrapper');
const deepgram = require('./deepgram-wrapper');
// AJOUT (support bilingue FR/EN, lot 4) : session-state.js n'a aucune
// dépendance réseau/IO ni vers le reste de l'app (voir son en-tête) —
// aucun risque de dépendance circulaire à le requérir ici.
const sessionState = require('./session-state');

const VALID_PROVIDERS = ['auto', 'groq', 'deepgram', 'qwen-local'];

/** @returns {string} un provider de VALID_PROVIDERS — 'auto' si non réglé ou invalide. */
function resolveProvider() {
  const raw = (process.env.ASR_PROVIDER || 'auto').toLowerCase();
  return VALID_PROVIDERS.includes(raw) ? raw : 'auto';
}

/**
 * Transcrit UN segment déjà écrit sur disque (WAV) — la même unité de
 * travail que server.js utilise déjà (voir transcribeWithRetry). Une
 * interface par chunk PCM streaming (processAudioChunk/flush, voir §9 du
 * cahier des charges) n'a de sens que pour un provider qui accepte
 * réellement un flux continu (Deepgram en mode streaming — voir
 * deepgram-streaming.js, pas encore branché ici par défaut, voir le
 * rapport livré) ; Groq et Deepgram batch restent, eux, par segment.
 * @param {string} segmentFile - chemin du fichier WAV du segment
 * @param {string} [contextHint] - fin de la transcription précédente (contexte Whisper)
 * @param {AbortSignal} [signal]
 * @returns {Promise<{text: string, isFinal: boolean, confidence?: number, timestamp: number, engine: string}>}
 */
async function transcribeSegment(segmentFile, contextHint, signal) {
  const provider = resolveProvider();
  const timestamp = Date.now();
  // AJOUT (support bilingue FR/EN, lot 4) : lu ICI (pas dans groq-wrapper.js
  // directement) pour que ce module reste le seul endroit où server.js/
  // audio-capture.js ont besoin de savoir que la langue de session existe —
  // groq-wrapper.js continue de n'accepter qu'un paramètre nu, sans jamais
  // lire sessionState lui-même. null si l'opérateur n'a pas explicitement
  // changé la langue de transcription (voir session-state.js) : dans ce
  // cas, groq-wrapper.js retombe sur TRANSCRIPTION_LANGUAGE (.env) ou la
  // détection automatique Whisper — comportement actuel intégralement
  // préservé.
  const language = sessionState.getTranscriptionLanguage();
  // AJOUT (phase de vérification runtime — voir le rapport livré) : trace
  // grep-able, par segment, du chemin RÉELLEMENT emprunté (batch WAV, pas
  // streaming — voir audio-capture.js pour le tag [ASR] équivalent côté
  // streaming). 'auto' résout ici vers groq/deepgram selon
  // groq.transcribeWithFallback() ; le provider réel n'est connu qu'après
  // coup (voir engine dans le résultat retourné plus bas), donc ce log
  // affiche 'auto' tel quel pour ce cas — cohérent avec resolveProvider().
  console.log(`[ASR] provider=${provider} mode=batch language=${language || '(auto)'}`);

  if (provider === 'qwen-local') {
    const status = getStatus();
    throw new Error(
      `ASR_PROVIDER=qwen-local demandé mais indisponible : ${status.providers['qwen-local'].reason}`
    );
  }

  if (provider === 'groq') {
    const result = await groq.transcribeFile(segmentFile, signal, contextHint, language);
    return {
      text: result.text,
      isFinal: true,
      confidence: result.confidence,
      timestamp,
      engine: 'groq',
    };
  }

  if (provider === 'deepgram') {
    if (!deepgram.isConfigured()) {
      throw new Error('ASR_PROVIDER=deepgram mais DEEPGRAM_API_KEY non défini.');
    }
    const result = await deepgram.transcribeFile(segmentFile, signal, language);
    return {
      text: result.text,
      isFinal: true,
      confidence: result.confidence,
      timestamp,
      engine: 'deepgram',
    };
  }

  // 'auto' — comportement historique de groq-wrapper.transcribeWithFallback(),
  // volontairement INCHANGÉ pour tout le reste (voir en-tête du fichier) ;
  // seul le paramètre de langue est nouveau ici (lot 4).
  const result = await groq.transcribeWithFallback(segmentFile, undefined, contextHint, language);
  return {
    text: result.text,
    isFinal: true,
    confidence: result.confidence,
    timestamp,
    engine: result.source,
  };
}

/**
 * État de chaque provider connu — sert au panneau de diagnostic (§25 :
 * "health status" par composant) et à expliquer clairement POURQUOI
 * qwen-local échoue plutôt que de laisser une erreur générique.
 * @returns {{ activeProvider: string, providers: Object }}
 */
function getStatus() {
  return {
    activeProvider: resolveProvider(),
    providers: {
      groq: {
        available: !!process.env.GROQ_API_KEY,
        reason: process.env.GROQ_API_KEY ? null : 'GROQ_API_KEY non défini.',
      },
      deepgram: {
        available: deepgram.isConfigured(),
        reason: deepgram.isConfigured() ? null : 'DEEPGRAM_API_KEY non défini (optionnel).',
      },
      'qwen-local': {
        available: false,
        reason:
          'Non implémenté : nécessite un compilateur C/C++ (aucun détecté — voir ' +
          'github.com/antirez/qwen-asr, inférence C sans Python) ou une pile PyTorch/' +
          'transformers complète (plusieurs Go, non vérifiable dans cet environnement). ' +
          'Réservé pour une intégration future une fois un chemin confirmé viable sur ' +
          'poste Windows cible.',
      },
    },
  };
}

module.exports = {
  transcribeSegment,
  getStatus,
  resolveProvider,
  VALID_PROVIDERS,
};
