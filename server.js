/**
 * ============================================================================
 * server.js — Pipeline audio → transcription cloud → détection de référence
 * biblique → overlay en temps réel (WebSocket)
 * ----------------------------------------------------------------------------
 * v1.1.0 — SECURITY HARDENED:
 *   + Role-based access control (operator vs viewer)
 *   + Origin validation for non-localhost binds
 *   + Per-message-type rate limiting
 *   + Prompt injection filtering for all LLM-bound text
 *   + WS_AUTH_TOKEN minimum length enforcement (16 chars)
 *   + File permissions on temp audio files (0o600)
 * ============================================================================
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Environment & paths
// ---------------------------------------------------------------------------
const APP_ROOT = (workerData && workerData.appRoot) || __dirname;
const USER_DATA_DIR =
  (workerData && workerData.userDataDir) || path.join(os.homedir(), '.churchoverlay');

// ---------------------------------------------------------------------------
// Core modules (REQUIRED)
// ---------------------------------------------------------------------------
const audioCapture = require('./audio-capture');
const groq = require('./groq-wrapper');
const deepgramWrapper = require('./deepgram-wrapper');
const configValidator = require('./config-validator');
const { createFileLogger } = require('./logger');
const sessionStore = require('./session-store');

const detector = require('./detector-compat');
const bibleLookup = require('./bible-lookup-with-api');
const { ReadingMode } = require('./reading-mode');
const themeLoader = require('./theme-loader');
// AJOUT (audit — mémoire des cultes, gratuit/léger) : même discipline que
// bible-semantic-search.js — fichier JSON local, recherche par mots-clés,
// aucun modèle d'embedding, aucun appel API. Voir sermon-archive.js.
const sermonArchive = require('./sermon-archive');
const featuresStore = require('./features-store');
const validation = require('./validation');

// ---------------------------------------------------------------------------
// Durée d'affichage des versets — source unique de vérité
// ---------------------------------------------------------------------------
const DEFAULT_VERSE_DURATION_MS = 120_000;
function getVerseDurationMs() {
  const features = featuresStore.readFeatures();
  return (features.display || {}).verseDurationMs || DEFAULT_VERSE_DURATION_MS;
}

// ---------------------------------------------------------------------------
// AI modules (OPTIONAL — wrapped in try-catch, see ai-modules-loader.js)
// ---------------------------------------------------------------------------
const { loadAIModules } = require('./ai-modules-loader');
const {
  semanticDetector,
  detectCommand,
  corrector,
  semanticSearch,
  plugins,
  themeGenerator,
  aiEnricher,
  aiLoadErrors,
  groqHasChatCompletion,
} = loadAIModules({ groq, appRoot: APP_ROOT });

// ---------------------------------------------------------------------------
// HTTP & WebSocket server
// ---------------------------------------------------------------------------
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createRateLimiter } = require('./rate-limiter');

const portValidation = configValidator.validateEnvVar('PORT', process.env.PORT);
if (!portValidation.valid) {
  console.warn(`[server] ${portValidation.error} — utilisation du port par défaut 8765.`);
}
const SERVER_PORT = portValidation.valid ? portValidation.parsedValue : 8765;

const hostValidation = configValidator.validateEnvVar('WS_HOST', process.env.WS_HOST);
let WS_HOST = hostValidation.valid ? hostValidation.parsedValue : '127.0.0.1';

// SECURITY: enforce minimum token length of 16 characters.
// Two independent tokens: WS_AUTH_TOKEN (operator, full control) and
// WS_VIEWER_TOKEN (read-only overlay display). A client's role is now
// determined by WHICH token it presents, not by which URL path it hits —
// the path was previously just a client hint and gave no real isolation.
function loadToken(envVar) {
  let token = (process.env[envVar] || '').trim() || null;
  if (token && token.length < 16) {
    console.error(`[server] ${envVar} too short (minimum 16 characters). Ignored.`);
    token = null;
  }
  return token;
}
const WS_AUTH_TOKEN = loadToken('WS_AUTH_TOKEN');
let WS_VIEWER_TOKEN = loadToken('WS_VIEWER_TOKEN');
if (WS_VIEWER_TOKEN && WS_AUTH_TOKEN && WS_VIEWER_TOKEN === WS_AUTH_TOKEN) {
  console.error('[server] WS_VIEWER_TOKEN must differ from WS_AUTH_TOKEN. Viewer token disabled.');
  WS_VIEWER_TOKEN = null;
}
// Once an operator token is configured, requiring a distinct viewer token
// stops a leaked/shared display-page token from granting operator control.
if (WS_AUTH_TOKEN && !WS_VIEWER_TOKEN && WS_HOST !== '127.0.0.1' && WS_HOST !== 'localhost') {
  console.warn(
    '[server] WS_AUTH_TOKEN is set without WS_VIEWER_TOKEN on a non-local bind — ' +
      'the overlay page will need the operator token to connect, which over-privileges it.'
  );
}

// SECURITY (fail-safe, not just advisory): a non-local WS_HOST with no
// operator token would previously start up "open" — any device on the LAN
// could connect with full operator control (broadcast arbitrary verses,
// clear the display mid-service, hit AI/OBS actions) with zero credential.
// Refuse to bind non-locally without a token instead of just warning.
if (WS_HOST !== '127.0.0.1' && WS_HOST !== 'localhost' && !WS_AUTH_TOKEN) {
  console.error(
    `[server] WS_HOST=${WS_HOST} was requested but WS_AUTH_TOKEN is not set (or is too short). ` +
      'Refusing to expose the WebSocket server without authentication — falling back to ' +
      '127.0.0.1. Set WS_AUTH_TOKEN (>=16 chars) to allow LAN/remote access.'
  );
  WS_HOST = '127.0.0.1';
}

// Active par défaut (recommandé) ; VALIDATE_MESSAGES=false ou 0 désactive
// le contrôle strict de validation.js pour les actions qu'il couvre.
const VALIDATE_MESSAGES_ENABLED = !['false', '0'].includes(
  (process.env.VALIDATE_MESSAGES || '').trim().toLowerCase()
);

const maxConnValidation = configValidator.validateEnvVar(
  'MAX_CONNECTIONS',
  process.env.MAX_CONNECTIONS
);
const MAX_CONNECTIONS = maxConnValidation.valid ? maxConnValidation.parsedValue : 10;

const maxMsgValidation = configValidator.validateEnvVar(
  'MAX_MESSAGES_PER_MINUTE',
  process.env.MAX_MESSAGES_PER_MINUTE
);
const MAX_MESSAGES_PER_MINUTE = maxMsgValidation.valid ? maxMsgValidation.parsedValue : 60;

// CORRECTIF (problème récurrent — transcription qui ne démarre jamais
// malgré des clés API valides) : voir config-validator.js pour le détail.
// Réglable via .env sans toucher au code, pour s'adapter au micro réel du
// lieu de culte plutôt que de garder une valeur jamais calibrée.
const micThresholdValidation = configValidator.validateEnvVar(
  'MIC_SILENCE_THRESHOLD',
  process.env.MIC_SILENCE_THRESHOLD
);
const MIC_SILENCE_THRESHOLD = micThresholdValidation.valid
  ? micThresholdValidation.parsedValue
  : 0.02;

const connRateLimiter = createRateLimiter({
  maxConnections: MAX_CONNECTIONS,
  maxMessagesPerMinute: MAX_MESSAGES_PER_MINUTE,
});

const app = express();
app.use(express.static(APP_ROOT));

// SECURITY: origin validation middleware for non-localhost binds
const ALLOWED_ORIGINS = new Set([
  'file://',
  'null',
  `http://localhost:${SERVER_PORT}`,
  `http://127.0.0.1:${SERVER_PORT}`,
]);

app.get('/', (req, res) => res.sendFile(path.join(APP_ROOT, 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(APP_ROOT, 'dashboard.html')));
app.get('/overlay', (req, res) => res.sendFile(path.join(APP_ROOT, 'overlay.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(APP_ROOT, 'setup.html')));
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    port: SERVER_PORT,
    service: 'ChurchOverlay',
    authEnabled: !!WS_AUTH_TOKEN,
  });
});

// AJOUT (audit — second écran pour l'assemblée, gratuit/léger) : page de
// lecture seule, pensée pour un QR code scanné pendant le culte. Pas de
// jeton WS_AUTH_TOKEN requis ici — contrairement au canal WebSocket, qui
// peut déclencher des actions, cette route ne fait que RELIRE des versets
// déjà projetés publiquement sur l'écran de la salle (même donnée, même
// sensibilité que /api/health, déjà sans authentification).
app.get('/companion', (req, res) => res.sendFile(path.join(APP_ROOT, 'companion.html')));
app.get('/api/verses', (req, res) => {
  res.json({ verses: sessionState.getVerseHistory() });
});

const httpServer = http.createServer(app);
// SECURITY: auth tokens travel via the Sec-WebSocket-Protocol handshake
// header instead of the ?token= query string. Query strings routinely end
// up in reverse-proxy / CDN access logs, browser process lists, and referer
// headers; the WebSocket subprotocol header does not. `handleProtocols`
// must echo back one of the client-offered values or browsers abort the
// handshake, so we echo whichever of the two known tokens was offered (or
// the first offered value, harmlessly, if auth is disabled).
const wss = new WebSocket.Server({
  server: httpServer,
  maxPayload: 64 * 1024,
  handleProtocols: (protocols) => {
    const offered = Array.from(protocols);
    if (offered.includes(WS_AUTH_TOKEN)) return WS_AUTH_TOKEN;
    if (offered.includes(WS_VIEWER_TOKEN)) return WS_VIEWER_TOKEN;
    return offered[0] || false;
  },
});

httpServer.listen(SERVER_PORT, WS_HOST, () => {
  console.log(`[server] Serveur HTTP & WebSocket démarré sur http://${WS_HOST}:${SERVER_PORT}`);
});

httpServer.on('error', (err) => {
  const reason =
    err && err.code === 'EADDRINUSE'
      ? `Le port ${SERVER_PORT} est déjà utilisé par une autre application.`
      : `Erreur du serveur HTTP/WebSocket: ${err && err.message}`;
  console.error('[server] ' + reason);
  if (parentPort) {
    parentPort.postMessage({
      type: 'alert',
      code: 'server-listen-error',
      severity: 'error',
      message: reason,
      timestamp: Date.now(),
    });
  }
  process.exitCode = 1;
  process.exit(1);
});

// ---------------------------------------------------------------------------
// State (voir session-state.js — encapsulé le 2026-08-05, comportement
// identique, accès désormais via des accesseurs plutôt que des `let`
// globaux modifiables depuis n'importe où dans ce fichier)
// ---------------------------------------------------------------------------
const sessionState = require('./session-state');

// Ambient mood — voir startAmbientMoodLoop() plus bas.
let ambientMoodInterval = null;
let lastAmbientTranscriptCount = 0;
let lastAmbientMood = null;

// ---------------------------------------------------------------------------
// Rate limiter (diffusion de versets)
// ---------------------------------------------------------------------------
const broadcastRateLimiter = createRateLimiter({
  maxConnections: 1,
  maxMessagesPerMinute: 50,
  connectionWindowMs: 60_000,
});
const BROADCAST_LIMIT_KEY = { _socket: { remoteAddress: 'internal-broadcast' } };
function isRateLimited() {
  return !broadcastRateLimiter.checkMessage(BROADCAST_LIMIT_KEY).allowed;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
const fileLogger = createFileLogger(path.join(USER_DATA_DIR, 'logs'));

function log(msg) {
  const line = `[server] ${msg}`;
  console.log(line);
  fileLogger.append(line, false);
  if (parentPort) parentPort.postMessage({ type: 'log', text: line, isError: false });
}
function warn(msg) {
  const line = `[server] ${msg}`;
  console.warn(line);
  fileLogger.append(line, true);
  if (parentPort) parentPort.postMessage({ type: 'log', text: line, isError: true });
}

// ---------------------------------------------------------------------------
// Broadcast to all WebSocket clients
// ---------------------------------------------------------------------------
function broadcast(obj) {
  const json = JSON.stringify(obj);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

// ---------------------------------------------------------------------------
// Push to verse history (délègue à session-state.js)
// ---------------------------------------------------------------------------
function pushHistory(entry) {
  sessionState.pushHistory(entry);
  sessionStore.recordVerseShown(entry);
}

// ---------------------------------------------------------------------------
// Reading Mode
// ---------------------------------------------------------------------------
const readingMode = new ReadingMode({
  getChapterVerses: (book, chapter) =>
    bibleLookup.getChapterVersesMultilang(book, chapter, sessionState.getDisplayLanguage()),
  onVerseAdvance: (verse) => {
    const reference = bibleLookup.buildReferenceLabel(
      { book: readingMode.book, chapter: readingMode.chapter, verseStart: verse.num },
      sessionState.getDisplayLanguage()
    );
    broadcast({
      action: 'showVerse',
      reference,
      text: verse.text,
      text_fr: verse.text_fr || null,
      text_en: verse.text_en || null,
      langMode: sessionState.getDisplayLanguage(),
      durationMs: getVerseDurationMs(),
      readingMode: true,
    });
    pushHistory({
      reference,
      text: verse.text.substring(0, 200),
      readingMode: true,
      timestamp: Date.now(),
    });
    broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
  },
});

async function activateReadingMode(book, chapter, verseStart) {
  try {
    await readingMode.start(book, chapter, verseStart);
  } catch (err) {
    warn('Reading mode: activation impossible pour ' + book + ' ' + chapter + ': ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Prompt injection filter for LLM-bound text
// ---------------------------------------------------------------------------
// CORRECTIF (chantier de découpage 2026-08-05) : server.js définissait sa
// propre copie plus faible de sanitizeForPrompt() (moins de patterns, pas
// de neutralisation des triples backticks) alors que semantic-detector.js,
// transcription-corrector.js et ai-enricher.js utilisent déjà le module
// partagé et plus complet prompt-sanitizer.js. Utilise désormais la même
// défense partout — une seule source de vérité.
const { sanitizeForPrompt } = require('./prompt-sanitizer');

// ---------------------------------------------------------------------------
// Update transcript context for AI features (délègue à session-state.js
// pour le stockage ; le lien avec semanticDetector reste ici car c'est une
// dépendance vers un module IA, pas de l'état de session pur)
// ---------------------------------------------------------------------------
function updateTranscriptContext(text) {
  sessionState.updateTranscriptContext(text);
  if (semanticDetector) semanticDetector.addContext(text);
  sessionState.appendFullServiceTranscript(text);
}

function getRecentContext(maxChars = 300) {
  return sessionState.getRecentContext(maxChars);
}

// ===========================================================================
// Ambient mood — reasoning autonome : le serveur réévalue périodiquement le
// TON du sermon (pas une référence biblique précise) sur les derniers
// fragments transcrits et pousse un changement d'ambiance visuelle sur
// l'overlay EN DIRECT, sans validation de l'opérateur — activé volontairement
// (design.autoLiturgicalTheme, voir config/features.json) car décidé avec
// l'utilisateur. Réutilise exactement le même chemin (themeGenerator.generate
// + broadcast applyTheme) que le changement de thème par verset/commande
// vocale, donc aucun nouveau protocole overlay.
// ===========================================================================
function startAmbientMoodLoop() {
  if (!themeGenerator) return;

  const tick = async () => {
    try {
      const features = featuresStore.readFeatures();
      if (!(features.design || {}).autoLiturgicalTheme) return;

      // Ne relance une analyse que s'il y a eu de la nouvelle parole depuis
      // le dernier cycle (silence prolongé = pas de changement d'ambiance).
      const transcriptCount = sessionState.getRecentTranscripts().length;
      if (transcriptCount === lastAmbientTranscriptCount) return;
      lastAmbientTranscriptCount = transcriptCount;

      const context = getRecentContext(500);
      if (!context.trim()) return;

      const theme = await themeGenerator.generate(context, '', 'auto');
      if (!theme) return;

      const mood = themeGenerator.currentMood;
      if (mood === lastAmbientMood) return; // ambiance inchangée : pas de broadcast
      lastAmbientMood = mood;

      log(`Ambient mood: "${theme.name}" (${mood}) — détecté depuis le ton du sermon`);
      broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme), ambient: true });
    } catch (e) {
      warn('Ambient mood loop error: ' + e.message);
    }
  };

  const features = featuresStore.readFeatures();
  const intervalSec = (features.ai || {}).themeDetection?.intervalSec || 60;
  ambientMoodInterval = setInterval(tick, Math.max(15, intervalSec) * 1000);
  if (ambientMoodInterval.unref) ambientMoodInterval.unref();
}

function stopAmbientMoodLoop() {
  if (ambientMoodInterval) {
    clearInterval(ambientMoodInterval);
    ambientMoodInterval = null;
  }
}

// ===========================================================================
// MAIN PIPELINE: processTranscript
// ===========================================================================
async function processTranscript(text) {
  log('Processing transcript: ' + text.substring(0, 100));

  if (plugins) {
    plugins.emit('onTranscript', text).catch(() => {});
  }

  if (detectCommand) {
    try {
      const command = detectCommand(text);
      if (command) {
        log('Voice command detected: ' + command.action);
        await handleVoiceCommand(command, text);
        return;
      }
    } catch (e) {
      warn('Voice command error: ' + e.message);
    }
  }

  let correctedText = text;
  if (corrector) {
    try {
      const mode = groqHasChatCompletion ? 'auto' : 'fast';
      correctedText = await corrector.correct(text, mode);
      if (correctedText !== text) {
        log('Transcription corrected: ' + correctedText.substring(0, 80) + '...');
        broadcast({ action: 'transcriptCorrected', original: text, corrected: correctedText });
      }
    } catch (e) {
      warn('Transcription correction error: ' + e.message);
    }
  }

  updateTranscriptContext(correctedText);

  let reference = null;
  try {
    reference = detector.detectBilingual(correctedText);
  } catch (e) {
    warn('Detector error: ' + e.message);
  }

  if (reference && reference.fuzzy) {
    log(
      `Fuzzy match: "${reference.fuzzyOriginal}" → "${reference.book}" (distance ${reference.fuzzyDistance})`
    );
    broadcast({
      action: 'candidateVerse',
      reference: {
        book: reference.book,
        chapter: reference.chapter,
        verseStart: reference.verseStart,
      },
      original: reference.fuzzyOriginal,
      distance: reference.fuzzyDistance,
    });
  }

  if (!reference && semanticDetector) {
    try {
      const semanticResult = await semanticDetector.detect(correctedText);
      if (semanticResult) {
        reference = semanticResult;
        log(
          `Semantic detection: ${semanticResult.raw} (confidence: ${semanticResult.confidence.toFixed(2)})`
        );
        broadcast({
          action: 'semanticDetected',
          reference: semanticResult.raw,
          confidence: semanticResult.confidence,
          reasoning: semanticResult.reasoning,
          alternativeRefs: semanticResult.alternativeRefs,
        });
      }
    } catch (e) {
      warn('Semantic detection error: ' + e.message);
    }
  }

  let quotedMatch = null;
  if (!reference) {
    try {
      const quoted = bibleLookup.findByQuotedText(correctedText);
      if (quoted && quoted.score >= 0.55) {
        log(`Quote match: ${quoted.reference} (score: ${quoted.score.toFixed(2)})`);
        quotedMatch = quoted;
        reference = { book: '', chapter: 0, verseStart: 0, detectedBy: 'quote' };
      }
    } catch (_e) {}
  }

  if (!reference) {
    if (readingMode.active) {
      try {
        const result = readingMode.processFragment(correctedText);
        if (result && result.command === 'nextChapter') {
          const nextChapter = (readingMode.chapter || 0) + 1;
          const book = readingMode.book;
          await activateReadingMode(book, nextChapter, 1);
          if (readingMode.active && readingMode.currentIndex >= 0) {
            const first = readingMode.verses[readingMode.currentIndex];
            const label = bibleLookup.buildReferenceLabel(
              { book, chapter: nextChapter, verseStart: first.num },
              sessionState.getDisplayLanguage()
            );
            broadcast({
              action: 'showVerse',
              reference: label,
              text: first.text,
              text_fr: first.text_fr || null,
              text_en: first.text_en || null,
              langMode: sessionState.getDisplayLanguage(),
              durationMs: getVerseDurationMs(),
              readingMode: true,
            });
            pushHistory({
              reference: label,
              text: first.text.substring(0, 200),
              readingMode: true,
              timestamp: Date.now(),
            });
            broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
            log('Reading mode: chapitre suivant → ' + label);
          }
        }
      } catch (e) {
        warn('Reading mode processFragment error: ' + e.message);
      }
    }
    return;
  }

  if (isRateLimited()) {
    warn('Rate limit hit — verse display skipped');
    return;
  }

  // CORRECTIF (audit round 9) : pour une détection par citation
  // (`detectedBy: 'quote'`), `reference` est un objet placeholder
  // ({ book: '', chapter: 0, verseStart: 0 }) — la vraie référence n'est
  // connue que via `quotedMatch.reference`. Construire refKey à partir de
  // ces champs vides produisait la même clé "::" pour TOUTE citation
  // reconnue sans référence dite, quel que soit le verset réel. Deux
  // versets différents cités à moins de 30s d'intervalle (cas courant en
  // lecture continue) étaient alors traités comme un doublon : le second
  // verset était silencieusement supprimé sans jamais s'afficher.
  const refKey =
    reference.detectedBy === 'quote' && quotedMatch
      ? `quote:${quotedMatch.reference}`
      : `${reference.book}:${reference.chapter}:${reference.verseStart || ''}`;
  const now = Date.now();
  if (sessionState.isDuplicateReference(refKey, now)) {
    log('Duplicate suppressed: ' + refKey);
    return;
  }
  sessionState.recordShownReference(refKey, now);

  let verse;
  try {
    if (reference.detectedBy === 'quote') {
      const quoted = quotedMatch || bibleLookup.findByQuotedText(correctedText);
      verse = {
        reference: quoted.reference,
        text: quoted.text,
        provider: quoted.provider,
        lang: quoted.lang,
        text_fr: quoted.lang === 'fr' ? quoted.text : null,
        text_en: quoted.lang === 'en' ? quoted.text : null,
        langMode: sessionState.getDisplayLanguage(),
      };
      // Le quote-match ne connaît que le texte tel qu'il a été indexé
      // (une seule langue). En mode bilingue, on retente une résolution
      // structurée de la référence pour obtenir le FR + EN complets.
      if (sessionState.getDisplayLanguage() === 'both') {
        const parsedRef = detector.parseReference(quoted.reference);
        if (parsedRef) {
          try {
            verse = await bibleLookup.getVerseMultilang(parsedRef, 'both');
          } catch (_e) {
            // Garde le fallback mono-langue construit ci-dessus.
          }
        }
      }
    } else {
      // CORRECTIF (audit — "Jean 3 verset 1" affichait tout le chapitre 3) :
      // quand la transcription ne capture pas clairement le numéro de
      // verset (bruit ambiant, parole rapide — la STT n'est jamais
      // parfaite), detector.js retourne une référence "chapitre seul"
      // (verseStart undefined), et bible-lookup-with-api.js traite
      // délibérément ce cas comme "aucun verset précis demandé : renvoyer
      // tout le chapitre" — comportement voulu pour une lecture de
      // chapitre explicite, mais un dump de chapitre entier surprend et
      // submerge l'écran quand ce n'était pas l'intention réelle du
      // prédicateur. Pour la détection AUTOMATIQUE (voix, pas saisie
      // manuelle), on affiche donc verset 1 par défaut si aucun n'a été
      // capté — le mode lecture (activateReadingMode, plus bas) reste
      // ancré sur ce même chapitre et avance verset par verset au fil de
      // la parole, donc rien n'est perdu, juste un premier affichage plus
      // sobre. La saisie manuelle ("Afficher un Verset") n'est pas
      // affectée : un opérateur qui tape "Jean 3" exprès pour une lecture
      // complète obtient toujours le chapitre entier.
      const displayReference = reference.verseStart
        ? reference
        : { ...reference, verseStart: 1, verseEnd: 1 };
      verse = await bibleLookup.getVerseMultilang(
        displayReference,
        sessionState.getDisplayLanguage()
      );
    }
  } catch (err) {
    warn('Bible lookup failed: ' + err.message);
    broadcast({ action: 'error', error: 'Verset introuvable : ' + err.message });
    return;
  }

  if (plugins) {
    plugins.emit('onVerseDetected', { ...verse, reference: verse.reference }).catch(() => {});
  }

  let theme = null;
  if (themeGenerator) {
    try {
      const recentContext = getRecentContext();
      theme = await themeGenerator.generate(verse.text, recentContext, 'auto');
      if (theme && (theme.source === 'ai' || theme.mood !== 'default')) {
        log(`Theme applied: "${theme.name}" (${theme.mood || 'default'})`);
        broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme) });
      }
    } catch (e) {
      warn('Theme generation error: ' + e.message);
    }
  }

  const features = featuresStore.readFeatures();
  const multiScene = (features.broadcast || {}).multiScene || {};
  if (multiScene.enabled && !sessionState.getObsGate().open) {
    log('OBS gate closed — verse buffered: ' + verse.reference);
    broadcast({
      action: 'verseBuffered',
      reference: verse.reference,
      reason: sessionState.getObsGate().reason,
    });
    return;
  }

  const durationMs = getVerseDurationMs();
  broadcast({
    action: 'showVerse',
    reference: verse.reference,
    text: verse.text,
    text_fr: verse.text_fr || null,
    text_en: verse.text_en || null,
    langMode: verse.langMode,
    provider: verse.provider,
    durationMs,
    detectedBy: reference.detectedBy || 'regex',
    matchedByQuote: reference.detectedBy === 'quote',
    theme: theme ? { name: theme.name, mood: theme.mood } : null,
  });

  pushHistory({
    reference: verse.reference,
    text: verse.text.substring(0, 200),
    timestamp: now,
    detectedBy: reference.detectedBy || 'regex',
  });
  broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });

  if (plugins) {
    plugins.emit('onVerseShown', { ...verse, reference: verse.reference }).catch(() => {});
  }

  log('Displayed: ' + verse.reference);

  if (reference.book && reference.chapter) {
    await activateReadingMode(reference.book, reference.chapter, reference.verseStart || 1);
  }
}

// ===========================================================================
// Voice Command Handler
// ===========================================================================
async function handleVoiceCommand(command, _originalText) {
  switch (command.action) {
    case 'showVerse': {
      if (!command.reference) return;
      try {
        const verse = await bibleLookup.getVerseMultilang(
          command.reference,
          sessionState.getDisplayLanguage()
        );
        broadcast({
          action: 'showVerse',
          ...verse,
          durationMs: getVerseDurationMs(),
          triggeredByVoice: true,
        });
        pushHistory({ ...verse, triggeredByVoice: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
        log('Voice command: showed ' + verse.reference);
      } catch (err) {
        warn('Voice command verse lookup failed: ' + err.message);
      }
      break;
    }
    case 'hideVerse':
      broadcast({ action: 'hideVerse', triggeredByVoice: true });
      log('Voice command: hide overlay');
      break;
    case 'nextVerse': {
      broadcast({ action: 'nextVerse', triggeredByVoice: true });
      if (readingMode.active && readingMode.currentIndex < readingMode.verses.length - 1) {
        const verse = readingMode.verses[readingMode.currentIndex + 1];
        readingMode.currentIndex += 1;
        readingMode.onVerseAdvance(verse);
      }
      break;
    }
    case 'previousVerse': {
      broadcast({ action: 'previousVerse', triggeredByVoice: true });
      if (readingMode.active && readingMode.currentIndex > 0) {
        const verse = readingMode.verses[readingMode.currentIndex - 1];
        readingMode.currentIndex -= 1;
        readingMode.onVerseAdvance(verse);
      }
      break;
    }
    case 'nextChapter': {
      broadcast({ action: 'nextChapter', triggeredByVoice: true });
      if (readingMode.active) {
        await activateReadingMode(readingMode.book, (readingMode.chapter || 0) + 1, 1);
        if (readingMode.active && readingMode.currentIndex >= 0) {
          readingMode.onVerseAdvance(readingMode.verses[readingMode.currentIndex]);
        }
      }
      break;
    }
    case 'setTheme': {
      if (themeGenerator) {
        const theme = themeGenerator.getTheme(command.theme);
        broadcast({
          action: 'applyTheme',
          ...themeGenerator.themeToCss(theme),
          triggeredByVoice: true,
        });
        log('Voice command: theme ' + command.theme);
      }
      break;
    }
    case 'setLanguage': {
      sessionState.setDisplayLanguage(command.language);
      broadcast({
        action: 'languageChanged',
        language: sessionState.getDisplayLanguage(),
        triggeredByVoice: true,
      });
      log('Voice command: language ' + command.language);
      break;
    }
    case 'setTranslation': {
      try {
        const newId = bibleLookup.setTranslation(command.language, command.code);
        broadcast({
          action: 'translationChanged',
          language: command.language,
          code: command.code,
          translationId: newId,
          triggeredByVoice: true,
        });
        log(`Voice command: translation ${command.language} → ${command.code}`);
      } catch (err) {
        warn('Voice command translation failed: ' + err.message);
      }
      break;
    }
    case 'extendTime':
      broadcast({ action: 'extendTime', extraMs: command.extraMs, triggeredByVoice: true });
      break;
    case 'pauseTimer':
      broadcast({ action: 'pauseTimer', triggeredByVoice: true });
      break;
    case 'resumeTimer':
      broadcast({ action: 'resumeTimer', triggeredByVoice: true });
      break;
    case 'emergencyClear': {
      broadcast({ action: 'hideVerse', emergency: true });
      broadcast({ action: 'emergencyClear' });
      sessionState.clearLastReference();
      log('Voice command: EMERGENCY CLEAR');
      break;
    }
    default:
      warn('Unknown voice command action: ' + command.action);
  }
}

// ===========================================================================
// WebSocket handlers — with RBAC
// ===========================================================================

// Actions that require operator role
//
// CORRECTIF (deux audits indépendants convergents — round 8 et audit
// production de cette même session) : cette liste ne couvrait pas toutes
// les actions qui donnent en pratique un contrôle équivalent à l'opérateur,
// ou qui consomment du quota IA payant / exposent le contenu de la
// prédication. Les deux audits sont arrivés séparément à la même
// conclusion sur 'transcript' et les actions IA (getLiveSummary/
// getSermonTheme/getPostServiceRecap/getCrossReferences) : un client
// connecté avec seulement WS_VIEWER_TOKEN (le jeton prévu pour être collé,
// en lecture seule, dans une source navigateur OBS — donc plus exposé
// qu'un poste opérateur) et utilisant le protocole WebSocket brut (pas
// overlay.html, qui n'envoie jamais ces actions, mais un client fait à la
// main) pouvait :
//  - envoyer `transcript` directement : traité exactement comme un vrai
//    segment audio par processTranscript(), donc afficher n'importe quel
//    verset, changer de thème, déclencher emergencyClear, appeler le
//    détecteur sémantique (LLM) — un contournement complet du RBAC.
//  - appeler `preServiceCheck` : révèle wsHost et si l'authentification est
//    activée, en plus de solliciter les API Groq/Deepgram.
//  - appeler getLiveSummary / getSermonTheme / getPostServiceRecap /
//    getCrossReferences / getArchiveMatches : déclenchent des appels IA
//    payants (Groq/Gemini) et renvoient un résumé du contenu de la
//    prédication ; getPostServiceRecap a en plus un effet de bord réel —
//    elle ARCHIVE le culte et RÉINITIALISE fullServiceTranscript (voir
//    sermon-archive.js), donc un viewer l'appelant par erreur ou malice
//    perdrait la suite de la transcription du jour.
//  - basculer setHighContrast/setCaptions/setTestPattern/
//    setBackgroundPattern : setTestPattern en particulier peut
//    littéralement figer l'écran projeté avec des barres de couleur en
//    pleine prédication.
// Les actions restées hors de cette liste (getTopics, getMoods,
// listPlugins, getAiStats, ping, setTranslation en lecture via
// 'getState'…) restent volontairement accessibles aux viewers : elles ne
// renvoient que des données statiques/publiques ou des métadonnées déjà
// visibles côté overlay.
const OPERATOR_ACTIONS = new Set([
  'transcript',
  'showVerse',
  'hideVerse',
  'setLanguage',
  'setTranslation',
  'startReading',
  'stopReading',
  'applyTheme',
  'setMoodTheme',
  'searchBible',
  'togglePlugin',
  'obs-toggle-recording',
  'obs-switch-scene',
  'extendTime',
  'pauseTimer',
  'resumeTimer',
  'emergencyClear',
  'hideTranslation',
  'translateText',
  'preServiceCheck',
  'getLiveSummary',
  'getSermonTheme',
  'getPostServiceRecap',
  'getCrossReferences',
  'getSessionStats',
  'getArchiveMatches',
  'setHighContrast',
  'setCaptions',
  'setTestPattern',
  'setBackgroundPattern',
]);

// SECURITY: role is derived from WHICH token the client authenticated with
// (ws.protocol, set by the handshake), never from the request path. The old
// path-based heuristic let any client asking for `/` get 'operator' — the
// shared WS_AUTH_TOKEN was the only real gate, so a leaked/observed overlay
// URL (meant to be read-only, e.g. displayed on a public projector machine)
// still granted full operator control once WS_AUTH_TOKEN was known.
function determineClientRole(ws) {
  if (WS_AUTH_TOKEN && ws.protocol === WS_AUTH_TOKEN) return 'operator';
  if (WS_VIEWER_TOKEN && ws.protocol === WS_VIEWER_TOKEN) return 'viewer';
  if (!WS_AUTH_TOKEN) return 'operator'; // no auth configured (local-only default): unrestricted, as before
  return 'viewer'; // authenticated with neither known token shouldn't reach here (connection is closed earlier)
}

// SECURITY NOTE: this is defense-in-depth against browser-based cross-site
// WebSocket hijacking, not the primary access control — a non-browser
// client can set (or omit) any Origin header it likes, so `!origin` and
// the 'null'/'file://' allowances below are trivially satisfied by a
// deliberate attacker. The real gate for non-local binds is the mandatory
// WS_AUTH_TOKEN/WS_VIEWER_TOKEN check enforced right after this call.
function validateOrigin(req) {
  if (WS_HOST === '127.0.0.1' || WS_HOST === 'localhost') {
    return true; // localhost binds are inherently single-machine
  }
  const origin = req.headers.origin || '';
  if (!origin) return true; // native/file:// clients have no origin
  for (const allowed of ALLOWED_ORIGINS) {
    if (origin.startsWith(allowed)) return true;
  }
  return false;
}

wss.on('connection', (ws, req) => {
  const origin = req && req.headers && req.headers.origin;
  if (origin) {
    log(`Connexion WebSocket acceptée depuis l'origine : ${origin}`);
  }

  // SECURITY: origin validation for non-localhost
  if (!validateOrigin(req)) {
    warn(`Connexion refusée — origine non autorisée : ${origin}`);
    ws.close(1008, 'Origine non autorisée');
    return;
  }

  const connCheck = connRateLimiter.checkConnection(ws);
  if (!connCheck.allowed) {
    warn(`Connexion refusée — ${connCheck.reason}`);
    ws.close(1008, connCheck.reason);
    return;
  }

  // SECURITY: token now comes from the Sec-WebSocket-Protocol handshake
  // header (see `handleProtocols` above), resolved by the `ws` library into
  // `ws.protocol`, not from a `?token=` query string — this keeps it out of
  // proxy/CDN access logs and server request-URL logging.
  if (WS_AUTH_TOKEN || WS_VIEWER_TOKEN) {
    const presented = ws.protocol || null;
    const validTokens = [WS_AUTH_TOKEN, WS_VIEWER_TOKEN].filter(Boolean);
    if (!presented || !validTokens.includes(presented)) {
      warn("Connexion WebSocket refusée — jeton d'authentification invalide ou manquant.");
      connRateLimiter.removeConnection(ws);
      ws.close(1008, 'Non autorisé');
      return;
    }
  }

  // Assign role
  ws.clientRole = determineClientRole(ws);
  log(`Client WebSocket connecté (role: ${ws.clientRole})`);

  const features = featuresStore.readFeatures();
  const theme = themeLoader.getActiveTheme();

  ws.send(
    JSON.stringify({
      action: 'init',
      language: sessionState.getDisplayLanguage(),
      highContrast: sessionState.getHighContrast(),
      captions: sessionState.getCaptionsEnabled(),
      testPattern: sessionState.getTestPattern(),
      backgroundPattern: sessionState.getBackgroundPattern(),
      history: sessionState.getVerseHistory(),
      theme: themeLoader.themeToCss(theme),
      features,
      translations: bibleLookup.listTranslations(),
      plugins: plugins ? plugins.getPluginList() : [],
      aiFeatures: {
        semanticDetection: !!semanticDetector,
        voiceCommands: !!detectCommand,
        transcriptionCorrection: !!corrector,
        dynamicThemes: !!themeGenerator,
        bibleSearch: !!semanticSearch,
      },
      aiLoadErrors: aiLoadErrors.length > 0 ? aiLoadErrors : undefined,
      yourRole: ws.clientRole,
    })
  );

  ws.on('message', async (raw) => {
    const msgCheck = connRateLimiter.checkMessage(ws);
    if (!msgCheck.allowed) {
      warn(`Message rejeté — ${msgCheck.reason}`);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const sanitized = {};
    for (const k of Object.keys(msg)) {
      if (typeof msg[k] === 'string') {
        sanitized[k] = msg[k].replace(/[<>">']/g, '');
      } else {
        sanitized[k] = msg[k];
      }
    }

    // CORRECTIF (audit sécurité — flood par type de message) : la vérif
    // globale ci-dessus (checkMessage(ws)) protège contre un flood générique
    // par IP, mais pas contre un client autorisé qui enverrait uniquement
    // des `showVerse` en rafale (jamais assez pour la limite globale, mais
    // assez pour perturber l'affichage devant l'assemblée). On ajoute donc
    // une seconde vérification, spécifique à l'action, maintenant que
    // `sanitized.action` est connu (le JSON est parsé au-dessus).
    const actionCheck = connRateLimiter.checkMessage(ws, sanitized.action);
    if (!actionCheck.allowed) {
      warn(`Action '${sanitized.action}' rejetée — ${actionCheck.reason}`);
      ws.send(JSON.stringify({ action: 'error', error: actionCheck.reason }));
      return;
    }

    // RBAC: viewer connections cannot send operator actions
    if (ws.clientRole === 'viewer' && OPERATOR_ACTIONS.has(sanitized.action)) {
      warn(`Action '${sanitized.action}' refusée — rôle 'viewer' insuffisant`);
      ws.send(JSON.stringify({ action: 'error', error: 'Action réservée aux opérateurs.' }));
      return;
    }

    // CORRECTIF (audit backend — validation.js jamais branché) : pour les
    // actions déjà couvertes par validation.SCHEMAS (showVerse, hideVerse,
    // updateVerse, lookupReference, setLanguage, setTranslation, getState,
    // getHistory, replayVerse, diagnostic), on applique en plus le contrôle
    // strict de type/longueur/valeurs autorisées de ce module — jusqu'ici
    // testé en isolation (test-validation.js) mais jamais appelé ici. Fait
    // volontairement de façon additive : les actions plus récentes non
    // couvertes par SCHEMAS (transcript, preServiceCheck, startReading,
    // obs-*, etc.) ne passent pas par ce gate et continuent de fonctionner
    // exactement comme avant. `applyTheme` a été ajouté à SCHEMAS (audit
    // backend) car son payload `css` était diffusé sans aucune validation.
    if (VALIDATE_MESSAGES_ENABLED && validation.SCHEMAS[sanitized.action]) {
      const strict = validation.validateMessage(sanitized);
      if (!strict.valid) {
        warn(`Message '${sanitized.action}' rejeté par validation.js — ${strict.error}`);
        ws.send(JSON.stringify({ action: 'error', error: strict.error }));
        return;
      }
    }

    // --- Speech or audio transcript input ---
    if (sanitized.action === 'transcript') {
      const text = String(sanitized.text || '').trim();
      if (text) {
        log(`WebSocket transcript received: "${text.substring(0, 80)}"`);
        broadcast({
          action: 'transcript',
          text,
          timestamp: Date.now(),
          source: sanitized.source || 'browser',
        });
        await processTranscript(text);
      }
      return;
    }

    // --- Manual verse display ---
    if (sanitized.action === 'showVerse') {
      const ref = detector.parseReference(sanitized.reference);
      if (!ref) {
        ws.send(JSON.stringify({ action: 'error', error: 'Référence invalide.' }));
        return;
      }
      try {
        const verse = await bibleLookup.getVerseMultilang(ref, sessionState.getDisplayLanguage());
        const durationMs = sanitized.durationMs || getVerseDurationMs();
        broadcast({ action: 'showVerse', ...verse, durationMs, triggeredManually: true });
        pushHistory({ ...verse, triggeredManually: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
      } catch (err) {
        ws.send(JSON.stringify({ action: 'error', error: err.message }));
      }
      return;
    }

    // --- Hide overlay ---
    if (sanitized.action === 'hideVerse') {
      broadcast({ action: 'hideVerse' });
      sessionState.clearLastReference();
      return;
    }

    // --- Pre-service test ---
    if (sanitized.action === 'preServiceCheck') {
      try {
        const [groqResult, deepgramResult] = await Promise.all([
          groq.checkKey(),
          deepgramWrapper.checkKey(),
        ]);
        ws.send(
          JSON.stringify({
            action: 'preServiceCheckResult',
            wsConnected: true,
            wsAuthEnabled: !!WS_AUTH_TOKEN,
            wsHost: WS_HOST,
            groq: groqResult,
            deepgram: deepgramResult,
            timestamp: Date.now(),
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            action: 'error',
            error: 'Échec de la vérification pré-culte : ' + err.message,
          })
        );
      }
      return;
    }

    // --- Session stats (historique persistant SQLite — voir session-store.js) ---
    // AJOUT (audit round 9) : session-store.js écrit déjà chaque verset
    // affiché et chaque erreur de pipeline en SQLite depuis le chantier de
    // fiabilité du 2026-08-05 (jour de survie à un crash, trace consultable
    // après un culte), mais rien ne relisait jamais cette base — aucune
    // action WebSocket ne l'exposait, donc aucun panneau du tableau de bord
    // ne pouvait la montrer. La persistance tournait "dans le vide".
    if (sanitized.action === 'getSessionStats') {
      try {
        const days = Math.min(Math.max(Number.parseInt(sanitized.days, 10) || 1, 1), 30);
        const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const verses = sessionStore.getVerseHistorySince(sinceMs);
        const errors = sessionStore.getPipelineErrorsSince(sinceMs);
        const errorsByType = {};
        for (const e of errors) {
          errorsByType[e.type] = (errorsByType[e.type] || 0) + 1;
        }
        ws.send(
          JSON.stringify({
            action: 'sessionStats',
            persistenceEnabled: sessionStore.isEnabled(),
            days,
            sinceMs,
            verseCount: verses.length,
            verses: verses.slice(0, 100),
            errorCount: errors.length,
            errors: errors.slice(0, 50),
            errorsByType,
            timestamp: Date.now(),
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            action: 'error',
            error: 'Impossible de récupérer les statistiques de session : ' + err.message,
          })
        );
      }
      return;
    }

    // --- Language switch ---
    if (sanitized.action === 'setLanguage') {
      const lang = sanitized.language;
      if (['fr', 'en', 'both'].includes(lang)) {
        sessionState.setDisplayLanguage(lang);
        broadcast({ action: 'languageChanged', language: lang });
        log('Language changed: ' + lang);
      }
      return;
    }

    // --- Translation switch ---
    if (sanitized.action === 'setTranslation') {
      try {
        const newId = bibleLookup.setTranslation(sanitized.language, sanitized.code);
        broadcast({
          action: 'translationChanged',
          language: sanitized.language,
          code: sanitized.code,
          translationId: newId,
        });
        log(`Translation: ${sanitized.language} → ${sanitized.code}`);
      } catch (err) {
        ws.send(JSON.stringify({ action: 'error', error: err.message }));
      }
      return;
    }

    // --- Reading mode ---
    if (sanitized.action === 'startReading') {
      const ref = detector.parseReference(sanitized.reference);
      if (!ref) {
        ws.send(
          JSON.stringify({ action: 'error', error: 'Référence invalide pour le mode lecture.' })
        );
        return;
      }
      try {
        const firstVerse = await readingMode.start(ref.book, ref.chapter, ref.verseStart);
        ws.send(JSON.stringify({ action: 'readingStarted', reference: ref }));
        if (firstVerse) {
          const label = bibleLookup.buildReferenceLabel(
            { book: ref.book, chapter: ref.chapter, verseStart: firstVerse.num },
            sessionState.getDisplayLanguage()
          );
          broadcast({
            action: 'showVerse',
            reference: label,
            text: firstVerse.text,
            text_fr: firstVerse.text_fr || null,
            text_en: firstVerse.text_en || null,
            langMode: sessionState.getDisplayLanguage(),
            durationMs: getVerseDurationMs(),
            readingMode: true,
          });
          pushHistory({
            reference: label,
            text: firstVerse.text.substring(0, 200),
            readingMode: true,
            timestamp: Date.now(),
          });
          broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
        }
      } catch (err) {
        ws.send(JSON.stringify({ action: 'error', error: err.message }));
      }
      return;
    }

    if (sanitized.action === 'stopReading') {
      readingMode.stop();
      broadcast({ action: 'readingStopped' });
      return;
    }

    // --- Bible Semantic Search ---
    if (sanitized.action === 'searchBible') {
      if (!semanticSearch) {
        ws.send(
          JSON.stringify({ action: 'searchError', error: 'Recherche biblique non disponible' })
        );
        return;
      }
      const query = String(sanitized.query || '').trim();
      if (!query) {
        ws.send(JSON.stringify({ action: 'error', error: 'Requête requise.' }));
        return;
      }
      try {
        const results = await semanticSearch.search(query, sanitized.topK || 5);
        ws.send(JSON.stringify({ action: 'searchResults', query, results, timestamp: Date.now() }));
      } catch (err) {
        ws.send(JSON.stringify({ action: 'searchError', query, error: err.message }));
      }
      return;
    }

    // --- Get topics ---
    if (sanitized.action === 'getTopics') {
      ws.send(
        JSON.stringify({
          action: 'topicsList',
          topics: semanticSearch ? semanticSearch.getTopics() : [],
        })
      );
      return;
    }

    // --- Get moods ---
    if (sanitized.action === 'getMoods') {
      ws.send(
        JSON.stringify({
          action: 'moodsList',
          moods: themeGenerator ? themeGenerator.getMoods() : [],
        })
      );
      return;
    }

    // --- Set theme by mood ---
    if (sanitized.action === 'setMoodTheme') {
      if (!themeGenerator) {
        ws.send(JSON.stringify({ action: 'error', error: 'Générateur de thèmes non disponible' }));
        return;
      }
      const mood = sanitized.mood;
      const theme = themeGenerator.getTheme(mood);
      broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme) });
      ws.send(JSON.stringify({ action: 'themeApplied', mood, themeName: theme.name }));
      return;
    }

    // --- Plugin management ---
    if (sanitized.action === 'listPlugins') {
      ws.send(
        JSON.stringify({ action: 'pluginsList', plugins: plugins ? plugins.getPluginList() : [] })
      );
      return;
    }

    if (sanitized.action === 'togglePlugin') {
      if (plugins) {
        plugins.setEnabled(sanitized.pluginName, sanitized.enabled);
        ws.send(
          JSON.stringify({
            action: 'pluginToggled',
            pluginName: sanitized.pluginName,
            enabled: sanitized.enabled,
          })
        );
      }
      return;
    }

    // --- AI stats ---
    if (sanitized.action === 'getAiStats') {
      ws.send(
        JSON.stringify({
          action: 'aiStats',
          semanticDetector: semanticDetector ? semanticDetector.getStats() : null,
          corrector: corrector ? corrector.getStats() : null,
          plugins: plugins ? plugins.metadata : null,
          aiEnricher: !!aiEnricher,
          loadErrors: aiLoadErrors,
        })
      );
      return;
    }

    // --- AI Live Summary (with prompt sanitization) ---
    if (sanitized.action === 'getLiveSummary') {
      if (!aiEnricher) {
        ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
        return;
      }
      const fullTranscript = sanitizeForPrompt(sessionState.getRecentTranscripts().join(' '));
      const summary = await aiEnricher.generateLiveSummary(fullTranscript);
      ws.send(JSON.stringify({ action: 'liveSummary', summary, timestamp: Date.now() }));
      return;
    }

    // --- AI Sermon Theme (with prompt sanitization) ---
    if (sanitized.action === 'getSermonTheme') {
      if (!aiEnricher) {
        ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
        return;
      }
      const fullTranscript = sanitizeForPrompt(sessionState.getRecentTranscripts().join(' '));
      const themeData = await aiEnricher.detectSermonTheme(fullTranscript);
      ws.send(
        JSON.stringify({
          action: 'sermonTheme',
          ...themeData,
          silent: !!sanitized.silent,
          timestamp: Date.now(),
        })
      );
      return;
    }

    // --- AI Post-Service Recap (with prompt sanitization) ---
    if (sanitized.action === 'getPostServiceRecap') {
      if (!aiEnricher) {
        ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
        return;
      }
      // CORRECTIF (audit — mémoire des cultes) : sessionState.getRecentTranscripts()
      // est une fenêtre glissante de 10 fragments (pensée pour le contexte
      // court du détecteur sémantique, voir session-state.js), donc trop
      // étroite pour un "récap fin de culte" fidèle — il ne portait en
      // réalité que sur les dernières secondes du service.
      // sessionState.getFullServiceTranscript() couvre tout le culte en
      // cours (borné à MAX_SERVICE_TRANSCRIPT_CHARS caractères).
      const fullTranscript = sanitizeForPrompt(sessionState.getFullServiceTranscript());
      const recap = await aiEnricher.generatePostServiceRecap(
        fullTranscript,
        sessionState.getVerseHistory()
      );
      ws.send(JSON.stringify({ action: 'postServiceRecap', recap, timestamp: Date.now() }));

      // AJOUT (audit — mémoire des cultes, gratuit/léger) : le clic "Récap
      // fin de culte" est le seul geste explicite de fin de service déjà
      // présent dans l'app — on l'utilise aussi pour archiver localement
      // (voir sermon-archive.js) et repartir à zéro pour le prochain culte.
      try {
        sermonArchive.saveServiceEntry({
          theme: recap && recap.title,
          keyPoints: recap && recap.keyPoints,
          transcriptExcerpt: sessionState.getFullServiceTranscript().slice(-4000),
          versesShown: sessionState.getVerseHistory(),
        });
        log('Culte archivé localement (sermon-archive.js)');
      } catch (err) {
        warn('Archivage du culte échoué: ' + err.message);
      }
      sessionState.resetFullServiceTranscript();
      return;
    }

    // --- Sermon archive search (audit — mémoire des cultes, gratuit/léger) ---
    if (sanitized.action === 'getArchiveMatches') {
      const query = sanitizeForPrompt(sanitized.query || '');
      const matches = query ? sermonArchive.search(query) : [];
      ws.send(JSON.stringify({ action: 'archiveMatches', query: sanitized.query, results: matches }));
      return;
    }

    // --- AI Cross References (with prompt sanitization) ---
    if (sanitized.action === 'getCrossReferences') {
      if (!aiEnricher) {
        ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
        return;
      }
      const safeRef = sanitizeForPrompt(sanitized.reference || '');
      const safeText = sanitizeForPrompt(sanitized.text || '');
      const refs = await aiEnricher.findCrossReferences(safeRef, safeText);
      ws.send(
        JSON.stringify({ action: 'crossReferences', reference: sanitized.reference, results: refs })
      );
      return;
    }

    // --- AI Live Translation (with prompt sanitization) ---
    if (sanitized.action === 'translateText') {
      if (!aiEnricher) {
        ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
        return;
      }
      const targetLang = sanitized.targetLang || 'en';
      const safeText = sanitizeForPrompt(sanitized.text || '');
      const translation = await aiEnricher.translateSegment(safeText, targetLang);
      if (sanitized.autoBroadcast) {
        broadcast({
          action: 'showTranslation',
          translation,
          targetLang,
          reference: sanitized.reference || null,
        });
      }
      ws.send(
        JSON.stringify({
          action: 'textTranslated',
          original: sanitized.text,
          targetLang,
          translation,
          autoBroadcast: !!sanitized.autoBroadcast,
        })
      );
      return;
    }

    // --- Live translation off ---
    if (sanitized.action === 'hideTranslation') {
      broadcast({ action: 'hideTranslation' });
      return;
    }

    // --- Theme application ---
    if (sanitized.action === 'applyTheme') {
      broadcast({ action: 'applyTheme', ...sanitized.css });
      return;
    }

    // --- Accessibility: high-contrast mode (audit — free/light) ---
    if (sanitized.action === 'setHighContrast') {
      sessionState.setHighContrast(!!sanitized.enabled);
      const highContrast = sessionState.getHighContrast();
      broadcast({ action: 'accessibilityMode', highContrast });
      log('Accessibilité : mode grand contraste ' + (highContrast ? 'activé' : 'désactivé'));
      return;
    }

    // --- Accessibility: live caption strip (audit — free/light) ---
    if (sanitized.action === 'setCaptions') {
      sessionState.setCaptionsEnabled(!!sanitized.enabled);
      const captions = sessionState.getCaptionsEnabled();
      broadcast({ action: 'captionsMode', captions });
      log('Accessibilité : sous-titres ' + (captions ? 'activés' : 'désactivés'));
      return;
    }

    // --- Display: test pattern (audit — affichage/sortie, free/light) ---
    if (sanitized.action === 'setTestPattern') {
      sessionState.setTestPattern(!!sanitized.enabled);
      const enabled = sessionState.getTestPattern();
      broadcast({ action: 'testPatternMode', enabled });
      log('Affichage : motif de test ' + (enabled ? 'activé' : 'désactivé'));
      return;
    }

    // --- Display: background pattern (audit — affichage/sortie, free/light) ---
    if (sanitized.action === 'setBackgroundPattern') {
      const allowed = ['none', 'dots', 'grid', 'diagonal'];
      const pattern = allowed.includes(sanitized.pattern) ? sanitized.pattern : 'none';
      sessionState.setBackgroundPattern(pattern);
      broadcast({ action: 'backgroundPatternMode', pattern });
      log('Affichage : motif de fond -> ' + pattern);
      return;
    }

    // --- Ping ---
    if (sanitized.action === 'ping') {
      ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
      return;
    }
  });

  ws.on('close', () => {
    connRateLimiter.removeConnection(ws);
    log('Client WebSocket déconnecté');
  });
  ws.on('error', (err) => warn('WebSocket error: ' + err.message));
});

// ===========================================================================
// Audio pipeline
// ===========================================================================
// AJOUT (audit — fiabilité gratuite, sans modèle local) : un échec de
// transcription (hoquet réseau, 5xx transitoire côté Groq/Deepgram) faisait
// perdre le segment silencieusement — pas de nouvelle tentative, juste un
// avertissement console. Sur un service d'une heure, quelques secondes de
// coupure Wi-Fi pouvaient donc effacer une phrase entière. Deux tentatives
// avec un court délai suffisent à absorber un hoquet transitoire sans
// bloquer les segments suivants (l'appelant ne les attend pas — voir
// feedPcmChunk/handleAudioData dans audio-capture.js, purement fire-and-forget).
let consecutiveTranscriptionFailures = 0;
const TRANSCRIPTION_RETRY_DELAY_MS = 700;

async function transcribeWithRetry(segmentFile, contextHint, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await groq.transcribeWithFallback(segmentFile, undefined, contextHint);
      if (consecutiveTranscriptionFailures > 0) {
        consecutiveTranscriptionFailures = 0;
        broadcast({ action: 'pipelineHealth', status: 'ok' });
        log('Transcription rétablie après ' + attempt + ' tentative(s)');
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        warn(`Transcription échouée (tentative ${attempt}/${maxAttempts}): ${err.message} — nouvel essai`);
        broadcast({ action: 'transcriptionRetrying', attempt, maxAttempts, error: err.message });
        await new Promise((resolve) => setTimeout(resolve, TRANSCRIPTION_RETRY_DELAY_MS));
      }
    }
  }
  consecutiveTranscriptionFailures++;
  broadcast({ action: 'pipelineHealth', status: 'degraded', consecutiveFailures: consecutiveTranscriptionFailures });
  throw lastErr;
}

function startPipeline() {
  // CORRECTIF (problème récurrent — transcription qui ne démarre jamais) :
  // compte les segments rejetés consécutivement pour silence (voir
  // audio-capture.js). Un silence isolé est normal (temps mort entre deux
  // prises de parole) ; ALERT_AFTER_CONSECUTIVE_SKIPS segments rejetés
  // d'affilée (~1 minute à 5s/segment) signale plutôt un micro trop
  // silencieux (mauvais périphérique, gain trop bas) — dans ce cas, sans
  // cette alerte, l'opérateur voit juste "en attente" indéfiniment sans
  // jamais savoir pourquoi.
  const ALERT_AFTER_CONSECUTIVE_SKIPS = 12;
  let consecutiveSkips = 0;
  let alertedForCurrentSilence = false;

  audioCapture.on({
    onAudioSegment: async (segmentFile) => {
      consecutiveSkips = 0;
      alertedForCurrentSilence = false;
      try {
        // AJOUT (audit — boost transcription) : la fin du dernier segment déjà
        // transcrit sert d'indice de continuité pour Whisper (voir groq-wrapper.js).
        const contextHint = getRecentContext(300);
        const result = await transcribeWithRetry(segmentFile, contextHint);
        if (result && result.text && result.text.trim()) {
          log(`Transcription [${result.source}]: ${result.text.substring(0, 80)}`);
          broadcast({ action: 'transcript', text: result.text, source: result.source });
          await processTranscript(result.text);
        }
      } catch (err) {
        warn('Transcription error: ' + err.message);
        broadcast({ action: 'transcriptionError', error: err.message });
        sessionStore.recordPipelineError('transcription', err.message);
        if (plugins)
          plugins.emit('onError', { type: 'transcription', message: err.message }).catch(() => {});
      } finally {
        try {
          fs.unlinkSync(segmentFile);
        } catch (_) {}
      }
    },
    onSegmentSkipped: (info) => {
      consecutiveSkips++;
      if (consecutiveSkips >= ALERT_AFTER_CONSECUTIVE_SKIPS && !alertedForCurrentSilence) {
        alertedForCurrentSilence = true;
        const message = `Aucune voix détectée depuis ~${Math.round((consecutiveSkips * 5000) / 1000)}s (niveau micro sous le seuil ${info.threshold}) — vérifiez le périphérique sélectionné et son gain.`;
        warn('Silence prolongé : ' + message);
        broadcast({ action: 'audioSilenceWarning', message, ...info });
        sessionStore.recordPipelineError('audio-silence', message);
      }
    },
    onError: (err) => {
      warn('Audio capture error: ' + err.message);
      broadcast({ action: 'audioError', error: err.message });
      sessionStore.recordPipelineError('audio', err.message);
    },
  });

  audioCapture.startBrowserCapture({ silenceThreshold: MIC_SILENCE_THRESHOLD });

  if (parentPort) {
    parentPort.postMessage({ type: 'audio-pipeline-ready' });
  }

  log(`Pipeline démarré sur ws://localhost:${SERVER_PORT}`);
  if (aiLoadErrors.length > 0) {
    log('⚠ ' + aiLoadErrors.length + ' AI feature(s) in limited mode (see logs above)');
  }
}

// ===========================================================================
// Worker IPC
// ===========================================================================
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'shutdown') {
      log('Shutdown requested by main process');
      audioCapture.stopRecording();
      stopAmbientMoodLoop();
      wss.clients.forEach((ws) => ws.close());
      wss.close();
      connRateLimiter.stopCleanup();
      sessionStore.close();
      if (parentPort) parentPort.postMessage({ type: 'status', status: 'stopped' });
      const finish = () => process.exit(0);
      if (plugins) {
        plugins
          .shutdown()
          .catch(() => {})
          .finally(finish);
        setTimeout(finish, 2000).unref?.();
      } else {
        finish();
      }
      return;
    }

    if (msg.type === 'theme-changed') {
      broadcast({ action: 'applyTheme', ...msg.css });
      return;
    }

    if (msg.type === 'obs-gate-changed') {
      sessionState.setObsGate(msg.open, msg.reason || '');
      log(`OBS gate: ${msg.open ? 'OPEN' : 'CLOSED'} (${sessionState.getObsGate().reason})`);
      return;
    }

    if (msg.type === 'audio-pcm-chunk') {
      audioCapture.feedPcmChunk(Buffer.from(msg.buffer));
      return;
    }
  });

  parentPort.postMessage({ type: 'status', status: 'running' });
}

// ===========================================================================
// Bible lookup cache directory
// ===========================================================================
try {
  bibleLookup.setCacheDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set Bible cache dir: ' + err.message);
}

try {
  sermonArchive.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set sermon archive dir: ' + err.message);
}

// ===========================================================================
// Session store (persistance SQLite — voir session-store.js)
// ===========================================================================
sessionStore.init(USER_DATA_DIR, { onError: warn });

// ===========================================================================
// Startup
// ===========================================================================
configValidator
  .validateSystemConfig()
  .then(configValidator.displayValidationResults)
  .catch((err) => warn('config-validator: ' + err.message));

startPipeline();
startAmbientMoodLoop();

process.on('SIGTERM', () => {
  log('SIGTERM received');
  audioCapture.stopRecording();
  stopAmbientMoodLoop();
  wss.close();
  connRateLimiter.stopCleanup();
  sessionStore.close();
  if (plugins) plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received');
  audioCapture.stopRecording();
  // AJOUT (audit production, cette session) : même écart que celui corrigé
  // au round 8 pour connRateLimiter juste en dessous, mais sur
  // stopAmbientMoodLoop() — inconnu du round 8 (la boucle d'ambiance
  // n'existait pas encore côté origin/main à ce moment-là). Même
  // raisonnement : sans impact fonctionnel réel (timer unref()é), mais
  // gardé symétrique avec SIGTERM par cohérence.
  stopAmbientMoodLoop();
  wss.close();
  // CORRECTIF (audit round 8) : le handler SIGTERM juste au-dessus arrête
  // connRateLimiter (voir round 7), mais ce handler SIGINT — le chemin pris
  // par un simple Ctrl+C en lancement manuel (`node server.js` / `npm run
  // server-only`) — avait été oublié. Sans réel impact fonctionnel puisque
  // le timer est unref()é par défaut, mais incohérent avec l'arrêt
  // "propre" documenté au round 7 ; corrigé pour rester symétrique avec
  // SIGTERM.
  connRateLimiter.stopCleanup();
  sessionStore.close();
  if (plugins) plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  warn('Uncaught exception (arrêt du serveur): ' + ((err && err.stack) || err.message));
  try {
    audioCapture.cleanupTempFiles({ force: true });
  } catch (_) {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = (reason && reason.stack) || (reason && reason.message) || String(reason);
  warn('Unhandled promise rejection (arrêt du serveur): ' + message);
  try {
    audioCapture.cleanupTempFiles({ force: true });
  } catch (_) {}
  process.exit(1);
});
