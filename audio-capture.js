/**
 * ============================================================================
 *  audio-capture.js — Module de capture audio en continu
 * ----------------------------------------------------------------------------
 *  OPTIMISATIONS v0.2.1 (Option A + Bonus):
 *    1. segmentDuration: 6000ms → 5000ms (plus réactif, -17% de latence)
 *    2. overlapDuration: 100ms → 400ms (meilleur contexte entre segments)
 *    3. maxAgeMs: 3600000 (1h) → 180000 (3 minutes) pour nettoyage plus rapide
 *
 *  ARCHITECTURE:
 *    Micro → audio-capture.js → groq-wrapper.js (cloud) → server.js → overlay.html
 *
 *  FONCTIONNALITÉS:
 *    - Capture audio en continu (streaming)
 *    - Segmentation intelligente (VAD - Voice Activity Detection)
 *    - Envoi des segments audio à Groq/Deepgram (transcription cloud)
 *    - Gestion du buffer circulaire pour éviter la perte de données
 *
 *  CONFIGURATION:
 *    - Sample rate: 16000 Hz (recommandé pour Whisper large-v3 côté Groq)
 *    - Channels: 1 (mono)
 *    - Format: PCM 16-bit
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sileroVad = require('./silero-vad');
const asrEngine = require('./asr-engine');
const deepgramStreaming = require('./deepgram-streaming');
const { startTracker } = require('./latency-tracker');

// Configuration
const CONFIG = {
  sampleRate: 16000, // recommandé pour Whisper large-v3 (Groq)
  channels: 1, // Mono
  bitDepth: 16, // PCM 16-bit
  // AJOUT (audit — reflexes plus rapides, gratuit) : 5000ms → 4000ms.
  // whisper-large-v3-turbo (voir groq-wrapper.js) transcrit un segment plus
  // vite que l'ancien modèle, donc raccourcir la fenêtre réduit la latence
  // perçue sans changer de fournisseur ni de coût — juste moins d'audio à
  // attendre avant l'envoi. 4s reste au-dessus du plancher usuel pour une
  // bonne précision Whisper (le contexte se dégrade nettement sous ~3s).
  segmentDuration: 4000, // 4 secondes (optimisé pour réactivité)
  overlapDuration: 400, // 400ms de chevauchement (meilleur contexte)
  // CORRECTIF (VAD réel) : ces deux valeurs existaient déjà mais n'étaient
  // lues nulle part dans ce fichier — la segmentation était purement
  // temporelle, aucun filtrage de silence n'avait lieu malgré le commentaire
  // d'en-tête "Segmentation intelligente (VAD)". 0.3 était un placeholder
  // jamais calibré : pour une RMS normalisée par l'amplitude max int16
  // (échelle 0-1, voir computeRms ci-dessous), la parole normale tourne
  // plutôt autour de 0.01-0.08 selon le gain micro — 0.3 aurait classé
  // quasiment tout en "silence". Valeur de départ raisonnable ; À CALIBRER
  // avec de vrais enregistrements de culte (variation de gain micro d'un
  // lieu à l'autre) avant de considérer ce seuil comme définitif.
  silenceThreshold: 0.02, // Seuil RMS de silence pour VAD (0-1)
  minSpeechDuration: 500, // Durée minimum de voix détectée dans un segment (ms) pour l'envoyer au STT

  // AJOUT (VAD neuronal — Silero) : le RMS seul ne distingue pas "fort"
  // de "parole" (musique, sono, ventilateur passent le seuil aussi
  // facilement qu'une voix) — voir silero-vad.js pour le détail du modèle.
  // 'auto' : Silero si le modèle charge, repli RMS silencieux sinon (voir
  // initVadProvider). 'rms' : force l'ancien comportement (désactive
  // Silero explicitement, ex. VAD_PROVIDER=rms en environnement contraint).
  // 'silero' : force Silero — si le chargement échoue, on retombe quand
  // même sur RMS (jamais d'échec dur du pipeline audio pour une préférence
  // de VAD, voir §25 — un composant indisponible ne doit jamais arrêter le
  // reste du pipeline).
  vadProviderPreference:
    process.env.VAD_PROVIDER === 'rms' || process.env.VAD_PROVIDER === 'silero'
      ? process.env.VAD_PROVIDER
      : 'auto',
  // Seuil de probabilité Silero (0-1) au-dessus duquel une fenêtre de 32ms
  // est classée "voix" — 0.5 est la valeur par défaut documentée par
  // l'équipe Silero, point de départ raisonnable avant calibration terrain.
  sileroSpeechThreshold: 0.5,

  // AJOUT (VAD streaming — capture de phrases plus rapide) : jusqu'ici la
  // segmentation était PUREMENT temporelle (fenêtre fixe segmentDuration),
  // donc une phrase courte suivie d'un silence attendait quand même la fin
  // des 4s avant d'être transcrite. Ces réglages pilotent une coupure
  // anticipée dès qu'un silence de fin de phrase est détecté (voir
  // processStreamingFrame/flushSegment) — segmentDuration devient un
  // plafond de sécurité plutôt que le seul déclencheur.
  trailingSilenceMs: 600, // silence continu après de la voix => on considère la phrase terminée et on coupe tout de suite
  noiseFloorAdaptRate: 0.1, // vitesse d'adaptation (moyenne mobile exponentielle) de l'estimation du bruit ambiant
  noiseMarginMultiplier: 3, // un niveau doit dépasser (bruit ambiant × ce facteur) pour compter comme "voix" côté détection anticipée
  minAdaptiveThreshold: 0.01, // plancher absolu : ne jamais déclencher sur du bruit de quantification même si la pièce est très calme
  maxAdaptiveThreshold: 0.06, // plafond absolu : ne jamais exiger plus fort qu'une voix normale, même dans une pièce bruyante
  initialNoiseFloor: 0.01, // estimation de départ avant calibration (affinée en continu pendant les silences)
  // CORRECTIF (2026-08-07 — protection quota gratuit Groq) : whisper-large-v3-
  // turbo est plafonné à 20 requêtes/minute côté gratuit Groq (confirmé via
  // console.groq.com/docs/rate-limits). Sans plancher, une coupure anticipée
  // sur CHAQUE petite pause entre phrases (parole hachée, plusieurs phrases
  // courtes rapprochées) pourrait dépasser ce débit et déclencher des 429 en
  // plein culte. Ce plancher ne s'applique qu'aux coupures ANTICIPÉES (voir
  // processStreamingFrame) — le plafond de sécurité segmentDuration (4000ms)
  // reste, lui, naturellement sous 20/min et n'a pas besoin de ce garde-fou.
  minFlushIntervalMs: 3200, // ~18.75 requêtes/min max, marge sous le plafond Groq de 20/min
  // CORRECTIF (audit — même famille de bug que ffmpeg.exe dans setup-ffmpeg.js) :
  // était path.join(__dirname, 'temp-audio'). Dans l'app empaquetée
  // (asar: true), __dirname pointe à l'intérieur de app.asar, un fichier
  // archive à LECTURE SEULE — fs.mkdirSync() y échoue systématiquement avec
  // "ENOTDIR: not a directory". Contrairement au cas ffmpeg.exe, il n'y a
  // ici aucun binaire à exécuter (juste des fichiers .wav à écrire puis
  // relire), donc pas besoin d'un chemin "asar.unpacked" spécifique : le
  // dossier temporaire de l'OS (os.tmpdir()) est le bon choix dans TOUS les
  // modes d'exécution (empaqueté, dev, `node server.js` standalone) sans
  // dépendre d'aucune configuration de packaging.
  tempDir: path.join(os.tmpdir(), 'churchoverlay-audio'),
};

// État du module
const STATE = {
  isRecording: false,
  audioBuffer: [],
  segmentCount: 0,
  // CORRECTIF (audit — remplacement de FFmpeg/dshow) : sur certains
  // portables (typiquement micro intégré piloté par Intel Smart Sound
  // Technology ou équivalent), le micro apparaît normalement dans
  // Windows (Paramètres > Son) mais n'est PAS exposé via l'API DirectShow
  // que FFmpeg utilisait pour l'énumération ET la capture — 0 périphérique
  // trouvé, quel que soit l'état de FFmpeg lui-même. `browserCaptureConfig`
  // porte la config active quand la source audio est la capture native du
  // navigateur (Web Audio, dans dashboard.html) plutôt que le flux stdout
  // d'un processus FFmpeg — l'API Web Audio d'Electron/Chromium passe par
  // WASAPI et voit donc les mêmes périphériques que Windows lui-même.
  browserCaptureConfig: null,
  callbacks: {
    onAudioSegment: null,
    onError: null,
    // AJOUT (Deepgram streaming) — voir startDeepgramStreamingSession.
    onPartialTranscript: null, // (text, meta, tracker)
    onFinalTranscript: null, // (text, meta, tracker)
    onAsrFallback: null, // ({ reason }) — la session streaming a échoué, repli sur le pipeline segment/Groq en cours de session
  },
  // AJOUT (VAD streaming) — état de la détection anticipée de fin de phrase,
  // indépendant de STATE.audioBuffer (qui accumule les octets du segment en
  // cours) : voir handleAudioData/processStreamingFrame/flushSegment.
  frameAccumulator: Buffer.alloc(0), // reste d'octets encore trop court pour former une trame VAD complète
  noiseFloor: 0.01, // estimation courante du bruit ambiant, mise à jour uniquement pendant du silence confirmé
  segmentHasSpeech: false, // le segment en cours contient-il déjà assez de voix pour qu'un silence derrière compte comme une fin de phrase ?
  consecutiveSilentFrameMs: 0, // durée de silence consécutif accumulée dans le segment en cours
  voicedFrameMsInSegment: 0, // durée de voix accumulée dans le segment en cours (détection anticipée uniquement)
  lastFlushAt: 0, // horodatage (Date.now()) du dernier segment envoyé — protège minFlushIntervalMs

  // AJOUT (VAD neuronal — Silero) : miroir du bloc RMS ci-dessus, mais
  // piloté par la probabilité de parole du modèle plutôt qu'un seuil RMS.
  // 'rms' par défaut jusqu'à ce que initVadProvider() confirme que Silero a
  // bien chargé (voir startBrowserCapture) — jamais bloquant au démarrage.
  vadProvider: 'rms',
  sileroStreamState: null, // état LSTM du flux courant, voir silero-vad.createStreamState()
  sileroFrameAccumulator: Buffer.alloc(0), // reste d'octets en attente d'une fenêtre Silero complète (512 échantillons)
  sileroQueue: Promise.resolve(), // chaîne sérielle : le LSTM de Silero dépend de l'ordre des fenêtres
  sileroConsecutiveSilentMs: 0,
  sileroVoicedFrameMsInSegment: 0,
  sileroSegmentHasSpeech: false,
  sileroProbSum: 0, // somme des probabilités de parole des fenêtres du segment en cours (verdict final à flushSegment)
  sileroProbCount: 0,

  // AJOUT (Deepgram streaming — architecture temps réel, §7-11 du cahier
  // des charges) : quand actif, les chunks PCM sont poussés en continu vers
  // deepgram-streaming.js AU LIEU d'être accumulés en segments WAV (voir le
  // garde `!STATE.deepgramStreamingActive` dans handleAudioData). asrProvider
  // est résolu UNE FOIS au démarrage de la capture (asr-engine.resolveProvider())
  // — un changement d'ASR_PROVIDER en cours de culte n'est pris en compte
  // qu'au prochain redémarrage du pipeline, comme le reste de la config.
  asrProvider: 'auto',
  deepgramSession: null,
  deepgramStreamingActive: false, // true seulement après ouverture RÉUSSIE de la connexion — jamais supposé avant confirmation

  // AJOUT (latence, §14) : un tracker par énoncé, créé au tout premier
  // indice de voix (VAD, avant même la confirmation cumulative
  // segmentHasSpeech) et refermé/journalisé une fois le résultat final de
  // l'ASR reçu (voir markVadOnset/flushSegment/onFinal du streaming).
  utteranceTracker: null,
};

/**
 * Initialise le répertoire temporaire pour les fichiers audio
 */
function initTempDir(tempDir) {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
}

/**
 * ============================================================================
 *  CHANGELOG — remplacement de FFmpeg par la capture navigateur
 * ----------------------------------------------------------------------------
 *  listDevices() et autoDetectDevice() (énumération DirectShow via FFmpeg)
 *  sont retirées : elles n'étaient de toute façon plus appelées par
 *  startPipeline() (voir server.js, qui appelle startBrowserCapture()), et
 *  DirectShow ne voit tout simplement pas certains micros intégrés modernes
 *  (Intel Smart Sound Technology ou équivalent) — 0 périphérique énuméré,
 *  alors que ce même micro apparaît normalement dans Windows. Le choix du
 *  micro se fait maintenant dans setup.html via navigator.mediaDevices
 *  (même couche WASAPI que Windows), qui stocke un deviceId navigateur —
 *  voir loadMicrophones() dans setup.html. pickBestDevice() est conservée :
 *  son heuristique reste utile pour qui voudrait l'utiliser sur une liste
 *  de libellés navigateur (elle ne dépend pas de FFmpeg elle-même).
 * ============================================================================
 */

// Périphériques à écarter automatiquement : ce sont des boucles de retour
// (ce que les haut-parleurs émettent, pas ce que le micro capte) ou des
// "câbles" virtuels de routage audio — jamais un micro physique.
const LOOPBACK_PATTERNS =
  /stereo mix|what u hear|wave ?out|loopback|cable output|mix st[ée]r[ée]o|virtual cable/i;

// Mots qui indiquent fortement un vrai micro.
const MIC_HINT_PATTERNS = /micro|mic\b|headset|casque|webcam/i;

/**
 * Choisit le périphérique le plus probable parmi une liste détectée.
 * Heuristique : élimine les boucles de retour/périphériques virtuels,
 * privilégie les noms contenant "micro"/"mic"/"casque"/"webcam", et à
 * défaut garde le premier de la liste (ordre renvoyé par Windows, où le
 * périphérique par défaut apparaît généralement en premier).
 * @param {string[]} devices
 * @returns {{ chosen: string|null, candidates: string[], rejected: string[] }}
 */
function pickBestDevice(devices) {
  if (!devices || devices.length === 0) {
    return { chosen: null, candidates: [], rejected: [] };
  }
  const rejected = devices.filter((d) => LOOPBACK_PATTERNS.test(d));
  const candidates = devices.filter((d) => !LOOPBACK_PATTERNS.test(d));

  if (candidates.length === 0) {
    // Rien de sûr : mieux vaut ne rien choisir que de capter un loopback.
    return { chosen: null, candidates: [], rejected };
  }
  if (candidates.length === 1) {
    return { chosen: candidates[0], candidates, rejected };
  }

  const withMicHint = candidates.filter((d) => MIC_HINT_PATTERNS.test(d));
  const chosen = withMicHint.length > 0 ? withMicHint[0] : candidates[0];
  return { chosen, candidates, rejected };
}

/**
 * CORRECTIF (audit — remplacement de FFmpeg par la capture navigateur) :
 * démarre une session de capture SANS lancer de processus FFmpeg. La
 * source des échantillons PCM est maintenant `dashboard.html` (Web Audio /
 * getUserMedia, exécuté dans le renderer — seul endroit avec accès micro
 * sans dépendre de DirectShow), qui pousse ses chunks via IPC jusqu'ici en
 * appelant feedPcmChunk() ci-dessous. Le reste du pipeline (segmentation en
 * handleAudioData, écriture WAV, callback onAudioSegment vers la
 * transcription) est RÉUTILISÉ TEL QUEL — handleAudioData() ne s'est
 * jamais soucié de la provenance des octets, seulement de leur format
 * (PCM16LE mono 16kHz), donc aucune duplication de logique ici.
 * @param {Object} [options] - surcharge de CONFIG (sampleRate, etc.)
 */
function startBrowserCapture(options = {}) {
  if (STATE.isRecording) {
    console.warn('[audio-capture] Enregistrement déjà en cours');
    return;
  }

  const config = { ...CONFIG, ...options };
  initTempDir(config.tempDir);

  STATE.isRecording = true;
  STATE.segmentCount = 0;
  STATE.audioBuffer = [];
  STATE.browserCaptureConfig = config;
  STATE.frameAccumulator = Buffer.alloc(0);
  STATE.noiseFloor = config.initialNoiseFloor;
  STATE.segmentHasSpeech = false;
  STATE.consecutiveSilentFrameMs = 0;
  STATE.voicedFrameMsInSegment = 0;
  STATE.lastFlushAt = 0; // pas de délai artificiel avant le tout premier segment

  // AJOUT (VAD neuronal — Silero) : état remis à zéro à chaque nouvelle
  // capture — un LSTM d'une session précédente n'a aucun sens ici.
  STATE.vadProvider = 'rms';
  STATE.sileroStreamState = sileroVad.createStreamState();
  STATE.sileroFrameAccumulator = Buffer.alloc(0);
  STATE.sileroQueue = Promise.resolve();
  STATE.sileroConsecutiveSilentMs = 0;
  STATE.sileroVoicedFrameMsInSegment = 0;
  STATE.sileroSegmentHasSpeech = false;
  STATE.sileroProbSum = 0;
  STATE.sileroProbCount = 0;
  initVadProvider(config);

  // AJOUT (Deepgram streaming) : état remis à zéro à chaque nouvelle
  // capture — une session WebSocket d'une capture précédente n'a aucun
  // sens ici (voir startDeepgramStreamingSession).
  STATE.asrProvider = asrEngine.resolveProvider();
  STATE.deepgramSession = null;
  STATE.deepgramStreamingActive = false;
  STATE.utteranceTracker = null;
  // AJOUT (finalisation locale par silence — voir finalizeStreamingUtteranceLocally) :
  // dernier texte partiel reçu de Deepgram pour l'énoncé EN COURS, promu en
  // "final" dès que le VAD local (Silero ou repli RMS) détecte un silence de
  // fin de phrase — voir §"ENDPOINTING" du rapport livré : l'endpointing
  // serveur Deepgram (endpointing/utterance_end_ms) a mesuré ~7,5s de délai
  // réel avant de finaliser une phrase, bien trop lent pour un affichage en
  // direct. Le VAD local reste la seule mesure fiable et rapide dont on
  // dispose pour décider QUAND une phrase est terminée ; Deepgram reste la
  // seule source du TEXTE transcrit.
  STATE.lastStreamingPartialText = '';
  STATE.lastStreamingPartialMeta = null;
  if (STATE.asrProvider === 'deepgram') {
    startDeepgramStreamingSession(config);
  }

  console.log(
    '[audio-capture] Capture navigateur (Web Audio, sans FFmpeg) démarrée — ' +
      'en attente de chunks PCM du renderer.'
  );
  // AJOUT (phase de vérification runtime — voir le rapport livré) : trace
  // explicite, grep-able, de la configuration RÉELLEMENT résolue à chaque
  // démarrage de capture — pas ce que .env/.env.example DOCUMENTENT, ce
  // qu'asrEngine.resolveProvider()/config.vadProviderPreference ont
  // RÉELLEMENT lu de process.env à cet instant précis. `auto` est explicité
  // dans le second log dès que initVadProvider() a fini de résoudre
  // silero/rms (asynchrone, quelques centaines de ms plus tard).
  console.log(
    `[CONFIG] ASR_PROVIDER=${process.env.ASR_PROVIDER || '(non défini, défaut: auto)'} -> résolu: ${STATE.asrProvider}`
  );
  console.log(
    `[CONFIG] VAD_PROVIDER=${process.env.VAD_PROVIDER || '(non défini, défaut: auto)'} (résolution asynchrone, voir le prochain log [VAD])`
  );
}

/**
 * Ouvre la session streaming Deepgram pour la capture en cours (asynchrone,
 * ne bloque jamais startBrowserCapture — même logique que initVadProvider).
 * Tant que la connexion n'est pas confirmée ouverte, STATE.deepgramStreamingActive
 * reste false et handleAudioData continue d'utiliser le pipeline segment/WAV
 * classique — AUCUN audio n'est donc perdu pendant la négociation WebSocket
 * ni si DEEPGRAM_API_KEY est absent (repli propre, voir onError plus bas).
 * @param {Object} config - config active de cette capture
 */
function startDeepgramStreamingSession(config) {
  if (!deepgramStreaming.isConfigured()) {
    console.warn(
      '[audio-capture] ASR : DEEPGRAM_API_KEY absent — ASR_PROVIDER=deepgram demandé mais ' +
        'impossible à honorer, repli sur le pipeline segment/Groq classique.'
    );
    return;
  }

  let session;
  try {
    session = deepgramStreaming.createSession({
      onOpen: () => {
        if (!STATE.isRecording || STATE.browserCaptureConfig !== config) return; // session obsolète (capture relancée entre-temps)
        STATE.deepgramStreamingActive = true;
        console.log('[audio-capture] ASR : session streaming Deepgram ouverte.');
        console.log('[ASR] provider=deepgram mode=streaming');
      },
      onPartial: (text, meta) => {
        if (!STATE.isRecording) return;
        const tracker = STATE.utteranceTracker;
        // Un seul marquage 'asrFirstPartial' par énoncé — les partials suivants
        // affinent le texte mais le premier est la mesure de latence utile.
        if (tracker && !tracker.summary().deltas.asrFirstPartial) {
          tracker.mark('asrFirstPartial');
        }
        // AJOUT (finalisation locale par silence) : dernier partial connu
        // pour l'énoncé en cours — c'est CE texte que
        // finalizeStreamingUtteranceLocally() promeut en "final" dès que le
        // VAD local détecte la fin de la phrase, sans jamais attendre
        // is_final/speech_final de Deepgram (mesuré ~7,5s de délai réel,
        // voir le rapport livré).
        if (text) {
          STATE.lastStreamingPartialText = text;
          STATE.lastStreamingPartialMeta = meta;
        }
        if (STATE.callbacks.onPartialTranscript) {
          STATE.callbacks.onPartialTranscript(text, meta, tracker);
        }
      },
      onFinal: (text, meta) => {
        // CORRECTIF (live test réel, DEEPGRAM_API_KEY vraie — le dernier
        // 'final' d'un énoncé était perdu à chaque arrêt volontaire de la
        // capture) : stopRecording() met STATE.isRecording à false AVANT
        // d'appeler session.finish() — et finish() attend maintenant
        // (à raison, voir son correctif dans deepgram-streaming.js) que
        // Deepgram renvoie ce dernier résultat avant de fermer le socket.
        // Le garde `!STATE.isRecording` ci-dessus rejetait donc le tout
        // dernier 'final' de CHAQUE énoncé qui déclenchait un arrêt de
        // capture — confirmé par un test réel (live-tests/). On vérifie à
        // la place qu'aucune session PLUS RÉCENTE n'a remplacé celle-ci
        // (repli légitime : ignorer un 'final' tardif d'une session que la
        // capture a depuis relancée) — un arrêt volontaire simple
        // (STATE.deepgramSession devenu null) laisse toujours passer ce
        // dernier résultat.
        if (STATE.deepgramSession !== session && STATE.deepgramSession !== null) return;
        const tracker = STATE.utteranceTracker;
        if (tracker) tracker.mark('asrFinal');
        if (STATE.callbacks.onFinalTranscript) {
          STATE.callbacks.onFinalTranscript(text, meta, tracker);
        }
        // Énoncé terminé : le prochain indice de voix (markVadOnset) doit
        // démarrer un tracker frais, pas continuer à empiler sur celui-ci.
        STATE.utteranceTracker = null;
        // Ce 'final' officiel Deepgram (souvent tardif, voir plus haut)
        // règle définitivement l'énoncé qu'il décrit — rien à re-finaliser
        // localement pour ce même texte. S'il arrive APRÈS que le VAD local
        // a déjà promu un partial en "final" pour l'énoncé SUIVANT (déjà en
        // cours), ce reset est sans effet indésirable : il efface juste un
        // texte déjà transmis, jamais celui de l'énoncé en cours (mis à jour
        // en continu par onPartial ci-dessus).
        STATE.lastStreamingPartialText = '';
        STATE.lastStreamingPartialMeta = null;
      },
      onError: (err) => {
        console.warn(
          `[audio-capture] ASR : erreur streaming Deepgram (${err.message}) — repli sur le ` +
            'pipeline segment/Groq pour le reste de la session.'
        );
        STATE.deepgramStreamingActive = false;
        if (STATE.callbacks.onAsrFallback) {
          STATE.callbacks.onAsrFallback({ reason: err.message });
        }
      },
      onClose: () => {
        // Fermeture inattendue (pas via stopRecording, qui appelle déjà
        // session.finish() et ignore ce cas car isRecording est déjà false) :
        // même traitement qu'une erreur — reste de la session en repli.
        if (!STATE.isRecording) return;
        if (STATE.deepgramStreamingActive) {
          console.warn(
            '[audio-capture] ASR : session streaming Deepgram fermée de façon inattendue — repli.'
          );
        }
        STATE.deepgramStreamingActive = false;
        if (STATE.callbacks.onAsrFallback) {
          STATE.callbacks.onAsrFallback({ reason: 'Connexion streaming fermée inopinément.' });
        }
      },
    });
  } catch (err) {
    console.warn(
      `[audio-capture] ASR : impossible d'ouvrir la session Deepgram (${err.message}) — repli.`
    );
    return;
  }

  STATE.deepgramSession = session;
}

/**
 * Détermine et active le fournisseur de VAD pour la capture en cours, sans
 * jamais bloquer le démarrage (async, "fire and forget" — les tout premiers
 * segments peuvent être classés en RMS le temps que Silero finisse de
 * charger, sans conséquence : le seuil RMS reste correct, juste moins
 * précis sur du bruit fort). N'écrase JAMAIS un repli déjà décidé par une
 * capture entre-temps arrêtée/relancée (voir le garde isRecording ci-dessous).
 * @param {Object} config - config active de cette capture (vadProviderPreference)
 */
function initVadProvider(config) {
  if (config.vadProviderPreference === 'rms') {
    console.log('[audio-capture] VAD : RMS forcé (VAD_PROVIDER=rms).');
    console.log('[VAD] resolved provider=rms (forcé par VAD_PROVIDER=rms)');
    return;
  }
  sileroVad
    .init()
    .then(({ ok, error }) => {
      // La capture a pu être arrêtée/relancée pendant le chargement (~qq
      // centaines de ms) — ne pas activer Silero pour une session qui n'est
      // plus la session courante.
      if (!STATE.isRecording || STATE.browserCaptureConfig !== config) return;
      if (ok) {
        STATE.vadProvider = 'silero';
        console.log('[audio-capture] VAD : Silero (neuronal) actif.');
        console.log('[VAD] resolved provider=silero');
      } else {
        console.warn(
          `[audio-capture] VAD : Silero indisponible (${error}) — repli sur la détection RMS existante.`
        );
        console.log('[VAD] resolved provider=rms (repli — échec chargement Silero)');
      }
    })
    .catch((err) => {
      console.warn(
        `[audio-capture] VAD : erreur inattendue à l'init Silero (${err.message}) — repli RMS.`
      );
      console.log('[VAD] resolved provider=rms (repli — erreur inattendue Silero)');
    });
}

/**
 * Reçoit un chunk PCM16LE mono envoyé par le renderer (dashboard.html) et le
 * fait passer par exactement la même logique de segmentation/transcription
 * que le flux stdout de FFmpeg utilisait auparavant.
 * @param {Buffer} buffer - PCM16LE, mono, au sampleRate de STATE.browserCaptureConfig
 */
function feedPcmChunk(buffer) {
  if (!STATE.isRecording || !STATE.browserCaptureConfig) {
    // Chunk arrivé après un stop (course renderer/worker normale à l'arrêt) : ignoré sans bruit.
    return;
  }
  handleAudioData(buffer, STATE.browserCaptureConfig);
}

/**
 * Calcule le RMS (Root Mean Square) normalisé (0-1) d'un buffer PCM16LE.
 * @param {Buffer} buffer - échantillons PCM16LE
 * @returns {number} niveau RMS normalisé par l'amplitude max int16 (32768)
 */
function computeRms(buffer) {
  const sampleCount = buffer.length / 2;
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

// Taille des sous-fenêtres utilisées pour l'analyse VAD à l'intérieur d'un
// segment. 100ms est un bon compromis (assez court pour détecter des
// silences internes, assez long pour rester rapide en JS pur, sans lib
// externe).
const VAD_FRAME_MS = 100;

/**
 * AJOUT (latence, §14) : crée le tracker de l'énoncé en cours au tout
 * premier indice de voix (avant même la confirmation cumulative
 * segmentHasSpeech/sileroSegmentHasSpeech, qui n'arrive qu'après
 * config.minSpeechDuration) — c'est la mesure "VAD" du cahier des charges :
 * le temps entre le début réel de la parole et sa détection. Idempotent :
 * un tracker déjà en cours pour cet énoncé n'est jamais recréé.
 */
function markVadOnset() {
  if (STATE.utteranceTracker) return;
  STATE.utteranceTracker = startTracker();
  STATE.utteranceTracker.mark('vad');
}

/**
 * Analyse un segment PCM déjà assemblé et retourne la durée totale de voix
 * détectée à l'intérieur, en découpant le segment en sous-fenêtres de
 * VAD_FRAME_MS et en comptant celles qui dépassent config.silenceThreshold.
 *
 * MISE À JOUR (VAD streaming) : cette fonction reste volontairement simple
 * (RMS par sous-fenêtre, seuil STATIQUE config.silenceThreshold) — c'était à
 * l'origine le SEUL filtre "ce segment mérite-t-il d'être envoyé au STT ?".
 *
 * CORRECTIF (2026-08-08 — "aucune voix détectée" alors que l'opérateur
 * parle) : ce seuil statique (0.02 par défaut, jamais calibré pour un micro
 * réel — voir .env.example) peut être plus haut que le niveau RMS réel
 * d'une voix captée par un micro peu sensible/éloigné dans une pièce très
 * calme, même quand cette voix est nettement au-dessus du bruit ambiant
 * réel. flushSegment() n'utilise donc plus CE SEUL résultat : il accepte
 * aussi un segment si le seuil ADAPTATIF (bruit ambiant appris en continu,
 * voir processStreamingFrame/STATE.segmentHasSpeech) l'avait déjà classé
 * comme voisé — les deux détecteurs sont combinés en OU, pas l'un après
 * l'autre, pour ne jamais perdre une vraie phrase juste parce qu'elle est
 * sous silenceThreshold sans être sous le bruit ambiant réel.
 * @param {Buffer} segmentBuffer - PCM16LE du segment complet
 * @param {Object} config - config active (sampleRate, channels, bitDepth, silenceThreshold)
 * @returns {{ voicedMs: number, totalMs: number, maxRms: number }}
 */
function analyzeVoiceActivity(segmentBuffer, config) {
  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const frameBytes = Math.floor((VAD_FRAME_MS / 1000) * samplesPerSecond * bytesPerSample);

  if (frameBytes <= 0 || segmentBuffer.length < frameBytes) {
    // Segment trop court pour être découpé : on l'analyse en un seul bloc.
    const rms = computeRms(segmentBuffer);
    const totalMs = (segmentBuffer.length / (samplesPerSecond * bytesPerSample)) * 1000;
    return { voicedMs: rms >= config.silenceThreshold ? totalMs : 0, totalMs };
  }

  let voicedFrames = 0;
  let totalFrames = 0;
  let maxRms = 0;
  for (let offset = 0; offset + frameBytes <= segmentBuffer.length; offset += frameBytes) {
    const frame = segmentBuffer.slice(offset, offset + frameBytes);
    const frameRms = computeRms(frame);
    if (frameRms >= config.silenceThreshold) voicedFrames++;
    if (frameRms > maxRms) maxRms = frameRms;
    totalFrames++;
  }
  // maxRms (AJOUT diagnostic) : le niveau le plus fort observé dans le
  // segment, même rejeté — sert à distinguer "vraiment silencieux" de
  // "de la voix, mais sous silenceThreshold" dans onSegmentSkipped ci-dessous.
  return { voicedMs: voicedFrames * VAD_FRAME_MS, totalMs: totalFrames * VAD_FRAME_MS, maxRms };
}

/**
 * Traite UNE trame VAD (VAD_FRAME_MS) déjà extraite du flux entrant. Alimente
 * la state machine de détection anticipée de fin de phrase : met à jour
 * l'estimation adaptative du bruit ambiant pendant le silence, et déclenche
 * un flush précoce dès qu'un silence de fin de phrase (config.trailingSilenceMs)
 * suit un segment qui contenait déjà assez de voix (config.minSpeechDuration).
 * AJOUT (VAD streaming — capture de phrases plus rapide/robuste au bruit).
 * @param {Buffer} frame - trame PCM16LE de VAD_FRAME_MS
 * @param {Object} config - configuration active
 */
function processStreamingFrame(frame, config) {
  const rms = computeRms(frame);
  const adaptiveThreshold = Math.min(
    config.maxAdaptiveThreshold,
    Math.max(config.minAdaptiveThreshold, STATE.noiseFloor * config.noiseMarginMultiplier)
  );
  const isVoiced = rms >= adaptiveThreshold;

  if (isVoiced) {
    markVadOnset();
    STATE.consecutiveSilentFrameMs = 0;
    STATE.voicedFrameMsInSegment += VAD_FRAME_MS;
    if (STATE.voicedFrameMsInSegment >= config.minSpeechDuration) {
      STATE.segmentHasSpeech = true;
    }
  } else {
    STATE.consecutiveSilentFrameMs += VAD_FRAME_MS;
    if (!STATE.segmentHasSpeech) {
      // On n'a encore détecté aucune voix dans ce segment : ce silence est
      // du bruit ambiant fiable, on peut affiner l'estimation dessus. Une
      // fois de la voix détectée, on arrête d'adapter pour ne pas laisser
      // un souffle/une respiration entre deux phrases faire dériver le
      // seuil vers le haut et rater le début de la phrase suivante.
      STATE.noiseFloor =
        STATE.noiseFloor * (1 - config.noiseFloorAdaptRate) + rms * config.noiseFloorAdaptRate;
    }
  }

  // AJOUT (VAD neuronal — Silero) : cette boucle RMS reste TOUJOURS active
  // (voir handleAudioData) pour maintenir noiseFloor à jour et servir de
  // repli instantané, mais ne doit déclencher le flush anticipé que si
  // c'est bien elle qui pilote la session — sinon RMS et Silero pourraient
  // tous deux appeler flushSegment() pour le même segment.
  if (STATE.vadProvider !== 'rms') return;
  // AJOUT (Deepgram streaming + finalisation locale, voir
  // finalizeStreamingUtteranceLocally) : pendant que le streaming est actif,
  // pas de segment WAV à flusher — mais ce même silence de fin de phrase
  // sert désormais à décider QUAND promouvoir le dernier partial Deepgram
  // en "final", au lieu d'attendre l'endpointing serveur (mesuré ~7,5s de
  // délai réel, bien trop lent — voir le rapport livré). Pas de garde
  // minFlushIntervalMs ici : ce seuil protège le quota de requêtes Groq,
  // sans objet pour une connexion streaming déjà ouverte en continu.
  if (STATE.deepgramStreamingActive) {
    if (STATE.segmentHasSpeech && STATE.consecutiveSilentFrameMs >= config.trailingSilenceMs) {
      finalizeStreamingUtteranceLocally();
    }
    return;
  }

  const sinceLastFlushMs = Date.now() - STATE.lastFlushAt;
  if (
    STATE.segmentHasSpeech &&
    STATE.consecutiveSilentFrameMs >= config.trailingSilenceMs &&
    sinceLastFlushMs >= config.minFlushIntervalMs
  ) {
    flushSegment(config, { early: true });
  }
}

/**
 * Concatène le segment en cours, décide (via analyzeVoiceActivity, seuil
 * STATIQUE config.silenceThreshold) s'il mérite d'être envoyé au STT, et
 * réinitialise l'état du segment en cours. Appelée soit tôt (silence de fin
 * de phrase détecté par processStreamingFrame), soit au plafond de sécurité
 * (segmentDuration atteint, voir handleAudioData).
 * @param {Object} config - configuration active
 * @param {{ early?: boolean }} [opts] - early=true : fin de phrase naturelle
 *   (pas de chevauchement conservé) ; early=false : coupure de sécurité en
 *   pleine parole (chevauchement conservé pour le contexte Whisper).
 */
function flushSegment(config, { early = false } = {}) {
  const segmentBuffer = Buffer.concat(STATE.audioBuffer);
  if (segmentBuffer.length === 0) return;

  STATE.lastFlushAt = Date.now();

  // Capturés AVANT le reset ci-dessous : verdict du détecteur ADAPTATIF sur
  // ce segment précis (voir processStreamingFrame), utilisé en OU avec
  // analyzeVoiceActivity() (seuil statique) pour la décision d'acceptation.
  const adaptiveDetectedSpeech = STATE.segmentHasSpeech;
  const noiseFloorAtFlush = STATE.noiseFloor;
  const adaptiveThresholdAtFlush = Math.min(
    config.maxAdaptiveThreshold,
    Math.max(config.minAdaptiveThreshold, noiseFloorAtFlush * config.noiseMarginMultiplier)
  );
  // AJOUT (VAD neuronal — Silero) : capturés AVANT le reset ci-dessous,
  // même principe que adaptiveDetectedSpeech mais piloté par le modèle —
  // voir processSileroWindow. sileroAvgProb sert uniquement au diagnostic
  // (journal) ; la décision d'acceptation utilise sileroSegmentHasSpeech
  // (cohérence de seuil avec processSileroWindow, qui compare déjà chaque
  // fenêtre à config.sileroSpeechThreshold).
  const usingSilero = STATE.vadProvider === 'silero';
  const sileroSegmentHasSpeech = STATE.sileroSegmentHasSpeech;
  const sileroAvgProb =
    STATE.sileroProbCount > 0 ? STATE.sileroProbSum / STATE.sileroProbCount : null;
  // AJOUT (latence, §14) : capturé AVANT reset — repris par onAudioSegment
  // si le segment est accepté (l'ASR va suivre), sinon simplement abandonné
  // (aucun évènement ASR ne viendra jamais pour un segment rejeté).
  const flushTracker = STATE.utteranceTracker;
  STATE.utteranceTracker = null;

  if (early) {
    // Silence de fin de phrase confirmé : rien à reporter sur le prochain
    // segment, la coupure tombe déjà à un bon endroit.
    STATE.audioBuffer = [];
  } else {
    const bytesPerSample = config.bitDepth / 8;
    const samplesPerSecond = config.sampleRate * config.channels;
    const overlapSize = (config.overlapDuration / 1000) * samplesPerSecond * bytesPerSample;
    const keepSize = Math.max(0, segmentBuffer.length - overlapSize);
    STATE.audioBuffer = keepSize > 0 ? [segmentBuffer.slice(keepSize)] : [];
  }

  // Le segment suivant repart de zéro pour la détection de fin de phrase.
  // noiseFloor n'est PAS réinitialisé : l'estimation du bruit de la pièce
  // doit survivre aux coupures de segment pour rester utile sur la durée
  // d'un culte entier.
  STATE.segmentHasSpeech = false;
  STATE.consecutiveSilentFrameMs = 0;
  STATE.voicedFrameMsInSegment = 0;
  STATE.sileroConsecutiveSilentMs = 0;
  STATE.sileroVoicedFrameMsInSegment = 0;
  STATE.sileroSegmentHasSpeech = false;
  STATE.sileroProbSum = 0;
  STATE.sileroProbCount = 0;

  // AJOUT (VAD réel) : avant d'écrire le WAV et de déclencher le STT,
  // on vérifie que le segment contient assez de voix détectée. Sans ce
  // filtre, un segment de 5s de silence/musique (bruit de fond, temps
  // de transition, chant) partait quand même vers Groq/Deepgram — coût
  // API inutile et source de faux positifs de transcription.
  //
  // CORRECTIF (2026-08-08) : accepté si le seuil STATIQUE (analyzeVoiceActivity)
  // OU le détecteur ADAPTATIF (adaptiveDetectedSpeech, calculé en continu
  // pendant l'accumulation du segment, voir plus haut) a détecté de la voix
  // — voir le commentaire de analyzeVoiceActivity() pour le raisonnement
  // complet. Un micro peu sensible dans une pièce très calme peut produire
  // une voix sous silenceThreshold sans être sous le bruit ambiant réel.
  const voiceInfo = analyzeVoiceActivity(segmentBuffer, config);
  const staticDetectedSpeech = voiceInfo.voicedMs >= config.minSpeechDuration;
  // AJOUT (VAD neuronal — Silero) : quand Silero pilote la session, c'est
  // SON verdict qui fait foi pour accepter/rejeter (un modèle entraîné à
  // reconnaître la parole plutôt qu'un simple niveau sonore) — le OU
  // RMS/adaptatif ci-dessus reste le comportement exact d'avant quand
  // Silero est indisponible (config.vadProviderPreference==='rms', ou repli
  // suite à une erreur d'inférence, voir processSileroWindow).
  const detectedSpeech = usingSilero
    ? sileroSegmentHasSpeech
    : staticDetectedSpeech || adaptiveDetectedSpeech;
  if (!detectedSpeech) {
    STATE.segmentCount++;
    const providerNote = usingSilero
      ? `Silero, probabilité moyenne ${sileroAvgProb !== null ? sileroAvgProb.toFixed(3) : 'n/a'} < seuil ${config.sileroSpeechThreshold}`
      : `RMS — ${voiceInfo.voicedMs}ms de voix détectée < seuil ${config.minSpeechDuration}ms, ` +
        `pic ${voiceInfo.maxRms.toFixed(4)} vs seuil statique ${config.silenceThreshold} / ` +
        `seuil adaptatif ${adaptiveThresholdAtFlush.toFixed(4)}, bruit ambiant ${noiseFloorAtFlush.toFixed(4)}`;
    console.log(`[audio-capture] Segment ${STATE.segmentCount} ignoré (silence — ${providerNote})`);
    // CORRECTIF (problème récurrent — transcription qui ne démarre jamais
    // sans qu'aucune erreur ne soit visible) : ce rejet était auparavant
    // silencieux (console.log uniquement, jamais vu en usage normal). Si
    // le micro reste durablement sous silenceThreshold (mauvais gain,
    // mauvais périphérique sélectionné...), CHAQUE segment est rejeté et
    // rien n'apparaît jamais côté opérateur, sans qu'aucun message
    // n'explique pourquoi. Rendu visible via ce callback ; server.js
    // limite lui-même la fréquence d'alerte pour ne pas spammer le
    // dashboard si le silence est normal (temps mort entre deux prises
    // de parole). AJOUT (2026-08-08) : maxRms/noiseFloor/adaptiveThreshold
    // exposés pour que le message d'alerte donne des chiffres concrets au
    // lieu de renvoyer juste vers "vérifiez le périphérique et son gain".
    if (STATE.callbacks.onSegmentSkipped) {
      STATE.callbacks.onSegmentSkipped({
        provider: usingSilero ? 'silero' : 'rms',
        sileroAvgProb,
        voicedMs: voiceInfo.voicedMs,
        totalMs: voiceInfo.totalMs,
        threshold: config.silenceThreshold,
        minSpeechDuration: config.minSpeechDuration,
        maxRms: voiceInfo.maxRms,
        noiseFloor: noiseFloorAtFlush,
        adaptiveThreshold: adaptiveThresholdAtFlush,
      });
    }
    return;
  }
  if (!usingSilero && !staticDetectedSpeech && adaptiveDetectedSpeech) {
    console.log(
      `[audio-capture] Segment accepté via détecteur ADAPTATIF uniquement ` +
        `(pic ${voiceInfo.maxRms.toFixed(4)} sous seuil statique ${config.silenceThreshold}, ` +
        `mais au-dessus du bruit ambiant appris ${noiseFloorAtFlush.toFixed(4)})`
    );
  }

  // Créer le fichier WAV pour ce segment
  const wavBuffer = createWavFile(
    segmentBuffer,
    config.sampleRate,
    config.channels,
    config.bitDepth
  );

  STATE.segmentCount++;
  const segmentFile = path.join(config.tempDir, `segment_${STATE.segmentCount}.wav`);
  fs.writeFileSync(segmentFile, wavBuffer);

  const providerSummary = usingSilero
    ? `Silero, probabilité moyenne ${sileroAvgProb !== null ? sileroAvgProb.toFixed(3) : 'n/a'}`
    : `RMS, ${voiceInfo.voicedMs}ms de voix détectée`;
  console.log(
    `[audio-capture] Segment ${STATE.segmentCount} créé (${segmentBuffer.length} bytes, ` +
      `${providerSummary}${early ? ', coupure anticipée (fin de phrase)' : ''})`
  );

  // Envoyer le segment au callback — flushTracker (§14) suit ce segment
  // précis jusqu'à son résultat ASR final, voir server.js (transcribeWithRetry).
  if (STATE.callbacks.onAudioSegment) {
    STATE.callbacks.onAudioSegment(segmentFile, flushTracker);
  }
}

/**
 * Équivalent de flushSegment(), MAIS pour le chemin streaming Deepgram —
 * appelée par processStreamingFrame()/processSileroWindow() quand le VAD
 * local (RMS ou Silero, selon STATE.vadProvider) détecte un silence de fin
 * de phrase (config.trailingSilenceMs) après un énoncé confirmé
 * (config.minSpeechDuration) alors qu'une session streaming est active.
 *
 * POURQUOI CETTE FONCTION EXISTE (rapport de validation Deepgram livré,
 * phase "endpointing") : mesuré en conditions réelles (vraie clé
 * DEEPGRAM_API_KEY, vrai réseau), aucune des deux options officielles
 * Deepgram pour détecter la fin d'un énoncé pendant un flux continu
 * (`endpointing` seul, ou `utterance_end_ms` + `vad_events`) n'a fini par
 * finaliser en moins de ~7,5 SECONDES après la fin réelle de la parole —
 * les deux semblent attendre le même premier `is_final` interne au moteur
 * Deepgram, quelle que soit leur configuration. Beaucoup trop lent pour un
 * affichage en direct pendant un culte. Le VAD local (déjà réel, déjà
 * testé, voir silero-vad.js) reste la seule mesure fiable et rapide de
 * "l'orateur s'est tu" dont on dispose : cette fonction l'utilise pour
 * décider QUAND finaliser, tout en gardant Deepgram comme unique source du
 * TEXTE transcrit (le dernier partial reçu, voir STATE.lastStreamingPartialText
 * mis à jour dans onPartial de startDeepgramStreamingSession).
 *
 * Le flux WebSocket Deepgram N'EST JAMAIS fermé ni relancé ici — seule la
 * decision LOCALE de "cet énoncé est terminé" change ; si Deepgram finit
 * quand même par renvoyer, bien plus tard, son propre `final` officiel pour
 * ce même énoncé, il est toujours transmis normalement (voir onFinal
 * ci-dessus) — le dédoublonnage déjà existant côté serveur
 * (sessionState.isDuplicateReference, fenêtre de 30s) absorbe ce cas sans
 * déclencher une deuxième mise à jour OBS pour la même référence.
 *
 * Réutilise EXACTEMENT les mêmes seuils déjà réglés et éprouvés pour le
 * chemin WAV classique (config.minSpeechDuration=500ms, config.trailingSilenceMs=600ms)
 * plutôt que d'en inventer de nouveaux sans justification : un silence plus
 * court qu'une respiration/pause naturelle ne déclenche jamais cette
 * fonction (le compteur de silence repart à zéro dès que la parole
 * reprend, avant même d'atteindre ce seuil — voir processStreamingFrame/
 * processSileroWindow), donc une pause normale au milieu d'une phrase ne
 * coupe pas prématurément l'énoncé.
 */
function finalizeStreamingUtteranceLocally() {
  if (!STATE.lastStreamingPartialText) return; // rien à finaliser (silence pur, ou déjà résolu par un final officiel)

  const text = STATE.lastStreamingPartialText;
  const meta = { ...(STATE.lastStreamingPartialMeta || {}), finalizedBy: 'local-vad-silence' };
  const tracker = STATE.utteranceTracker;
  if (tracker) tracker.mark('asrFinal');

  STATE.lastFlushAt = Date.now();
  STATE.lastStreamingPartialText = '';
  STATE.lastStreamingPartialMeta = null;
  // Prêt pour le prochain énoncé : mêmes réinitialisations que flushSegment(),
  // moins l'état du buffer WAV (inexistant côté streaming).
  STATE.segmentHasSpeech = false;
  STATE.consecutiveSilentFrameMs = 0;
  STATE.voicedFrameMsInSegment = 0;
  STATE.sileroConsecutiveSilentMs = 0;
  STATE.sileroVoicedFrameMsInSegment = 0;
  STATE.sileroSegmentHasSpeech = false;
  STATE.sileroProbSum = 0;
  STATE.sileroProbCount = 0;
  STATE.utteranceTracker = null;

  console.log(
    `[audio-capture] Énoncé streaming finalisé localement (silence VAD) : "${text.substring(0, 80)}"`
  );
  if (STATE.callbacks.onFinalTranscript) {
    STATE.callbacks.onFinalTranscript(text, meta, tracker);
  }
}

/**
 * Traite les données audio reçues : alimente à la fois l'accumulateur de
 * segment (octets bruts, pour l'écriture WAV finale) et le scan VAD
 * streaming trame par trame (détection anticipée de fin de phrase, voir
 * processStreamingFrame). segmentDuration agit désormais comme un plafond
 * de sécurité — la coupure normale arrive plus tôt, dès qu'un silence de
 * fin de phrase est détecté.
 * @param {Buffer} data - Données audio brutes (PCM16LE)
 * @param {Object} config - Configuration actuelle
 */
function handleAudioData(data, config) {
  // AJOUT (Deepgram streaming, §7-11 du cahier des charges — architecture
  // temps réel, pas un simple découpage plus rapide de l'ancienne
  // architecture WAV) : quand une session streaming est active, CHAQUE
  // chunk part directement vers Deepgram, et AUCUN segment WAV n'est
  // accumulé/écrit pour ce chemin — c'est bien "Micro → chunks PCM en
  // continu → Deepgram" tel que demandé, pas "toujours des WAV mais plus
  // petits". Le VAD (RMS/Silero) continue de tourner ci-dessous, mais
  // seulement pour la latence (markVadOnset) et comme filet de repli — voir
  // les gardes STATE.deepgramStreamingActive dans processStreamingFrame et
  // processSileroWindow, qui empêchent tout flush WAV tant que le
  // streaming est sain.
  if (STATE.deepgramStreamingActive && STATE.deepgramSession) {
    STATE.deepgramSession.sendAudio(data);
  } else {
    STATE.audioBuffer.push(data);
  }
  STATE.frameAccumulator = Buffer.concat([STATE.frameAccumulator, data]);

  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const frameBytes = Math.floor((VAD_FRAME_MS / 1000) * samplesPerSecond * bytesPerSample);

  // AJOUT (VAD neuronal — Silero) : boucle RMS existante conservée TELLE
  // QUELLE et TOUJOURS active, même quand Silero pilote la décision de
  // coupure — voir processStreamingFrame, dont le déclenchement de flush
  // anticipé est lui-même gardé par vadProvider === 'rms'. La garder active
  // en permanence maintient noiseFloor à jour, prêt à servir de repli
  // instantané si Silero échoue en cours de culte (voir processSileroWindow).
  while (frameBytes > 0 && STATE.frameAccumulator.length >= frameBytes) {
    const frame = STATE.frameAccumulator.slice(0, frameBytes);
    STATE.frameAccumulator = STATE.frameAccumulator.slice(frameBytes);
    processStreamingFrame(frame, config);
  }

  // AJOUT (VAD neuronal — Silero) : découpage en fenêtres de EXACTEMENT
  // silero-vad.WINDOW_SAMPLES échantillons (32ms à 16kHz — voir silero-vad.js
  // pour pourquoi cette taille précise). Chaque fenêtre est empilée sur une
  // file sérielle (STATE.sileroQueue) : l'inférence est asynchrone et le
  // LSTM du modèle dépend strictement de l'ordre, donc jamais deux
  // inférences en vol en parallèle pour le même flux.
  if (STATE.vadProvider === 'silero') {
    const windowBytes = sileroVad.WINDOW_SAMPLES * bytesPerSample;
    STATE.sileroFrameAccumulator = Buffer.concat([STATE.sileroFrameAccumulator, data]);
    while (STATE.sileroFrameAccumulator.length >= windowBytes) {
      const frame = STATE.sileroFrameAccumulator.slice(0, windowBytes);
      STATE.sileroFrameAccumulator = STATE.sileroFrameAccumulator.slice(windowBytes);
      STATE.sileroQueue = STATE.sileroQueue.then(() => processSileroWindow(frame, config));
    }
  }

  // Plafond de sécurité : même sans silence de fin de phrase détecté (voix
  // continue), on ne laisse jamais un segment grossir indéfiniment. Sans
  // objet tant que le streaming est actif (STATE.audioBuffer reste vide,
  // voir plus haut) — garde explicite malgré tout, par clarté.
  if (!STATE.deepgramStreamingActive) {
    const segmentSize = (config.segmentDuration / 1000) * samplesPerSecond * bytesPerSample;
    const bufferSize = STATE.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
    if (bufferSize >= segmentSize) {
      flushSegment(config, { early: false });
    }
  }
}

/**
 * Classe UNE fenêtre Silero (32ms) déjà extraite du flux entrant, met à
 * jour la state machine de détection anticipée (miroir de
 * processStreamingFrame, mais pilotée par la probabilité de parole du
 * modèle plutôt qu'un seuil RMS), et déclenche un flush précoce dans les
 * mêmes conditions que la version RMS. Appelée en série via
 * STATE.sileroQueue — voir handleAudioData.
 * @param {Buffer} frame - trame PCM16LE de EXACTEMENT WINDOW_SAMPLES échantillons
 * @param {Object} config - configuration active
 */
async function processSileroWindow(frame, config) {
  // Le fournisseur actif a pu changer pendant que cette fenêtre attendait
  // son tour dans la file (repli RMS déclenché par une erreur d'inférence
  // précédente, ou capture arrêtée) — abandonner plutôt que de continuer à
  // calculer un état Silero que plus personne ne consultera.
  if (STATE.vadProvider !== 'silero' || !STATE.isRecording) return;

  let prob;
  try {
    const samples = sileroVad.pcm16ToFloat32(frame);
    prob = await sileroVad.processWindow(samples, STATE.sileroStreamState);
  } catch (err) {
    // CORRECTIF (jamais d'échec dur du pipeline audio pour un problème de
    // VAD, voir §25) : une erreur d'inférence en pleine capture (modèle
    // corrompu, mémoire insuffisante...) fait basculer DÉFINITIVEMENT sur
    // RMS pour le reste de cette session plutôt que de retenter à chaque
    // fenêtre (32ms) et spammer les journaux/le CPU.
    console.warn(
      `[audio-capture] VAD : erreur d'inférence Silero (${err.message}) — repli RMS pour le reste de la session.`
    );
    STATE.vadProvider = 'rms';
    return;
  }

  const windowMs = (sileroVad.WINDOW_SAMPLES / sileroVad.SAMPLE_RATE) * 1000;
  STATE.sileroProbSum += prob;
  STATE.sileroProbCount += 1;

  const isVoiced = prob >= config.sileroSpeechThreshold;
  if (process.env.DEBUG_SILERO_WINDOWS) {
    console.log(
      `[SILERO] window probability=${prob.toFixed(4)} threshold=${config.sileroSpeechThreshold} isVoiced=${isVoiced} sileroSegmentHasSpeech=${STATE.sileroSegmentHasSpeech} sileroConsecutiveSilentMs=${STATE.sileroConsecutiveSilentMs} sileroVoicedFrameMsInSegment=${STATE.sileroVoicedFrameMsInSegment}`
    );
  }
  if (isVoiced) {
    markVadOnset();
    STATE.sileroConsecutiveSilentMs = 0;
    STATE.sileroVoicedFrameMsInSegment += windowMs;
    if (STATE.sileroVoicedFrameMsInSegment >= config.minSpeechDuration) {
      STATE.sileroSegmentHasSpeech = true;
    }
  } else {
    STATE.sileroConsecutiveSilentMs += windowMs;
  }

  // AJOUT (Deepgram streaming) : quand le streaming pilote la session, il
  // n'y a plus de segment WAV à "flusher" — Deepgram reçoit déjà l'audio en
  // continu (voir handleAudioData).
  //
  // CORRECTIF (rapport de validation Deepgram livré, phase "endpointing") :
  // ce commentaire disait auparavant que Deepgram "décide lui-même de la
  // fin de phrase (endpointing côté serveur)" — mesuré FAUX en conditions
  // réelles : ni `endpointing` ni `utterance_end_ms`+`vad_events` n'ont
  // finalisé en moins de ~7,5s après la fin réelle de la parole (voir
  // live-tests/endpointing-strategies.js et le rapport livré). C'est donc
  // maintenant CE détecteur Silero (le plus rapide et le plus fiable des
  // deux, déjà réel et testé) qui décide QUAND l'énoncé est terminé, via
  // finalizeStreamingUtteranceLocally() — Deepgram reste la seule source du
  // TEXTE transcrit. Pas de garde minFlushIntervalMs : ce seuil protège le
  // quota Groq, sans objet pour une connexion streaming déjà ouverte.
  if (STATE.deepgramStreamingActive) {
    if (
      STATE.sileroSegmentHasSpeech &&
      STATE.sileroConsecutiveSilentMs >= config.trailingSilenceMs
    ) {
      finalizeStreamingUtteranceLocally();
    }
    return;
  }

  const sinceLastFlushMs = Date.now() - STATE.lastFlushAt;
  if (
    STATE.sileroSegmentHasSpeech &&
    STATE.sileroConsecutiveSilentMs >= config.trailingSilenceMs &&
    sinceLastFlushMs >= config.minFlushIntervalMs
  ) {
    flushSegment(config, { early: true });
  }
}

/**
 * Crée un fichier WAV à partir de données PCM brutes
 * @param {Buffer} pcmData - Données PCM
 * @param {number} sampleRate - Taux d'échantillonnage
 * @param {number} channels - Nombre de canaux
 * @param {number} bitDepth - Bits par échantillon
 * @returns {Buffer} Fichier WAV complet
 */
function createWavFile(pcmData, sampleRate, channels, bitDepth) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Arrête la capture audio (capture navigateur uniquement — plus de process
 * FFmpeg à tuer depuis le remplacement par getUserMedia/Web Audio).
 * @returns {Promise<void>}
 */
function stopRecording() {
  STATE.isRecording = false;
  STATE.browserCaptureConfig = null;
  STATE.audioBuffer = [];
  STATE.frameAccumulator = Buffer.alloc(0);
  STATE.segmentHasSpeech = false;
  STATE.consecutiveSilentFrameMs = 0;
  STATE.voicedFrameMsInSegment = 0;
  STATE.vadProvider = 'rms';
  STATE.sileroStreamState = null;
  STATE.sileroFrameAccumulator = Buffer.alloc(0);
  STATE.sileroQueue = Promise.resolve();
  STATE.sileroConsecutiveSilentMs = 0;
  STATE.sileroVoicedFrameMsInSegment = 0;
  STATE.sileroSegmentHasSpeech = false;
  STATE.sileroProbSum = 0;
  STATE.sileroProbCount = 0;
  // AJOUT (Deepgram streaming) : ferme proprement la session (CloseStream +
  // close WebSocket, voir deepgram-streaming.js) plutôt que de la laisser
  // pendre — isRecording est déjà false ici, donc les handlers onError/
  // onClose ci-dessus (startDeepgramStreamingSession) l'ont déjà repéré et
  // n'essaieront pas de déclencher un repli pour une session qu'on arrête
  // nous-mêmes volontairement.
  if (STATE.deepgramSession) {
    STATE.deepgramSession.finish();
  }
  STATE.deepgramSession = null;
  STATE.deepgramStreamingActive = false;
  STATE.utteranceTracker = null;
  console.log('[audio-capture] Capture arrêtée.');
  cleanupTempFiles({ force: true });
  return Promise.resolve();
}

/**
 * Enregistre les callbacks d'événements
 * @param {Object} callbacks - { onAudioSegment, onError, onPartialTranscript, onFinalTranscript, onAsrFallback }
 */
function on(callbacks) {
  STATE.callbacks = { ...STATE.callbacks, ...callbacks };
}

/**
 * Vérifie si l'enregistrement est en cours
 * @returns {boolean}
 */
function isRecording() {
  return STATE.isRecording;
}

/**
 * Nettoie les fichiers temporaires de manière robuste
 * @param {Object} options - Options de nettoyage
 * @param {boolean} options.force - Force le nettoyage même si l'enregistrement est en cours
 * @param {number} options.maxAgeMs - Âge maximum des fichiers à conserver (défaut: 3 minutes)
 */
function cleanupTempFiles(options = {}) {
  const { force = false, maxAgeMs = 180000 } = options; // 3 minutes par défaut (optimisé)

  if (!fs.existsSync(CONFIG.tempDir)) {
    return;
  }

  // Ne pas nettoyer si l'enregistrement est en cours sauf si force=true
  if (STATE.isRecording && !force) {
    console.log('[audio-capture] Enregistrement en cours, nettoyage partiel uniquement');
  }

  const files = fs.readdirSync(CONFIG.tempDir);
  let cleanedCount = 0;
  let keptCount = 0;
  const now = Date.now();

  files.forEach((file) => {
    const filePath = path.join(CONFIG.tempDir, file);

    try {
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      // Nettoyer les fichiers plus vieux que maxAgeMs ou si force=true
      if (fileAge > maxAgeMs || force) {
        fs.unlinkSync(filePath);
        cleanedCount++;
      } else {
        keptCount++;
      }
    } catch (error) {
      console.warn('[audio-capture] Impossible de supprimer:', filePath, error.message);
    }
  });

  if (cleanedCount > 0) {
    console.log(
      `[audio-capture] ${cleanedCount} fichier(s) temporaire(s) nettoyé(s)${keptCount > 0 ? `, ${keptCount} conservé(s)` : ''}`
    );
  }

  // Tenter de supprimer le répertoire temporaire s'il est vide
  try {
    const remainingFiles = fs.readdirSync(CONFIG.tempDir);
    if (remainingFiles.length === 0) {
      fs.rmdirSync(CONFIG.tempDir);
      console.log('[audio-capture] Répertoire temporaire supprimé (vide)');
    }
  } catch (_error) {
    // Le répertoire n'est pas vide ou ne peut pas être supprimé
  }
}

module.exports = {
  startBrowserCapture,
  feedPcmChunk,
  stopRecording,
  on,
  isRecording,
  cleanupTempFiles,
  getConfig: () => ({ ...CONFIG }),
  // Heuristique de choix de micro — pure, ne dépend plus de FFmpeg. Exposée
  // pour les tests ; setup.html fait son propre choix manuel via l'UI.
  pickBestDevice,
  // AJOUT (VAD réel) — exposées pour tests unitaires (test-audio-capture.js).
  computeRms,
  analyzeVoiceActivity,
  // AJOUT (VAD neuronal — Silero) — diagnostic/tests : quel détecteur pilote
  // la session en cours ('rms' tant que Silero n'a pas fini de charger ou
  // s'il est indisponible/désactivé, voir initVadProvider).
  getVadProvider: () => STATE.vadProvider,
  // AJOUT (Deepgram streaming) — diagnostic/tests.
  getAsrProvider: () => STATE.asrProvider,
  isDeepgramStreamingActive: () => STATE.deepgramStreamingActive,
};
