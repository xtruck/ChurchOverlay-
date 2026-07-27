/**
 * ============================================================================
 *  server.js — Serveur pont WebSocket pour Overlay Versets (Église Mesev)
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.3.0 — Suppression complète de Whisper local
 *    1. whisper-wrapper.js n'est plus chargé du tout : plus aucun code ne
 *       peut démarrer whisper-server.exe (c'était le plus gros
 *       consommateur CPU de l'app, ~40-70% d'un cœur en continu quand il
 *       tournait). Transcription = Groq (cloud) → Deepgram (cloud, si
 *       clé) uniquement, voir groq-wrapper.js.
 *    2. console.log / console.error ne sont plus interceptés dans le
 *       worker : ils partaient déjà en double vers le tableau de bord
 *       (une fois via stdout/stderr piping du Worker, une fois via un
 *       postMessage explicite). Un seul chemin reste : stdout/stderr.
 *
 *  CHANGELOG v0.2.1 — Optimisations de Réactivité (Option A + Bonus)
 *    1. TRANSCRIPT_BUFFER_MAX_CHARS: 200 → 500 (meilleure détection)
 *    2. Audio segments réduits à 5s (via audio-capture.js)
 *
 *  CHANGELOG v0.2.0 — Performance & Stability Repair Plan
 *    1. Runs inside a Worker Thread when spawned by main.js
 *       (worker_threads.isMainThread === false, parentPort available).
 *       Backwards-compatible : still runnable as a stand-alone Node process
 *       via `npm run server-only` — the worker-only wiring is gated on
 *       parentPort.
 *    2. Robust temp-file cleanup on SIGINT / SIGTERM / uncaughtException
 *       / parentPort shutdown.
 *
 *  RÔLE ACTUEL :
 *    Relaie tout message JSON reçu d'un client (ex: test-envoi.js, ou plus
 *    tard le pupitre opérateur / pipeline micro) vers tous les autres clients
 *    connectés — en particulier overlay.html ouvert dans OBS Browser Source.
 *
 *  TRANSCRIPTION (course à 2 niveaux, 100% cloud) :
 *    Groq (Whisper large-v3, cloud) → Deepgram (Nova-2, cloud, si clé
 *    configurée). Sans internet, la transcription s'arrête et
 *    transcriptionError est diffusé — il n'y a plus de filet de secours
 *    local.
 * ============================================================================
 */

'use strict';

const { isMainThread, parentPort, workerData } = require('worker_threads');
const RUNNING_AS_WORKER = !isMainThread && !!parentPort;

// -----------------------------------------------------------------------
// Worker plumbing : forward console output + graceful shutdown via IPC.
// Gated on RUNNING_AS_WORKER so `node server.js` behaviour is unchanged.
// -----------------------------------------------------------------------
if (RUNNING_AS_WORKER) {
  // CORRECTIF v0.3.0 — logs dupliqués dans le tableau de bord :
  // main.js crée ce Worker avec { stdout: true, stderr: true }, ce qui
  // capture déjà TOUT ce que console.log/warn/error écrit (via
  // worker.stdout / worker.stderr). Un ancien correctif ajoutait EN PLUS
  // un postMessage({ type: 'log', ... }) explicite pour chaque appel —
  // main.js traitait donc les deux, affichant chaque ligne deux fois.
  // On ne garde ici que ce qui n'est pas déjà couvert par stdout/stderr :
  // le canal de statut (status: running/stopped/error) et l'arrêt propre.
  // console.log/warn/error ne sont plus interceptés du tout : le
  // comportement par défaut du Worker (piping vers stdout/stderr) suffit.

  // Graceful shutdown from main.js — triggers the same cleanup path as SIGINT.
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      console.log('\n[server] Message d\'arrêt reçu du thread principal (IPC).');
      process.emit('SIGINT');
    }
    // Ajouté à l'audit : theme-loader.js était déjà branché au dashboard
    // (choix du thème), mais rien ne relayait le changement jusqu'à
    // overlay.html en direct. main.js envoie ce message dès que
    // themeLoader.setActiveTheme() réussit ; on le rediffuse tel quel à
    // tous les overlays connectés (aucun redémarrage du pipeline requis).
    if (msg && msg.type === 'theme-changed' && msg.css) {
      broadcast({ action: 'applyTheme', ...msg.css });
    }
    // CORRECTIF (audit — remplacement de FFmpeg par la capture navigateur) :
    // dashboard.html capture le micro (getUserMedia + Web Audio, seul
    // endroit avec un accès micro qui ne dépend pas de DirectShow) et pousse
    // ses chunks PCM16LE ici via main.js. On les fait passer par exactement
    // la même segmentation que l'ancien flux FFmpeg (voir feedPcmChunk()
    // dans audio-capture.js) — aucune autre partie du pipeline (VAD, écriture
    // WAV, transcription Groq/Deepgram) n'a besoin de changer.
    if (msg && msg.type === 'audio-pcm-chunk' && msg.buffer) {
      try {
        audioCapture.feedPcmChunk(Buffer.from(msg.buffer));
      } catch (err) {
        console.error('[server] Erreur traitement chunk audio:', err.message);
      }
    }
    // AJOUT (audit — gating par état OBS, inspiré du protocole
    // obs-websocket). Relayé par main.js (voir obs-controller.js /
    // setupGating) chaque fois que la scène OBS en direct ou l'état
    // stream/enregistrement change. `obsGateOpen` est lu juste avant
    // l'appel Groq/Deepgram dans audioCapture.on({ onAudioSegment }) plus
    // bas — fermé, le segment audio est jeté SANS appel API (c'est
    // l'économie réelle recherchée, pas seulement l'affichage).
    if (msg && msg.type === 'obs-gate-changed') {
      obsGateOpen = !!msg.open;
      console.log(`[server] Gating OBS : transcription ${obsGateOpen ? 'RÉACTIVÉE' : 'MISE EN PAUSE'} (${msg.reason || ''})`);
      broadcast({ action: 'obsGateChanged', open: obsGateOpen, reason: msg.reason || null, timestamp: Date.now() });
    }
  });
}

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const groq = require('./groq-wrapper');
const deepgram = require('./deepgram-wrapper');
const audioCapture = require('./audio-capture');
const detector = require('./detector');
const detectorEn = require('./detector-en');

// Détection bilingue : on essaie d'abord le FR (détecteur historique le plus
// éprouvé), puis EN en fallback. Renvoie la première référence trouvée avec
// la langue qui l'a captée (utile pour les logs et l'analytics).
function detectBilingual(text) {
  const fr = detector.detect(text);
  if (fr) return { ...fr, detectedLang: 'fr' };
  const en = detectorEn.detect(text);
  if (en) return { ...en, detectedLang: 'en' };
  return null;
}
const bibleLookup = require('./bible-lookup-with-api');

// AJOUT (audit — cache de versets persistant, inspiré de Rhema) : en mode
// Worker (app Electron), on utilise le même dossier userData que le reste
// de la config (config.json, audio-devices.cache.json). En usage standalone
// (`node server.js` / `npm run server-only`, sans Electron), on retombe sur
// un dossier caché dans le profil utilisateur — ce module ne doit dépendre
// d'aucune API Electron pour rester utilisable hors app packagée.
bibleLookup.setCacheDir(
  RUNNING_AS_WORKER && workerData && workerData.userDataDir
    ? workerData.userDataDir
    : path.join(require('os').homedir(), '.churchoverlay')
);

const { createContextTracker } = require('./context-tracker');
const { validateAndSanitize } = require('./validation');
const { createRateLimiter } = require('./rate-limiter');
const { validateSystemConfig, displayValidationResults } = require('./config-validator');
const themeLoader = require('./theme-loader');
// CORRECTIF (audit round 5) : le worker doit lire le thème actif choisi par
// l'utilisateur (écrit dans userData par main.js), pas seulement celui livré
// dans app.asar — sinon l'overlay repartait sur le thème d'origine à chaque
// (re)connexion, même après un changement depuis le tableau de bord.
if (RUNNING_AS_WORKER && workerData && workerData.userDataDir) {
  themeLoader.setUserDataDir(workerData.userDataDir);
}
const { ReadingMode } = require('./reading-mode'); // AJOUT (audit — inspiré de Rhema)

const verseTracker = createContextTracker();
const rateLimiter = createRateLimiter({
  maxConnections: process.env.MAX_CONNECTIONS || 10,
  maxMessagesPerMinute: process.env.MAX_MESSAGES_PER_MINUTE || 60
});

let wss = null;

// --- Buffer de transcription glissant ---------------------------------
// OPTIMISÉ v0.2.1 : 200 → 500 caractères pour meilleure détection
const { createSentenceBuffer } = require('./sentence-buffer');

// --- Buffer de transcription glissant ---------------------------------
// OPTIMISÉ v0.2.1 : 200 → 500 caractères pour meilleure détection
// CORRECTIF (chantier "sentence buffer") : voir sentence-buffer.js pour
// l'historique du bug (reset systématique à chaque segment, qui annulait
// l'accumulation glissante). Logique désormais extraite dans son propre
// module, testable indépendamment de server.js.
const transcript = createSentenceBuffer({ maxChars: 500, gapMs: 4000 });
function pushToBuffer(text) { return transcript.push(text); }
function resetBuffer() { transcript.reset(); }

// --- Duplicate segment prevention --------------------------------------
const processedSegments = new Set();
const MAX_PROCESSED_SEGMENTS = 50;
function isDuplicateSegment(segmentFile) {
  const segmentId = segmentFile.split(/[\\/]/).pop().replace('.wav', '');
  if (processedSegments.has(segmentId)) return true;
  processedSegments.add(segmentId);
  if (processedSegments.size > MAX_PROCESSED_SEGMENTS) {
    const firstKey = processedSegments.values().next().value;
    processedSegments.delete(firstKey);
  }
  return false;
}

// CORRECTIF (audit) — Les erreurs (transcriptionError, pipelineError,
// audioCaptureError, lookupError) n'étaient diffusées QUE vers les clients
// WebSocket (overlay.html, test-envoi.js). Le tableau de bord (dashboard.html)
// ne les recevait jamais autrement que noyées dans le flux de logs bruts —
// invisibles en pratique pour l'équipe régie (non-technique). On notifie
// maintenant explicitement main.js via l'IPC du Worker, qui pousse une
// alerte visible (bannière) au tableau de bord. Sans effet si lancé en
// standalone (`node server.js`), RUNNING_AS_WORKER étant alors false.
function notifyAlert(code, severity, message) {
  if (!RUNNING_AS_WORKER) return;
  try {
    parentPort.postMessage({ type: 'alert', code, severity, message, timestamp: Date.now() });
  } catch (_) {}
}

function broadcast(payload, except) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

console.log(
  deepgram.isConfigured()
    ? '[server] Deepgram configuré — course Groq → Deepgram.'
    : '[server] Deepgram non configuré — Groq uniquement.'
);

// Config validation puis démarrage
console.log('[server] Validation de la configuration...');
validateSystemConfig()
  .then(configValidation => {
    displayValidationResults(configValidation);
    if (!configValidation.valid) {
      console.error('[server] Erreur de configuration critique. Arrêt du serveur.');
      workerSafeExit(1);
      return;
    }
    const PORT = configValidation.config.PORT;
    console.log(`[server] Configuration validée, démarrage sur le port ${PORT}`);
    startServer(PORT);
  })
  .catch(error => {
    console.error('[server] Erreur lors de la validation de la configuration:', error.message);
    workerSafeExit(1);
  });

// Langue d'affichage : 'fr', 'en', ou 'both' (FR + EN empilés dans l'overlay).
// Piloté par le dashboard (message setLanguage) ; défaut = 'fr' pour rester
// compatible avec l'existant. Peut aussi être forcé via variable d'env.
let displayLanguage = (process.env.DISPLAY_LANGUAGE || 'fr').toLowerCase();
if (!['fr', 'en', 'both'].includes(displayLanguage)) displayLanguage = 'fr';
console.log(`[server] Langue d'affichage initiale : ${displayLanguage}`);

// Historique en mémoire des N derniers versets diffusés (auto + manuel).
// Utilisé par le dashboard pour la re-diffusion rapide ("rejouer un verset").
// Non persisté sur disque : c'est un buffer volatil, cleared au restart, ce
// qui évite de conserver du contenu bibliophonique après plusieurs services.
const HISTORY_MAX = 30;
const verseHistory = [];
function pushHistory(entry) {
  // Dédoublonnage : si la même référence est ajoutée coup sur coup on remonte
  // simplement l'entrée existante en tête au lieu d'entasser des doublons.
  const key = `${entry.reference}|${entry.langMode || 'fr'}`;
  const idx = verseHistory.findIndex((e) => `${e.reference}|${e.langMode || 'fr'}` === key);
  if (idx !== -1) verseHistory.splice(idx, 1);
  verseHistory.unshift({ ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  if (verseHistory.length > HISTORY_MAX) verseHistory.length = HISTORY_MAX;
}

// -----------------------------------------------------------------------
// AJOUT (audit — Reading Mode, inspiré de Rhema).
// -----------------------------------------------------------------------
// Une fois une référence explicite détectée ("Jean 3, verset 16"), on
// charge tout le chapitre et on compare ensuite chaque nouveau fragment
// transcrit (chevauchement de mots) aux versets suivants — l'affichage
// avance donc automatiquement pendant la lecture d'un passage à voix
// haute, sans qu'il faille répéter la référence à chaque verset.
//
// Diffuse le même format de payload ({action:'showVerse', ...}) que le
// chemin de détection classique (processTranscript ci-dessous), pour que
// overlay.html et dashboard.html n'aient RIEN à changer pour en bénéficier.
async function handleReadingModeAdvance(verse) {
  const refLabel = bibleLookup.buildReferenceLabel(
    { book: readingMode.book, chapter: readingMode.chapter, verseStart: verse.num },
    displayLanguage === 'en' ? 'en' : 'fr'
  );
  const lang = displayLanguage === 'en' ? 'en' : 'fr'; // voir note sur getChapterVerses() : pas de mode 'both' en reading mode
  const payload = {
    action: 'showVerse',
    reference: refLabel,
    text: verse.text,
    text_fr: lang === 'fr' ? verse.text : null,
    text_en: lang === 'en' ? verse.text : null,
    langMode: lang,
    provider: 'reading-mode',
    durationMs: 300000,
    autoDetected: true,
    readingMode: true, // permet à l'overlay de distinguer une avancée automatique d'une nouvelle citation, si besoin
  };
  broadcast(payload);
  pushHistory({
    reference: refLabel, text: verse.text,
    text_fr: payload.text_fr, text_en: payload.text_en, langMode: lang,
    provider: 'reading-mode', autoDetected: true, timestamp: Date.now(),
  });
  broadcast({ action: 'historyUpdated', history: verseHistory });
  console.log(`[server] Reading mode — avancée automatique : ${refLabel}`);
}

// Dernière citation reconnue par findByQuotedText() (référence + horodatage),
// utilisée par processTranscript() pour ignorer la même citation répétée à
// moins de 30s d'intervalle.
let lastQuoteMatch = null;

const readingMode = new ReadingMode({
  // Un seul appel réseau par chapitre : getChapterVerses() réutilise le
  // même chapterCache que la détection classique (voir bible-lookup-with-api.js).
  getChapterVerses: (book, chapter) => bibleLookup.getChapterVerses(book, chapter, displayLanguage === 'en' ? 'en' : 'fr'),
  onVerseAdvance: handleReadingModeAdvance,
});

// Désactivation automatique après une période d'inactivité (pause du
// prédicateur, changement de sujet non annoncé...) pour éviter que le mode
// reste "collé" sur un ancien chapitre et fausse la comparaison par
// chevauchement de mots sur un texte sans rapport.
const READING_MODE_IDLE_TIMEOUT_MS = 90 * 1000;
let readingModeLastActivity = 0;
function touchReadingModeActivity() { readingModeLastActivity = Date.now(); }
setInterval(() => {
  if (readingMode.active && Date.now() - readingModeLastActivity > READING_MODE_IDLE_TIMEOUT_MS) {
    console.log('[server] Reading mode désactivé (inactivité)');
    readingMode.stop();
  }
}, 15000);

async function processTranscript(text) {
  console.log('[server] Processing transcript:', text.substring(0, 100));

  // AJOUT (audit — inspiré de Rhema, changement de traduction à la voix) :
  // vérifié AVANT la détection de référence — une phrase comme "passons en
  // Darby" ne doit jamais être interprétée comme une tentative (ratée) de
  // citer un verset.
  const translationSwitch = detector.detectTranslationSwitch(text);
  if (translationSwitch) {
    try {
      bibleLookup.setTranslation('fr', translationSwitch.code);
      const label = translationSwitch.code === 'darby' ? 'Darby' : 'Louis Segond 1910';
      console.log(`[server] Traduction changée à la voix : ${label}`);
      broadcast({
        action: 'translationChanged', language: 'fr', code: translationSwitch.code,
        translationId: bibleLookup.getTranslationId('fr'), translations: bibleLookup.listTranslations(),
        triggeredByVoice: true, timestamp: Date.now(),
      });
    } catch (err) {
      console.warn('[server] Échec changement de traduction à la voix:', err.message);
    }
    return; // une commande de changement de traduction n'est pas un verset
  }

  const reference = detectBilingual(text);
  if (!reference) {
    // AJOUT (audit — inspiré de Rhema, détection par citation) : personne
    // n'a cité de référence explicite ("Jean 3:16"), mais le texte lu
    // correspond peut-être mot pour mot à un verset déjà vu par le passé
    // (voir findByQuotedText()/cache disque persistant). Couverture
    // nécessairement partielle : ne fonctionne QUE pour des versets déjà
    // consultés une fois (via référence explicite ou citation précédente) —
    // ce n'est pas une recherche sémantique sur toute la Bible comme Rhema,
    // mais ça couvre le cas réel le plus fréquent (versets récurrents).
    // AJOUT (audit — Reading Mode, inspiré de Rhema) : aucune référence
    // explicite dans ce segment — si un chapitre est en cours de lecture
    // suivie, on tente d'abord l'avancement automatique verset par verset
    // (chevauchement de mots) avant de retomber sur la détection par
    // citation ci-dessous (qui, elle, ne reconnaît que des versets déjà
    // vus une fois via une référence explicite précédente).
    if (readingMode.active) {
      touchReadingModeActivity();
      const rm = readingMode.processFragment(text);

      if (rm && rm.command === 'nextChapter') {
        resetBuffer(); // fragment "chapitre suivant" consommé, voir note plus bas
        try {
          const book = readingMode.book;
          const nextChapter = readingMode.chapter + 1;
          await readingMode.start(book, nextChapter);
          await handleReadingModeAdvance(readingMode.verses[readingMode.currentIndex]);
        } catch (err) {
          console.warn('[server] Reading mode : impossible de charger le chapitre suivant:', err.message);
        }
        return;
      }

      if (rm) {
        // Verset avancé (diffusion déjà faite par onVerseAdvance) ou
        // toujours sur le même verset (rien de nouveau à diffuser) : dans
        // les deux cas ce fragment est "consommé" par le reading mode, on
        // ne retombe pas sur la détection par citation plus bas.
        // CORRECTIF (audit — même bug que ci-dessus pour la détection
        // explicite) : sans ce reset, le texte déjà consommé par le
        // reading mode resterait dans la fenêtre glissante et fausserait
        // la comparaison par chevauchement de mots du fragment SUIVANT
        // (le nouveau texte se retrouverait mélangé à l'ancien).
        resetBuffer();
        return;
      }
      // rm === null : aucun chevauchement suffisant avec les versets
      // suivants pour ce fragment — on laisse une chance à la détection
      // par citation ci-dessous (le locuteur a peut-être changé de sujet
      // sans le signaler explicitement).
    }

    const quoted = bibleLookup.findByQuotedText(text);
    if (!quoted) { console.log('[server] No reference detected in segment'); return; }

    // Anti-répétition dédiée (indépendante de verseTracker, qui attend un
    // objet {book,chapter,verseStart} — une citation ne fournit qu'un
    // libellé de référence déjà résolu) : on ignore la même citation si
    // elle a déjà été affichée il y a moins de 30s (lecture continue du
    // même verset par le locuteur, par exemple en le répétant pour insister).
    const now = Date.now();
    if (lastQuoteMatch && lastQuoteMatch.reference === quoted.reference && (now - lastQuoteMatch.ts) < 30000) {
      console.log('[server] Citation déjà affichée récemment, ignorée:', quoted.reference);
      return;
    }
    lastQuoteMatch = { reference: quoted.reference, ts: now };

    console.log(`[server] Citation détectée (score ${quoted.score.toFixed(2)}) :`, quoted.reference);
    resetBuffer(); // CORRECTIF (audit) : même raison que pour la détection explicite ci-dessous
    broadcast({ action: 'candidateVerse', reference: { label: quoted.reference }, transcript: text, matchedByQuote: true, timestamp: now });

    const payload = {
      action: 'showVerse', reference: quoted.reference, text: quoted.text,
      text_fr: quoted.lang === 'fr' ? quoted.text : null, text_en: quoted.lang === 'en' ? quoted.text : null,
      langMode: quoted.lang, provider: quoted.provider,
      durationMs: 300000, autoDetected: true, matchedByQuote: true,
    };
    broadcast(payload);
    pushHistory({
      reference: quoted.reference, text: quoted.text,
      text_fr: payload.text_fr, text_en: payload.text_en, langMode: quoted.lang,
      provider: quoted.provider, autoDetected: true, matchedByQuote: true, timestamp: now,
    });
    broadcast({ action: 'historyUpdated', history: verseHistory });
    console.log('[server] Verset (citation) envoyé à l\'overlay :', quoted.reference);
    return;
  }
  console.log('[server] Reference detected:', JSON.stringify(reference));

  // CORRECTIF (audit — bug latent révélé par l'intégration du Reading Mode) :
  // resetBuffer() existait mais n'était jamais appelé. Le buffer glissant
  // (transcript.js, fenêtre ~500 caractères / 4s) gardait donc le texte
  // "Jean chapitre 3, verset 1" en mémoire APRÈS sa détection, et
  // detectBilingual() le re-matchait à chaque segment suivant tant que la
  // fenêtre ne s'était pas naturellement vidée par silence — bloquant
  // silencieusement toute la branche "aucune référence explicite" (donc le
  // Reading Mode) pendant toute la durée de la fenêtre. Sans effet visible
  // avant le Reading Mode (verseTracker.shouldProcess() absorbait déjà les
  // re-détections en double), mais bloquant maintenant que cette branche a
  // un rôle actif. Une fois une référence complète reconnue, son texte n'a
  // plus rien à apporter à la fenêtre : on la vide pour repartir sur une
  // base propre au prochain segment.
  resetBuffer();

  broadcast({ action: 'candidateVerse', reference, transcript: text, timestamp: Date.now() });

  if (!verseTracker.shouldProcess(reference)) {
    console.log('[server] Reference already processed recently, skipping'); return;
  }
  console.log('[server] Looking up:', bibleLookup.buildReferenceLabel(reference), 'lang:', displayLanguage);

  try {
    const verse = await bibleLookup.getVerseMultilang(reference, displayLanguage);
    const payload = { action: 'showVerse', ...verse, durationMs: 300000, autoDetected: true };
    broadcast(payload);
    pushHistory({
      reference: verse.reference, text: verse.text,
      text_fr: verse.text_fr, text_en: verse.text_en, langMode: verse.langMode,
      provider: verse.provider, autoDetected: true, timestamp: Date.now(),
    });
    broadcast({ action: 'historyUpdated', history: verseHistory });
    console.log('[server] Verse sent to overlay:', verse.reference, `(${displayLanguage})`);
    bibleLookup.resetFailedProviders();

    // AJOUT (audit — Reading Mode, inspiré de Rhema) : référence explicite
    // confirmée -> on (ré)active le suivi de lecture continue sur ce
    // chapitre. N'importe quelle nouvelle citation "réarme" ainsi le
    // reading mode, y compris pour changer de passage en cours de culte.
    try {
      await readingMode.start(reference.book, reference.chapter, reference.verseStart);
      touchReadingModeActivity();
      console.log(`[server] Reading mode activé : ${reference.book} ${reference.chapter}`);
    } catch (err) {
      // Non bloquant : le verset a quand même été affiché normalement,
      // seul le suivi automatique des versets suivants ne sera pas actif
      // pour ce chapitre (ex: chapitre indisponible chez les 2 fournisseurs).
      console.warn('[server] Reading mode : activation impossible:', err.message);
    }
  } catch (error) {
    console.warn('[server] Bible lookup unavailable:', error.message);
    broadcast({
      action: 'showVerse',
      reference: bibleLookup.buildReferenceLabel(reference),
      text: '(Texte non disponible - vérifiez la connexion internet)',
      provider: 'error', durationMs: 300000, autoDetected: true,
    });
    broadcast({ action: 'lookupError', reference, error: error.message, timestamp: Date.now() });
    notifyAlert('lookupError', 'warning', `Verset introuvable (${bibleLookup.buildReferenceLabel(reference)}) : ${error.message}`);
  }
}

function startPipeline() {
  console.log('[server] Démarrage du pipeline audio (capture navigateur, sans FFmpeg)…');
  // CORRECTIF (audit — remplacement de FFmpeg) : startRecording() (FFmpeg +
  // DirectShow) échouait purement et simplement à trouver un micro sur
  // certains portables (voir commentaire dans audio-capture.js), quel que
  // soit l'état de FFmpeg lui-même. startBrowserCapture() ne lance plus
  // aucun process externe : elle prépare juste la segmentation, qui
  // recevra ses échantillons PCM du renderer (dashboard.html, via IPC —
  // voir feedPcmChunk() et le message 'audio-pcm-chunk' plus bas) au lieu
  // du stdout d'un ffmpeg -f dshow.
  try {
    audioCapture.startBrowserCapture();
    console.log('[server] Pipeline prêt — en attente des chunks audio du renderer (Groq/Deepgram cloud).');
    // Signale à main.js que le pipeline est prêt à recevoir de l'audio,
    // pour que dashboard.html démarre getUserMedia() au bon moment (pas
    // avant que feedPcmChunk() puisse effectivement traiter les chunks).
    if (RUNNING_AS_WORKER) {
      try { parentPort.postMessage({ type: 'audio-pipeline-ready' }); } catch (_) {}
    }
  } catch (err) {
    pipelineStartFailed(err);
  }
}

function pipelineStartFailed(err) {
  console.error('[server] Erreur lors du démarrage:', err.message);
  console.error('[server] Le serveur continuera sans Speech-to-Text');
  broadcast({ action: 'pipelineError', error: err.message, timestamp: Date.now() });
  notifyAlert('pipelineError', 'error', `Le pipeline n'a pas démarré : ${err.message}`);
}

audioCapture.on({
  onAudioSegment: async (segmentFile) => {
    console.log('[server] Segment audio reçu — traitement…');

    if (isDuplicateSegment(segmentFile)) {
      console.log('[server] Segment déjà traité, ignoré:', segmentFile);
      safeUnlink(segmentFile);
      return;
    }

    // AJOUT (audit — gating par état OBS, inspiré du protocole
    // obs-websocket). Vérifié ICI, avant l'appel Groq/Deepgram — pas après
    // coup sur le texte transcrit — car c'est l'appel API lui-même (payant,
    // par segment) que l'on veut éviter, pas seulement son affichage.
    if (!obsGateOpen) {
      console.log('[server] Segment ignoré (transcription en pause — gating OBS).');
      safeUnlink(segmentFile);
      return;
    }

    try {
      const result = await groq.transcribeWithFallback(segmentFile);
      console.log('[server] Transcription (%s):', result.source, result.text || '(sans texte)');

      broadcast({ action: 'transcript', text: result.text || '', source: result.source, timestamp: Date.now() });

      const windowed = pushToBuffer(result.text || '');
      await processTranscript(windowed);

      safeUnlink(segmentFile);
    } catch (error) {
      console.error('[server] Erreur lors de la transcription:', error.message);
      broadcast({ action: 'transcriptionError', error: error.message, timestamp: Date.now() });
      notifyAlert('transcriptionError', 'warning',
        `Transcription indisponible (Groq + Deepgram) : ${error.message}. La détection automatique de versets est interrompue jusqu'au retour du réseau.`);
      safeUnlink(segmentFile);
    }
  },
  // NOTE (audit backend/pipeline) : audio-capture.js n'appelle plus jamais
  // ce callback depuis le passage à la capture navigateur (getUserMedia) —
  // startBrowserCapture()/feedPcmChunk() ne lèvent aucune erreur applicative
  // aujourd'hui. On le garde branché par sécurité (filet de secours si un
  // futur chemin d'erreur y était rajouté dans audio-capture.js), avec un
  // message qui ne présuppose plus FFmpeg.
  onError: (error) => {
    console.error('[server] Erreur capture audio:', error.message);
    broadcast({ action: 'audioCaptureError', error: error.message, timestamp: Date.now() });
    notifyAlert('audioCaptureError', 'error', `Problème de capture audio : ${error.message}`);
  },
});

/** Safe temp file cleanup (never throws — every exit path calls this). */
function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (_) { /* already gone or locked */ }
}

// AJOUT (audit — gating par état OBS). `true` par défaut : sans OBS
// connecté ou sans gating.enabled dans la config, la transcription tourne
// exactement comme avant cet ajout — aucun changement de comportement pour
// qui n'a pas explicitement configuré cette fonctionnalité optionnelle.
let obsGateOpen = true;

let compteurClients = 0;

function verifyOrigin(info) {
  const origin = info.origin;
  // Une page HTML chargée en local (overlay.html ouvert directement, sans
  // serveur web devant) n'a pas d'origine web classique. Selon le moteur du
  // navigateur, cette absence d'origine est signalée différemment :
  //   - Chrome/Edge/Firefox classiques -> origin === undefined
  //   - La plupart des Chromium         -> origin === 'null' (chaîne littérale)
  //   - CEF (moteur d'OBS Studio "Source Navigateur")
  //                                     -> origin === 'file://' (littéral)
  // Les trois cas correspondent au même scénario légitime (fichier local,
  // pas un site web tiers) : on les accepte tous les trois. C'est ce
  // dernier cas (CEF/OBS) qui manquait, causant un rejet en boucle de la
  // connexion WebSocket dès qu'overlay.html est ajouté comme Source
  // Navigateur "Fichier local" dans OBS.
  return origin === undefined || origin === 'null' || origin === 'file://';
}

function startServer(PORT) {
  const HOST = process.env.WS_HOST || '127.0.0.1';
  wss = new WebSocket.Server({
    host: HOST,
    port: PORT,
    verifyClient: (info) => {
      const allowed = verifyOrigin(info);
      if (!allowed) console.warn(`[server] Connexion refusée : origine non autorisée ("${info.origin}")`);
      return allowed;
    },
  }, () => {
    startPipeline();
    console.log('[server] Serveur WebSocket démarré sur ws://' + HOST + ':' + PORT);
    console.log('[server] En attente de connexions (overlay.html dans OBS, test-envoi.js, ...).');
    if (RUNNING_AS_WORKER) {
      try { parentPort.postMessage({ type: 'status', status: 'running' }); } catch (_) {}
    }
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('[server] Client stale détecté, déconnexion forcée');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws) => {
    const connectionCheck = rateLimiter.checkConnection(ws);
    if (!connectionCheck.allowed) {
      console.warn('[server] Connexion rejetée:', connectionCheck.reason);
      ws.send(JSON.stringify({ action: 'error', error: connectionCheck.reason }));
      ws.close();
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    compteurClients++;
    const idClient = compteurClients;
    console.log('[server] Client #' + idClient + ' connecté. (' + wss.clients.size + ' client(s) au total)');

    // Ajouté à l'audit : sans ça, un overlay qui se (re)connecte (ex: OBS
    // relance la Source Navigateur) repartait toujours sur le thème CSS en
    // dur d'overlay.html, pas sur le thème actif choisi dans le dashboard.
    try {
      const activeTheme = themeLoader.getActiveTheme();
      ws.send(JSON.stringify({ action: 'applyTheme', ...themeLoader.themeToCss(activeTheme) }));
    } catch (e) {
      console.warn('[server] Impossible d\'envoyer le thème initial au client #' + idClient + ':', e.message);
    }

    ws.on('message', async (data) => {
      const messageCheck = rateLimiter.checkMessage(ws);
      if (!messageCheck.allowed) {
        console.warn('[server] Message rejeté pour client #' + idClient + ':', messageCheck.reason);
        ws.send(JSON.stringify({ action: 'error', error: messageCheck.reason }));
        return;
      }

      const message = data.toString();
      let parsed;
      try { parsed = JSON.parse(message); }
      catch (e) {
        console.warn('[server] Message ignoré du client #' + idClient + ' (JSON invalide) :', message);
        ws.send(JSON.stringify({ action: 'error', error: 'Format JSON invalide' }));
        return;
      }

      const validation = validateAndSanitize(parsed);
      if (!validation.valid) {
        console.warn('[server] Message rejeté du client #' + idClient + ' :', validation.error);
        ws.send(JSON.stringify({ action: 'error', error: validation.error }));
        return;
      }

      const sanitized = validation.sanitized;
      console.log('[server] Message validé depuis client #' + idClient + ' :', sanitized.action);

      if (sanitized.action === 'diagnostic') {
        const diagnostics = {
          action: 'diagnosticResult',
          timestamp: Date.now(),
          modules: {
            detector: !!detector, bibleLookup: !!bibleLookup,
            groq: !!groq, audioCapture: !!audioCapture,
          },
          providers: bibleLookup.getProviders(),
          cacheSize: bibleLookup.getCacheSize ? bibleLookup.getCacheSize() : 'unknown',
          connections: wss.clients.size,
          transcriptBuffer: transcript.length(),
        };
        try {
          const testResult = await bibleLookup.getVerse({ book: 'jean', chapter: 3, verseStart: 16 });
          diagnostics.bibleApiTest = {
            success: true,
            text: testResult.text.substring(0, 100) + '...',
            provider: testResult.provider,
          };
        } catch (error) {
          diagnostics.bibleApiTest = { success: false, error: error.message };
        }
        ws.send(JSON.stringify(diagnostics));
        return;
      }

      if (sanitized.action === 'setLanguage') {
        const requested = String(sanitized.language || '').toLowerCase();
        if (!['fr', 'en', 'both'].includes(requested)) {
          ws.send(JSON.stringify({ action: 'error', error: 'Langue invalide (fr | en | both).' }));
          return;
        }
        displayLanguage = requested;
        console.log(`[server] Langue d'affichage changée : ${displayLanguage}`);
        broadcast({ action: 'languageChanged', language: displayLanguage, timestamp: Date.now() });
        return;
      }

      if (sanitized.action === 'setTranslation') {
        try {
          const lang = String(sanitized.language).toLowerCase();
          const code = String(sanitized.code);
          const newId = bibleLookup.setTranslation(lang, code);
          console.log(`[server] Traduction ${lang} changée : ${newId}`);
          broadcast({
            action: 'translationChanged', language: lang, code,
            translationId: newId, translations: bibleLookup.listTranslations(),
            timestamp: Date.now(),
          });
        } catch (e) {
          ws.send(JSON.stringify({ action: 'error', error: e.message }));
        }
        return;
      }

      if (sanitized.action === 'getState') {
        ws.send(JSON.stringify({
          action: 'state',
          language: displayLanguage,
          translations: bibleLookup.listTranslations(),
          history: verseHistory,
        }));
        return;
      }

      if (sanitized.action === 'getHistory') {
        ws.send(JSON.stringify({ action: 'history', history: verseHistory }));
        return;
      }

      if (sanitized.action === 'replayVerse') {
        const entry = verseHistory.find((e) => e.id === sanitized.id);
        if (!entry) {
          ws.send(JSON.stringify({ action: 'error', error: 'Verset introuvable dans l\'historique.' }));
          return;
        }
        // Rediffusion à l'identique — pas de nouvelle requête réseau (déjà en cache),
        // et on ne re-pousse pas dans l'historique (ce serait un doublon).
        broadcast({
          action: 'showVerse',
          reference: entry.reference, text: entry.text,
          text_fr: entry.text_fr, text_en: entry.text_en, langMode: entry.langMode,
          provider: entry.provider, durationMs: Number(sanitized.durationMs) || 300000,
          replayed: true,
        });
        console.log('[server] Verset rejoué :', entry.reference);
        return;
      }

      if (sanitized.action === 'lookupReference') {
        const reference = detectBilingual(sanitized.reference || '');
        if (!reference) {
          ws.send(JSON.stringify({ action: 'lookupError', error: 'Référence biblique non reconnue.' }));
          return;
        }
        try {
          const lang = ['fr', 'en', 'both'].includes(String(sanitized.language || '').toLowerCase())
            ? String(sanitized.language).toLowerCase()
            : displayLanguage;
          const verse = await bibleLookup.getVerseMultilang(reference, lang);
          broadcast({ action: 'showVerse', ...verse, durationMs: Number(sanitized.durationMs) || 300000 }, ws);
          pushHistory({
            reference: verse.reference, text: verse.text,
            text_fr: verse.text_fr, text_en: verse.text_en, langMode: verse.langMode,
            provider: verse.provider, autoDetected: false, timestamp: Date.now(),
          });
          broadcast({ action: 'historyUpdated', history: verseHistory });
        } catch (error) {
          ws.send(JSON.stringify({ action: 'lookupError', reference, error: error.message }));
        }
        return;
      }

      const sanitizedMessage = JSON.stringify(sanitized);
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(sanitizedMessage);
      });
    });

    ws.on('close', () => {
      rateLimiter.removeConnection(ws);
      console.log('[server] Client #' + idClient + ' déconnecté. (' + wss.clients.size + ' client(s) restant(s))');
    });
    ws.on('error', (err) => console.error('[server] Erreur sur le client #' + idClient + ' :', err.message));
  });

  wss.on('error', (err) => {
    console.error('[server] Erreur serveur :', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('[server] Le port est déjà utilisé — une autre instance de l\'app tourne-t-elle déjà ?');
    }
    // CORRECTIF : avant, une erreur de bind (ex: EADDRINUSE) restait un
    // simple log — le worker ne passait jamais à 'running' ET ne notifiait
    // jamais 'error' non plus, donc main.js/le dashboard restaient bloqués
    // indéfiniment sur "connexion...". On force maintenant un arrêt propre
    // + notification 'error' pour que le dashboard sorte de cet état figé.
    shutdownOnce();
  });

  // --- Cleanup on EVERY exit path ----------------------------------------
  const shutdownOnce = createOnce(() => shutdown(heartbeat));
  process.on('SIGINT', shutdownOnce);
  process.on('SIGTERM', shutdownOnce);
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err && err.stack || err);
    shutdownOnce();
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason && (reason.stack || reason));
  });
}

function createOnce(fn) {
  let called = false;
  return (...args) => { if (called) return; called = true; try { fn(...args); } catch (_) {} };
}

function shutdown(heartbeat) {
  console.log('\n[server] Arrêt du serveur...');
  if (heartbeat) clearInterval(heartbeat);
  if (rateLimiter && rateLimiter.stopCleanup) rateLimiter.stopCleanup();
  if (wss) {
    try {
      wss.clients.forEach((client) => { try { client.close(1000, 'Server shutting down'); } catch (_) {} });
    } catch (_) {}
  }

  const cleanup = () => {
    try { audioCapture.cleanupTempFiles({ force: true }); } catch (_) {}
    console.log('[server] Nettoyage terminé');
    workerSafeExit(0);
  };

  audioCapture.stopRecording()
    .then(() => {
      console.log('[server] Capture audio arrêtée');
      cleanup();
    })
    .catch((err) => {
      console.error('[server] Erreur lors de l\'arrêt:', err.message);
      cleanup();
    });

  // Absolute deadline — no matter what, we don't hang the worker exit.
  setTimeout(() => {
    console.warn('[server] Deadline d\'arrêt (7s) — sortie forcée après cleanup.');
    try { audioCapture.cleanupTempFiles({ force: true }); } catch (_) {}
    workerSafeExit(0);
  }, 7000).unref?.();
}

/**
 * Under a worker, process.exit() kills only the worker (which is what we
 * want), but we also notify the parent so it can distinguish "stopped
 * cleanly" from "crashed". Under stand-alone Node, this is just process.exit.
 */
function workerSafeExit(code) {
  if (RUNNING_AS_WORKER) {
    try { parentPort.postMessage({ type: 'status', status: code === 0 ? 'stopped' : 'error' }); } catch (_) {}
  }
  process.exit(code);
}
