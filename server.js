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
const USER_DATA_DIR = (workerData && workerData.userDataDir) || path.join(os.homedir(), '.churchoverlay');

// ---------------------------------------------------------------------------
// Core modules (REQUIRED)
// ---------------------------------------------------------------------------
const audioCapture = require('./audio-capture');
const groq = require('./groq-wrapper');
const deepgramWrapper = require('./deepgram-wrapper');
const configValidator = require('./config-validator');
const { createFileLogger } = require('./logger');

const detector = require('./detector-compat');
const bibleLookup = require('./bible-lookup-with-api');
const { ReadingMode } = require('./reading-mode');
const themeLoader = require('./theme-loader');
// AJOUT (audit — mémoire des cultes, gratuit/léger) : même discipline que
// bible-semantic-search.js — fichier JSON local, recherche par mots-clés,
// aucun modèle d'embedding, aucun appel API. Voir sermon-archive.js.
const sermonArchive = require('./sermon-archive');
const featuresStore = require('./features-store');
const obsController = require('./obs-controller');
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
// NEW: AI modules (OPTIONAL — wrapped in try-catch)
// ---------------------------------------------------------------------------
let SemanticDetector = null;
let semanticDetector = null;
let detectCommand = null;
let TranscriptionCorrector = null;
let corrector = null;
let BibleSemanticSearch = null;
let semanticSearch = null;
let PluginSystem = null;
let plugins = null;
let AIThemeGenerator = null;
let themeGenerator = null;

const aiLoadErrors = [];
const groqHasChatCompletion = typeof groq.chatCompletion === 'function';

try {
  const mod = require('./semantic-detector');
  SemanticDetector = mod.SemanticDetector;
  if (groqHasChatCompletion) {
    semanticDetector = new SemanticDetector(groq);
    console.log('[server] ✓ SemanticDetector loaded');
  } else {
    aiLoadErrors.push('SemanticDetector: groq.chatCompletion not available');
  }
} catch (e) {
  aiLoadErrors.push('SemanticDetector: ' + e.message);
  console.warn('[server] SemanticDetector disabled:', e.message);
}

try {
  const mod = require('./voice-commands');
  detectCommand = mod.detectCommand;
  console.log('[server] ✓ Voice commands loaded');
} catch (e) {
  aiLoadErrors.push('VoiceCommands: ' + e.message);
  console.warn('[server] Voice commands disabled:', e.message);
}

try {
  const mod = require('./transcription-corrector');
  TranscriptionCorrector = mod.TranscriptionCorrector;
  if (groqHasChatCompletion) {
    corrector = new TranscriptionCorrector(groq);
    console.log('[server] ✓ TranscriptionCorrector loaded');
  } else {
    aiLoadErrors.push('TranscriptionCorrector: groq.chatCompletion not available (tests use mock)');
    corrector = new TranscriptionCorrector(null);
    console.log('[server] ✓ TranscriptionCorrector loaded (fast mode only)');
  }
} catch (e) {
  aiLoadErrors.push('TranscriptionCorrector: ' + e.message);
  console.warn('[server] TranscriptionCorrector disabled:', e.message);
}

try {
  const mod = require('./bible-semantic-search');
  BibleSemanticSearch = mod.BibleSemanticSearch;
  semanticSearch = new BibleSemanticSearch();
  semanticSearch.loadIndex().catch(() => {});
  console.log('[server] ✓ BibleSemanticSearch loaded');
} catch (e) {
  aiLoadErrors.push('BibleSemanticSearch: ' + e.message);
  console.warn('[server] BibleSemanticSearch disabled:', e.message);
}

try {
  const mod = require('./plugin-system');
  PluginSystem = mod.PluginSystem;
  plugins = new PluginSystem();
  const pluginsDir = path.join(APP_ROOT, 'config', 'plugins');
  if (fs.existsSync(pluginsDir)) {
    plugins.loadFromDirectory(pluginsDir);
  }
  console.log('[server] ✓ PluginSystem loaded');
} catch (e) {
  aiLoadErrors.push('PluginSystem: ' + e.message);
  console.warn('[server] PluginSystem disabled:', e.message);
}

try {
  const mod = require('./ai-theme-generator');
  AIThemeGenerator = mod.AIThemeGenerator;
  if (groqHasChatCompletion) {
    themeGenerator = new AIThemeGenerator(groq);
    console.log('[server] ✓ AIThemeGenerator loaded');
  } else {
    themeGenerator = new AIThemeGenerator(null);
    console.log('[server] ✓ AIThemeGenerator loaded (rule-based only)');
  }
} catch (e) {
  aiLoadErrors.push('AIThemeGenerator: ' + e.message);
  console.warn('[server] AIThemeGenerator disabled:', e.message);
}

let aiEnricher = null;
try {
  aiEnricher = require('./ai-enricher');
  console.log('[server] ✓ AI Enricher loaded');
} catch (e) {
  aiLoadErrors.push('AIEnricher: ' + e.message);
  console.warn('[server] AIEnricher disabled:', e.message);
}

if (aiLoadErrors.length > 0) {
  console.log('[server] ⚠ ' + aiLoadErrors.length + ' AI feature(s) in limited mode.');
}

// ---------------------------------------------------------------------------
// HTTP & WebSocket server
// ---------------------------------------------------------------------------
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createRateLimiter } = require('./rate-limiter');

const portValidation = configValidator.validateEnvVar('PORT', process.env.PORT);
if (!portValidation.valid) {
  console.warn(`[server] ${portValidation.error} — utilisation du port par défaut 3000.`);
}
const SERVER_PORT = portValidation.valid ? portValidation.parsedValue : 3000;

const hostValidation = configValidator.validateEnvVar('WS_HOST', process.env.WS_HOST);
const WS_HOST = hostValidation.valid ? hostValidation.parsedValue : '127.0.0.1';

// SECURITY: enforce minimum token length of 16 characters
let WS_AUTH_TOKEN = (process.env.WS_AUTH_TOKEN || '').trim() || null;
if (WS_AUTH_TOKEN && WS_AUTH_TOKEN.length < 16) {
  console.error('[server] WS_AUTH_TOKEN too short (minimum 16 characters). Authentication disabled.');
  WS_AUTH_TOKEN = null;
}

// Active par défaut (recommandé) ; VALIDATE_MESSAGES=false ou 0 désactive
// le contrôle strict de validation.js pour les actions qu'il couvre.
const VALIDATE_MESSAGES_ENABLED = !['false', '0'].includes(
  (process.env.VALIDATE_MESSAGES || '').trim().toLowerCase()
);

const maxConnValidation = configValidator.validateEnvVar('MAX_CONNECTIONS', process.env.MAX_CONNECTIONS);
const MAX_CONNECTIONS = maxConnValidation.valid ? maxConnValidation.parsedValue : 10;

const maxMsgValidation = configValidator.validateEnvVar('MAX_MESSAGES_PER_MINUTE', process.env.MAX_MESSAGES_PER_MINUTE);
const MAX_MESSAGES_PER_MINUTE = maxMsgValidation.valid ? maxMsgValidation.parsedValue : 60;

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
  res.json({ status: 'ok', port: SERVER_PORT, service: 'ChurchOverlay', authEnabled: !!WS_AUTH_TOKEN });
});

// AJOUT (audit — second écran pour l'assemblée, gratuit/léger) : page de
// lecture seule, pensée pour un QR code scanné pendant le culte. Pas de
// jeton WS_AUTH_TOKEN requis ici — contrairement au canal WebSocket, qui
// peut déclencher des actions, cette route ne fait que RELIRE des versets
// déjà projetés publiquement sur l'écran de la salle (même donnée, même
// sensibilité que /api/health, déjà sans authentification).
app.get('/companion', (req, res) => res.sendFile(path.join(APP_ROOT, 'companion.html')));
app.get('/api/verses', (req, res) => {
  res.json({ verses: verseHistory });
});

const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, maxPayload: 64 * 1024 });

httpServer.listen(SERVER_PORT, WS_HOST, () => {
  console.log(`[server] Serveur HTTP & WebSocket démarré sur http://${WS_HOST}:${SERVER_PORT}`);
});

httpServer.on('error', (err) => {
  const reason = err && err.code === 'EADDRINUSE'
    ? `Le port ${SERVER_PORT} est déjà utilisé par une autre application.`
    : `Erreur du serveur HTTP/WebSocket: ${err && err.message}`;
  console.error('[server] ' + reason);
  if (parentPort) {
    parentPort.postMessage({
      type: 'alert', code: 'server-listen-error', severity: 'error', message: reason, timestamp: Date.now(),
    });
  }
  process.exitCode = 1;
  process.exit(1);
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let displayLanguage = 'fr';
// AJOUT (audit — accessibilité, gratuit/léger) : bascule CSS pure côté
// overlay (voir action 'setHighContrast' plus bas + overlay.html
// .high-contrast) — aucun modèle, aucun appel API, un seul booléen partagé.
let highContrastMode = false;
// AJOUT (audit — accessibilité) : le texte transcrit circule déjà sur
// chaque segment (broadcast 'transcript' dans startPipeline) — cette bascule
// ne fait qu'autoriser l'overlay à l'afficher, aucun nouveau calcul.
let captionsEnabled = false;
// AJOUT (audit — affichage/sortie, gratuit/léger) : barres de couleur
// statiques (CSS pur, voir overlay.html #test-pattern) pour vérifier la
// chaîne vidéo (OBS/NDI via DistroAV/projecteur) avant le culte.
let testPatternEnabled = false;
// AJOUT (audit — affichage/sortie, gratuit/léger) : motif de fond optionnel
// (CSS pur, aucune image), en plus des dégradés de thème existants.
let backgroundPattern = 'none';
let lastReference = null;
let lastShownAt = 0;
const DEDUP_MS = 30_000;
const verseHistory = [];
const MAX_HISTORY = 20;
const recentTranscripts = [];
const MAX_CONTEXT_TRANSCRIPTS = 10;
// AJOUT (audit — mémoire des cultes) : recentTranscripts est une fenêtre
// glissante de 10 fragments (pensée pour le contexte court du détecteur
// sémantique — voir updateTranscriptContext ci-dessous), donc trop étroite
// pour un "récap fin de culte" ou une archive fidèles à un service complet.
// Ce tampon séparé accumule tout le culte en cours, borné en octets pour
// éviter une croissance mémoire illimitée sur un service de plusieurs
// heures ; remis à zéro quand l'opérateur clôture le culte (voir l'action
// 'getPostServiceRecap', seul signal de fin de service déjà présent dans
// l'app).
let fullServiceTranscript = '';
const MAX_SERVICE_TRANSCRIPT_CHARS = 50_000;
let obsGateOpen = true;
let obsGateReason = '';

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
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

// ---------------------------------------------------------------------------
// Push to verse history
// ---------------------------------------------------------------------------
function pushHistory(entry) {
  verseHistory.unshift(entry);
  if (verseHistory.length > MAX_HISTORY) verseHistory.pop();
}

// ---------------------------------------------------------------------------
// Reading Mode
// ---------------------------------------------------------------------------
const readingMode = new ReadingMode({
  getChapterVerses: (book, chapter) =>
    bibleLookup.getChapterVerses(book, chapter, displayLanguage === 'en' ? 'en' : 'fr'),
  onVerseAdvance: (verse) => {
    const reference = bibleLookup.buildReferenceLabel(
      { book: readingMode.book, chapter: readingMode.chapter, verseStart: verse.num }, displayLanguage
    );
    broadcast({
      action: 'showVerse', reference, text: verse.text, langMode: displayLanguage,
      durationMs: getVerseDurationMs(), readingMode: true,
    });
    pushHistory({ reference, text: verse.text.substring(0, 200), readingMode: true, timestamp: Date.now() });
    broadcast({ action: 'historyUpdated', history: verseHistory });
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
const PROMPT_INJECTION_PATTERNS = [
  /ignore previous instructions/gi,
  /ignore all prior/gi,
  /system prompt/gi,
  /you are now/gi,
  /disregard everything/gi,
  /new instructions?:/gi,
  /<?\/?instruction>/gi,
  /<?\/?system>/gi,
  /DAN\b/gi,
  /jailbreak/gi,
];

function sanitizeForPrompt(text) {
  if (!text) return '';
  let sanitized = text;
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[...]');
  }
  // Limit length to prevent prompt stuffing
  return sanitized.slice(0, 4000);
}

// ---------------------------------------------------------------------------
// Update transcript context for AI features
// ---------------------------------------------------------------------------
function updateTranscriptContext(text) {
  recentTranscripts.push(text);
  if (recentTranscripts.length > MAX_CONTEXT_TRANSCRIPTS) recentTranscripts.shift();
  if (semanticDetector) semanticDetector.addContext(text);

  fullServiceTranscript += (fullServiceTranscript ? ' ' : '') + text;
  if (fullServiceTranscript.length > MAX_SERVICE_TRANSCRIPT_CHARS) {
    fullServiceTranscript = fullServiceTranscript.slice(-MAX_SERVICE_TRANSCRIPT_CHARS);
  }
}

function getRecentContext(maxChars = 300) {
  const context = recentTranscripts.slice(-5).join(' ');
  return context.length > maxChars ? context.slice(-maxChars) : context;
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
      if (recentTranscripts.length === lastAmbientTranscriptCount) return;
      lastAmbientTranscriptCount = recentTranscripts.length;

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
    log(`Fuzzy match: "${reference.fuzzyOriginal}" → "${reference.book}" (distance ${reference.fuzzyDistance})`);
    broadcast({
      action: 'candidateVerse',
      reference: { book: reference.book, chapter: reference.chapter, verseStart: reference.verseStart },
      original: reference.fuzzyOriginal, distance: reference.fuzzyDistance,
    });
  }

  if (!reference && semanticDetector) {
    try {
      const semanticResult = await semanticDetector.detect(correctedText);
      if (semanticResult) {
        reference = semanticResult;
        log(`Semantic detection: ${semanticResult.raw} (confidence: ${semanticResult.confidence.toFixed(2)})`);
        broadcast({
          action: 'semanticDetected', reference: semanticResult.raw,
          confidence: semanticResult.confidence, reasoning: semanticResult.reasoning,
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
    } catch (e) {}
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
            const label = bibleLookup.buildReferenceLabel({ book, chapter: nextChapter, verseStart: first.num }, displayLanguage);
            broadcast({ action: 'showVerse', reference: label, text: first.text, langMode: displayLanguage, durationMs: getVerseDurationMs(), readingMode: true });
            pushHistory({ reference: label, text: first.text.substring(0, 200), readingMode: true, timestamp: Date.now() });
            broadcast({ action: 'historyUpdated', history: verseHistory });
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

  const refKey = `${reference.book}:${reference.chapter}:${reference.verseStart || ''}`;
  const now = Date.now();
  if (lastReference === refKey && now - lastShownAt < DEDUP_MS) {
    log('Duplicate suppressed: ' + refKey);
    return;
  }
  lastReference = refKey;
  lastShownAt = now;

  let verse;
  try {
    if (reference.detectedBy === 'quote') {
      const quoted = quotedMatch || bibleLookup.findByQuotedText(correctedText);
      verse = { reference: quoted.reference, text: quoted.text, provider: quoted.provider, lang: quoted.lang };
    } else {
      verse = await bibleLookup.getVerseMultilang(reference, displayLanguage);
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
  if (multiScene.enabled && !obsGateOpen) {
    log('OBS gate closed — verse buffered: ' + verse.reference);
    broadcast({ action: 'verseBuffered', reference: verse.reference, reason: obsGateReason });
    return;
  }

  const durationMs = getVerseDurationMs();
  broadcast({
    action: 'showVerse', reference: verse.reference, text: verse.text,
    text_fr: verse.text_fr || null, text_en: verse.text_en || null,
    langMode: verse.langMode, provider: verse.provider, durationMs,
    detectedBy: reference.detectedBy || 'regex', matchedByQuote: reference.detectedBy === 'quote',
    theme: theme ? { name: theme.name, mood: theme.mood } : null,
  });

  pushHistory({ reference: verse.reference, text: verse.text.substring(0, 200), timestamp: now, detectedBy: reference.detectedBy || 'regex' });
  broadcast({ action: 'historyUpdated', history: verseHistory });

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
async function handleVoiceCommand(command, originalText) {
  switch (command.action) {
    case 'showVerse': {
      if (!command.reference) return;
      try {
        const verse = await bibleLookup.getVerseMultilang(command.reference, displayLanguage);
        broadcast({ action: 'showVerse', ...verse, durationMs: getVerseDurationMs(), triggeredByVoice: true });
        pushHistory({ ...verse, triggeredByVoice: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: verseHistory });
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
        broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme), triggeredByVoice: true });
        log('Voice command: theme ' + command.theme);
      }
      break;
    }
    case 'setLanguage': {
      displayLanguage = command.language;
      broadcast({ action: 'languageChanged', language: displayLanguage, triggeredByVoice: true });
      log('Voice command: language ' + command.language);
      break;
    }
    case 'setTranslation': {
      try {
        const newId = bibleLookup.setTranslation(command.language, command.code);
        broadcast({ action: 'translationChanged', language: command.language, code: command.code, translationId: newId, triggeredByVoice: true });
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
      lastReference = null;
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
// CORRECTIF (audit production) : plusieurs actions à effet réel (coût API
// IA, ou état serveur modifié) n'étaient dans cette liste — un client
// 'viewer' (quiconque a seulement l'URL /overlay, ex. un opérateur vidéo
// distinct ou un curieux qui l'a trouvée) pouvait donc déjà les déclencher.
// Trois catégories corrigées ici :
//  1. 'transcript' — le plus grave des trois : permet d'injecter n'importe
//     quel texte directement dans processTranscript(), le même pipeline
//     qu'un vrai segment de parole (affichage de verset arbitraire,
//     commandes vocales dont emergencyClear, appel LLM du détecteur
//     sémantique). Un viewer n'a aucune raison légitime d'appeler ceci.
//  2. getLiveSummary/getSermonTheme/getPostServiceRecap/getCrossReferences
//     — chacune déclenche un appel LLM payant en quota (voir la discipline
//     palier gratuit établie pour semantic-detector.js/groq-wrapper.js) ;
//     getPostServiceRecap a en plus un effet de bord réel : elle ARCHIVE le
//     culte et RÉINITIALISE fullServiceTranscript (voir sermon-archive.js)
//     — un viewer l'appelant par erreur ou malice perdrait la suite de la
//     transcription du jour.
//  3. Les 4 actions ajoutées cette session (accessibilité + affichage) —
//     setTestPattern en particulier peut littéralement figer l'écran
//     projeté avec des barres de couleur en pleine prédication.
const OPERATOR_ACTIONS = new Set([
  'showVerse', 'hideVerse', 'setLanguage', 'setTranslation', 'startReading', 'stopReading',
  'applyTheme', 'setMoodTheme', 'searchBible', 'togglePlugin', 'obs-toggle-recording',
  'obs-switch-scene', 'extendTime', 'pauseTimer', 'resumeTimer', 'emergencyClear',
  'hideTranslation', 'translateText',
  'transcript',
  'getLiveSummary', 'getSermonTheme', 'getPostServiceRecap', 'getCrossReferences', 'getArchiveMatches',
  'setHighContrast', 'setCaptions', 'setTestPattern', 'setBackgroundPattern',
]);

function determineClientRole(req) {
  // Dashboard loaded via file:// or localhost with token = operator
  // Overlay loaded via file:// or /overlay = viewer (read-only)
  const url = req.url || '';
  if (url.includes('/overlay') || url.includes('overlay.html')) {
    return 'viewer';
  }
  // Heuristic: if token is present and matches, and origin looks like dashboard
  return 'operator';
}

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

  if (WS_AUTH_TOKEN) {
    let providedToken = null;
    try {
      providedToken = new URL(req.url, 'http://internal').searchParams.get('token');
    } catch (_) {}
    if (providedToken !== WS_AUTH_TOKEN) {
      warn('Connexion WebSocket refusée — jeton d\'authentification invalide ou manquant.');
      connRateLimiter.removeConnection(ws);
      ws.close(1008, 'Non autorisé');
      return;
    }
  }

  // Assign role
  ws.clientRole = determineClientRole(req);
  log(`Client WebSocket connecté (role: ${ws.clientRole})`);

  const features = featuresStore.readFeatures();
  const theme = themeLoader.getActiveTheme();

  ws.send(JSON.stringify({
    action: 'init',
    language: displayLanguage,
    highContrast: highContrastMode,
    captions: captionsEnabled,
    testPattern: testPatternEnabled,
    backgroundPattern,
    history: verseHistory,
    theme: themeLoader.themeToCss(theme),
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
  }));

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
    // applyTheme, obs-*, etc.) ne passent pas par ce gate et continuent de
    // fonctionner exactement comme avant.
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
        broadcast({ action: 'transcript', text, timestamp: Date.now(), source: sanitized.source || 'browser' });
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
        const verse = await bibleLookup.getVerseMultilang(ref, displayLanguage);
        const durationMs = sanitized.durationMs || getVerseDurationMs();
        broadcast({ action: 'showVerse', ...verse, durationMs, triggeredManually: true });
        pushHistory({ ...verse, triggeredManually: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: verseHistory });
      } catch (err) {
        ws.send(JSON.stringify({ action: 'error', error: err.message }));
      }
      return;
    }

    // --- Hide overlay ---
    if (sanitized.action === 'hideVerse') {
      broadcast({ action: 'hideVerse' });
      lastReference = null;
      return;
    }

    // --- Pre-service test ---
    if (sanitized.action === 'preServiceCheck') {
      try {
        const [groqResult, deepgramResult] = await Promise.all([
          groq.checkKey(),
          deepgramWrapper.checkKey(),
        ]);
        ws.send(JSON.stringify({
          action: 'preServiceCheckResult',
          wsConnected: true, wsAuthEnabled: !!WS_AUTH_TOKEN, wsHost: WS_HOST,
          groq: groqResult, deepgram: deepgramResult, timestamp: Date.now(),
        }));
      } catch (err) {
        ws.send(JSON.stringify({ action: 'error', error: 'Échec de la vérification pré-culte : ' + err.message }));
      }
      return;
    }

    // --- Language switch ---
    if (sanitized.action === 'setLanguage') {
      const lang = sanitized.language;
      if (['fr', 'en', 'both'].includes(lang)) {
        displayLanguage = lang;
        broadcast({ action: 'languageChanged', language: lang });
        log('Language changed: ' + lang);
      }
      return;
    }

    // --- Translation switch ---
    if (sanitized.action === 'setTranslation') {
      try {
        const newId = bibleLookup.setTranslation(sanitized.language, sanitized.code);
        broadcast({ action: 'translationChanged', language: sanitized.language, code: sanitized.code, translationId: newId });
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
        ws.send(JSON.stringify({ action: 'error', error: 'Référence invalide pour le mode lecture.' }));
        return;
      }
      try {
        const firstVerse = await readingMode.start(ref.book, ref.chapter, ref.verseStart);
        ws.send(JSON.stringify({ action: 'readingStarted', reference: ref }));
        if (firstVerse) {
          const label = bibleLookup.buildReferenceLabel({ book: ref.book, chapter: ref.chapter, verseStart: firstVerse.num }, displayLanguage);
          broadcast({ action: 'showVerse', reference: label, text: firstVerse.text, langMode: displayLanguage, durationMs: getVerseDurationMs(), readingMode: true });
          pushHistory({ reference: label, text: firstVerse.text.substring(0, 200), readingMode: true, timestamp: Date.now() });
          broadcast({ action: 'historyUpdated', history: verseHistory });
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
        ws.send(JSON.stringify({ action: 'searchError', error: 'Recherche biblique non disponible' }));
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
      ws.send(JSON.stringify({ action: 'topicsList', topics: semanticSearch ? semanticSearch.getTopics() : [] }));
      return;
    }

    // --- Get moods ---
    if (sanitized.action === 'getMoods') {
      ws.send(JSON.stringify({ action: 'moodsList', moods: themeGenerator ? themeGenerator.getMoods() : [] }));
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
      ws.send(JSON.stringify({ action: 'pluginsList', plugins: plugins ? plugins.getPluginList() : [] }));
      return;
    }

    if (sanitized.action === 'togglePlugin') {
      if (plugins) {
        plugins.setEnabled(sanitized.pluginName, sanitized.enabled);
        ws.send(JSON.stringify({ action: 'pluginToggled', pluginName: sanitized.pluginName, enabled: sanitized.enabled }));
      }
      return;
    }

    // --- AI stats ---
    if (sanitized.action === 'getAiStats') {
      ws.send(JSON.stringify({
        action: 'aiStats',
        semanticDetector: semanticDetector ? semanticDetector.getStats() : null,
        corrector: corrector ? corrector.getStats() : null,
        plugins: plugins ? plugins.metadata : null,
        aiEnricher: !!aiEnricher,
        loadErrors: aiLoadErrors,
      }));
      return;
    }

    // --- AI Live Summary (with prompt sanitization) ---
    if (sanitized.action === 'getLiveSummary') {
      if (!aiEnricher) {
        ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
        return;
      }
      const fullTranscript = sanitizeForPrompt(recentTranscripts.join(' '));
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
      const fullTranscript = sanitizeForPrompt(recentTranscripts.join(' '));
      const themeData = await aiEnricher.detectSermonTheme(fullTranscript);
      ws.send(JSON.stringify({ action: 'sermonTheme', ...themeData, silent: !!sanitized.silent, timestamp: Date.now() }));
      return;
    }

    // --- AI Post-Service Recap (with prompt sanitization) ---
    if (sanitized.action === 'getPostServiceRecap') {
      if (!aiEnricher) {
        ws.send(JSON.stringify({ action: 'error', error: 'AI Enricher non disponible' }));
        return;
      }
      // CORRECTIF (audit — mémoire des cultes) : utilisait recentTranscripts
      // (fenêtre glissante de 10 fragments, pensée pour un tout autre usage —
      // voir son commentaire), donc un "récap fin de culte" ne portait en
      // réalité que sur les dernières secondes du service. fullServiceTranscript
      // couvre tout le culte en cours (borné à 50 000 caractères).
      const fullTranscript = sanitizeForPrompt(fullServiceTranscript);
      const recap = await aiEnricher.generatePostServiceRecap(fullTranscript, verseHistory);
      ws.send(JSON.stringify({ action: 'postServiceRecap', recap, timestamp: Date.now() }));

      // AJOUT (audit — mémoire des cultes, gratuit/léger) : le clic "Récap
      // fin de culte" est le seul geste explicite de fin de service déjà
      // présent dans l'app — on l'utilise aussi pour archiver localement
      // (voir sermon-archive.js) et repartir à zéro pour le prochain culte.
      try {
        sermonArchive.saveServiceEntry({
          theme: recap && recap.title,
          keyPoints: recap && recap.keyPoints,
          transcriptExcerpt: fullServiceTranscript.slice(-4000),
          versesShown: verseHistory,
        });
        log('Culte archivé localement (sermon-archive.js)');
      } catch (err) {
        warn('Archivage du culte échoué: ' + err.message);
      }
      fullServiceTranscript = '';
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
      ws.send(JSON.stringify({ action: 'crossReferences', reference: sanitized.reference, results: refs }));
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
        broadcast({ action: 'showTranslation', translation, targetLang, reference: sanitized.reference || null });
      }
      ws.send(JSON.stringify({ action: 'textTranslated', original: sanitized.text, targetLang, translation, autoBroadcast: !!sanitized.autoBroadcast }));
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
      highContrastMode = !!sanitized.enabled;
      broadcast({ action: 'accessibilityMode', highContrast: highContrastMode });
      log('Accessibilité : mode grand contraste ' + (highContrastMode ? 'activé' : 'désactivé'));
      return;
    }

    // --- Accessibility: live caption strip (audit — free/light) ---
    if (sanitized.action === 'setCaptions') {
      captionsEnabled = !!sanitized.enabled;
      broadcast({ action: 'captionsMode', captions: captionsEnabled });
      log('Accessibilité : sous-titres ' + (captionsEnabled ? 'activés' : 'désactivés'));
      return;
    }

    // --- Display: test pattern (audit — affichage/sortie, free/light) ---
    if (sanitized.action === 'setTestPattern') {
      testPatternEnabled = !!sanitized.enabled;
      broadcast({ action: 'testPatternMode', enabled: testPatternEnabled });
      log('Affichage : motif de test ' + (testPatternEnabled ? 'activé' : 'désactivé'));
      return;
    }

    // --- Display: background pattern (audit — affichage/sortie, free/light) ---
    if (sanitized.action === 'setBackgroundPattern') {
      const allowed = ['none', 'dots', 'grid', 'diagonal'];
      const pattern = allowed.includes(sanitized.pattern) ? sanitized.pattern : 'none';
      backgroundPattern = pattern;
      broadcast({ action: 'backgroundPatternMode', pattern: backgroundPattern });
      log('Affichage : motif de fond -> ' + backgroundPattern);
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
  audioCapture.on({
    onAudioSegment: async (segmentFile) => {
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
        if (plugins) plugins.emit('onError', { type: 'transcription', message: err.message }).catch(() => {});
      } finally {
        try { fs.unlinkSync(segmentFile); } catch (_) {}
      }
    },
    onError: (err) => {
      warn('Audio capture error: ' + err.message);
      broadcast({ action: 'audioError', error: err.message });
    },
  });

  audioCapture.startBrowserCapture();

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
      wss.clients.forEach(ws => ws.close());
      wss.close();
      connRateLimiter.stopCleanup();
      if (parentPort) parentPort.postMessage({ type: 'status', status: 'stopped' });
      const finish = () => process.exit(0);
      if (plugins) {
        plugins.shutdown().catch(() => {}).finally(finish);
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
      obsGateOpen = msg.open;
      obsGateReason = msg.reason || '';
      log(`OBS gate: ${obsGateOpen ? 'OPEN' : 'CLOSED'} (${obsGateReason})`);
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
// Startup
// ===========================================================================
configValidator.validateSystemConfig()
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
  if (plugins) plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received');
  audioCapture.stopRecording();
  wss.close();
  if (plugins) plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  warn('Uncaught exception (arrêt du serveur): ' + (err && err.stack || err.message));
  try { audioCapture.cleanupTempFiles({ force: true }); } catch (_) {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = (reason && reason.stack) || (reason && reason.message) || String(reason);
  warn('Unhandled promise rejection (arrêt du serveur): ' + message);
  try { audioCapture.cleanupTempFiles({ force: true }); } catch (_) {}
  process.exit(1);
});
