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
// AJOUT (chantier transcription — cross-check parallèle de basse confiance) :
// featuresStore pour le seuil réglable (voir getCrossCheckConfidenceThreshold),
// scoreCanonicalMatch pour arbitrer entre Groq et Deepgram sur le
// vocabulaire biblique/dynamique déjà connu (voir transcription-corrector.js).
// Ni l'un ni l'autre n'introduit de dépendance circulaire : features-store.js
// et transcription-corrector.js ne requièrent jamais asr-engine.js.
const featuresStore = require('./features-store');
const { scoreCanonicalMatch } = require('./transcription-corrector');

const VALID_PROVIDERS = ['auto', 'groq', 'deepgram', 'streaming', 'qwen-local'];

/** @returns {string} un provider de VALID_PROVIDERS — 'auto' si non réglé ou invalide. */
function resolveProvider() {
  const raw = (process.env.ASR_PROVIDER || 'auto').toLowerCase();
  if (raw === 'streaming') return 'deepgram';
  return VALID_PROVIDERS.includes(raw) ? raw : 'auto';
}

// ---------------------------------------------------------------------------
// AJOUT (chantier transcription — cross-check parallèle de basse confiance) :
// aujourd'hui, dès que Groq répond dans les temps (voir
// groq-wrapper.js#transcribeWithFallback), Deepgram est ABORTÉ et sa
// réponse jamais consultée — MÊME si la confiance Groq est très basse. Un
// segment "gagné" de justesse par Groq avec une confiance médiocre n'était
// donc jamais comparé à une seconde source, contrairement à un ÉCHEC Groq
// (qui, lui, bascule déjà sur Deepgram). Ce correctif cible précisément ce
// trou : un second appel Deepgram, déclenché seulement sous le seuil
// configuré, jamais pour un résultat déjà confiant (coût réseau/latence
// ajouté seulement quand la qualité est déjà en doute).
// ---------------------------------------------------------------------------

const DEFAULT_CROSS_CHECK_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Seuil de déclenchement du cross-check — réglable en direct via
 * config/features.json (audio.crossCheckConfidenceThreshold, rechargé à
 * chaque segment, même discipline que
 * server.js#getTranscriptionConfidenceThreshold), 0.8 (80%) par défaut. Une
 * valeur hors (0, 1] retombe sur le défaut plutôt que de désactiver
 * silencieusement le cross-check ou de le déclencher sur tout segment.
 * @returns {number}
 */
function getCrossCheckConfidenceThreshold() {
  const features = featuresStore.readFeatures();
  const fromFeatures = (features.audio || {}).crossCheckConfidenceThreshold;
  if (typeof fromFeatures === 'number' && fromFeatures > 0 && fromFeatures <= 1) {
    return fromFeatures;
  }
  return DEFAULT_CROSS_CHECK_CONFIDENCE_THRESHOLD;
}

/**
 * Relance Deepgram sur LE MÊME segment déjà transcrit par Groq avec une
 * confiance sous le seuil, et arbitre entre les deux résultats.
 *
 * ARBITRAGE (voir cahier des charges — "meilleure correspondance
 * canonique") : PAS seulement la confiance acoustique brute — un moteur
 * peut être très confiant sur un mot qu'il a pourtant mal reconnu.
 * scoreCanonicalMatch() (transcription-corrector.js) compte les
 * correspondances de CHAQUE texte avec le vocabulaire biblique/dynamique
 * déjà connu (noms de livres, intervenants réguliers, vocabulaire des
 * chants de ce culte) : le texte le plus "reconnaissable" gagne. Égalité de
 * score canonique -> départage par la confiance acoustique brute. Double
 * égalité -> Groq conservé (déjà le résultat en main, aucune raison de
 * préférer Deepgram à raison égale).
 *
 * BULLETPROOF (même discipline que correctSmart() dans
 * transcription-corrector.js) : un échec Deepgram ici (timeout, clé
 * absente, erreur réseau) ne fait JAMAIS perdre le résultat Groq déjà en
 * main — au pire, on garde une transcription de confiance moyenne plutôt
 * que d'en perdre une bonne.
 * @param {string} segmentFile
 * @param {{text: string, isFinal: boolean, confidence?: number, timestamp: number, engine: string}} primaryResult - résultat Groq déjà obtenu
 * @param {string} [language]
 * @returns {Promise<{text: string, isFinal: boolean, confidence?: number, timestamp: number, engine: string, crossChecked?: boolean}>}
 */
async function crossCheckWithDeepgram(segmentFile, primaryResult, language) {
  try {
    const dgResult = await deepgram.transcribeFile(
      segmentFile,
      new AbortController().signal,
      language
    );
    const primaryScore = scoreCanonicalMatch(primaryResult.text);
    const dgScore = scoreCanonicalMatch(dgResult.text);
    const dgWins =
      dgScore > primaryScore ||
      (dgScore === primaryScore && (dgResult.confidence || 0) > (primaryResult.confidence || 0));

    if (dgWins) {
      console.log(
        `[ASR] Cross-check basse confiance : Deepgram retenu (correspondances canoniques ${dgScore} vs ${primaryScore}, confiance ${(primaryResult.confidence || 0).toFixed(2)} -> ${(dgResult.confidence || 0).toFixed(2)})`
      );
      return {
        text: dgResult.text,
        isFinal: true,
        confidence: dgResult.confidence,
        timestamp: primaryResult.timestamp,
        engine: 'deepgram',
        crossChecked: true,
      };
    }
    console.log(
      `[ASR] Cross-check basse confiance : ${primaryResult.engine} conservé (correspondances canoniques ${primaryScore} vs ${dgScore})`
    );
    return { ...primaryResult, crossChecked: true };
  } catch (err) {
    console.warn(
      '[ASR] Cross-check Deepgram indisponible, transcription initiale conservée : ' + err.message
    );
    return primaryResult;
  }
}

/**
 * Applique le cross-check ci-dessus si, et seulement si, TOUTES ces
 * conditions sont réunies : le résultat vient de Groq (jamais Deepgram
 * contre lui-même), une confiance NUMÉRIQUE est présente (jamais déclenché
 * sur `undefined` — un fournisseur qui ne renvoie aucune confiance ne doit
 * pas être traité comme "basse confiance"), elle est sous le seuil, et
 * Deepgram est configuré (sinon rien à comparer).
 * @param {{text: string, isFinal: boolean, confidence?: number, timestamp: number, engine: string}} result
 * @param {string} segmentFile
 * @param {string} [language]
 * @returns {Promise<object>}
 */
async function maybeCrossCheck(result, segmentFile, language) {
  if (
    result.engine === 'groq' &&
    typeof result.confidence === 'number' &&
    result.confidence < getCrossCheckConfidenceThreshold() &&
    deepgram.isConfigured()
  ) {
    return crossCheckWithDeepgram(segmentFile, result, language);
  }
  return result;
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
  const rawLanguage = sessionState.getTranscriptionLanguage();
  // A.5 — 'multi' est un indicateur interne (mode bilingue) qui ne
  // correspond à aucun code de langue pour les fournisseurs ASR. Converti en
  // null pour que Groq/Deepgram activent leur propre détection automatique.
  const language = rawLanguage === 'multi' ? null : rawLanguage;
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
    return maybeCrossCheck(
      {
        text: result.text,
        isFinal: true,
        confidence: result.confidence,
        timestamp,
        engine: 'groq',
      },
      segmentFile,
      language
    );
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
  // seul le paramètre de langue est nouveau ici (lot 4). AJOUT (cross-check) :
  // transcribeWithFallback() bascule déjà sur Deepgram en cas d'ÉCHEC Groq —
  // maybeCrossCheck() couvre le trou restant, un Groq qui RÉPOND mais avec
  // une confiance basse (voir son en-tête).
  const result = await groq.transcribeWithFallback(segmentFile, undefined, contextHint, language);
  return maybeCrossCheck(
    {
      text: result.text,
      isFinal: true,
      confidence: result.confidence,
      timestamp,
      engine: result.source,
    },
    segmentFile,
    language
  );
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
  // AJOUT (chantier transcription — cross-check parallèle de basse confiance),
  // exposés pour test/test-asr-engine.js.
  getCrossCheckConfidenceThreshold,
  maybeCrossCheck,
};
