/**
 * ============================================================================
 * server.js — Pipeline audio → transcription cloud → détection de référence
 * biblique → overlay en temps réel (WebSocket)
 * ----------------------------------------------------------------------------
 * v1.0.0 — AI Innovation Pack (BULLETPROOF MODE)
 * All AI modules wrapped in try-catch. If any fail, app falls back to
 * original functionality. Zero crash guarantee.
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
// Core modules (REQUIRED — app won't start without these)
// ---------------------------------------------------------------------------
const audioCapture = require('./audio-capture');
const groq = require('./groq-wrapper');
const detector = require('./detector');
const bibleLookup = require('./bible-lookup-with-api');
const readingMode = require('./reading-mode');
const themeLoader = require('./theme-loader');
const featuresStore = require('./features-store');
const obsController = require('./obs-controller');

// ---------------------------------------------------------------------------
// NEW: AI modules (OPTIONAL — app works even if these fail to load)
// Each module is wrapped in try-catch with detailed logging
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

// Try to load each AI module individually
try {
  const mod = require('./semantic-detector');
  SemanticDetector = mod.SemanticDetector;
  if (groq.chatCompletion) {
    semanticDetector = new SemanticDetector(groq);
    console.log('[server] ✓ SemanticDetector loaded');
  } else {
    aiLoadErrors.push('SemanticDetector: groq.chatCompletion not available (update groq-wrapper.js)');
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
  corrector = new TranscriptionCorrector(groq);
  console.log('[server] ✓ TranscriptionCorrector loaded');
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
  themeGenerator = new AIThemeGenerator(groq);
  console.log('[server] ✓ AIThemeGenerator loaded');
} catch (e) {
  aiLoadErrors.push('AIThemeGenerator: ' + e.message);
  console.warn('[server] AIThemeGenerator disabled:', e.message);
}

if (aiLoadErrors.length > 0) {
  console.log('[server] ⚠ ' + aiLoadErrors.length + ' AI module(s) failed to load. App running in compatibility mode.');
  console.log('[server] To fix: npm install && ensure all AI .js files are present');
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8765 });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let displayLanguage = 'fr';
let lastReference = null;
let lastShownAt = 0;
const DEDUP_MS = 30_000;
const verseHistory = [];
const MAX_HISTORY = 20;
const recentTranscripts = [];
const MAX_CONTEXT_TRANSCRIPTS = 10;

// ---------------------------------------------------------------------------
// OBS gating state
// ---------------------------------------------------------------------------
let obsGateOpen = true;
let obsGateReason = '';

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------
const rateLimiter = { timestamps: [], windowMs: 60_000, max: 50 };
function isRateLimited() {
  const now = Date.now();
  rateLimiter.timestamps = rateLimiter.timestamps.filter(t => now - t < rateLimiter.windowMs);
  if (rateLimiter.timestamps.length >= rateLimiter.max) return true;
  rateLimiter.timestamps.push(now);
  return false;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function log(msg) {
  const line = `[server] ${msg}`;
  console.log(line);
  if (parentPort) parentPort.postMessage({ type: 'log', text: line, isError: false });
}
function warn(msg) {
  const line = `[server] ${msg}`;
  console.warn(line);
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
// Update transcript context for AI features
// ---------------------------------------------------------------------------
function updateTranscriptContext(text) {
  recentTranscripts.push(text);
  if (recentTranscripts.length > MAX_CONTEXT_TRANSCRIPTS) {
    recentTranscripts.shift();
  }
  if (semanticDetector) semanticDetector.addContext(text);
}

function getRecentContext(maxChars = 300) {
  const context = recentTranscripts.slice(-5).join(' ');
  return context.length > maxChars ? context.slice(-maxChars) : context;
}

// ===========================================================================
// MAIN PIPELINE: processTranscript
// ===========================================================================
async function processTranscript(text) {
  log('Processing transcript: ' + text.substring(0, 100));

  // ── Plugin hook (safe) ──
  if (plugins) {
    plugins.emit('onTranscript', text).catch(() => {});
  }

  // ── Voice Command Detection (safe) ──
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

  // ── Transcription Correction (safe) ──
  let correctedText = text;
  if (corrector) {
    try {
      correctedText = await corrector.correct(text, 'auto');
      if (correctedText !== text) {
        log('Transcription corrected: ' + correctedText.substring(0, 80) + '...');
        broadcast({ action: 'transcriptCorrected', original: text, corrected: correctedText });
      }
    } catch (e) {
      warn('Transcription correction error: ' + e.message);
    }
  }

  updateTranscriptContext(correctedText);

  // ── STEP 1: Regex/Fuzzy Bible Detection ──
  let reference = null;
  try {
    reference = detector.detectBilingual(correctedText);
  } catch (e) {
    warn('Detector error: ' + e.message);
  }

  // ── STEP 2: AI Semantic Detection (safe fallback) ──
  if (!reference && semanticDetector) {
    try {
      const semanticResult = await semanticDetector.detect(correctedText);
      if (semanticResult) {
        reference = semanticResult;
        log(`Semantic detection: ${semanticResult.raw} (confidence: ${semanticResult.confidence.toFixed(2)})`);
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

  // ── STEP 3: Quote-based detection ──
  if (!reference) {
    try {
      const quoted = bibleLookup.findByQuotedText(correctedText);
      if (quoted && quoted.score >= 0.55) {
        log(`Quote match: ${quoted.reference} (score: ${quoted.score.toFixed(2)})`);
        reference = { book: '', chapter: 0, verseStart: 0, detectedBy: 'quote' };
      }
    } catch (e) {
      // Quote detection not available, skip
    }
  }

  // ── No reference found ──
  if (!reference) return;

  // ── Rate limit check ──
  if (isRateLimited()) {
    warn('Rate limit hit — verse display skipped');
    return;
  }

  // ── Duplicate prevention ──
  const refKey = `${reference.book}:${reference.chapter}:${reference.verseStart || ''}`;
  const now = Date.now();
  if (lastReference === refKey && now - lastShownAt < DEDUP_MS) {
    log('Duplicate suppressed: ' + refKey);
    return;
  }
  lastReference = refKey;
  lastShownAt = now;

  // ── Lookup verse text ──
  let verse;
  try {
    if (reference.detectedBy === 'quote') {
      const quoted = bibleLookup.findByQuotedText(correctedText);
      verse = { reference: quoted.reference, text: quoted.text, provider: quoted.provider, lang: quoted.lang };
    } else {
      verse = await bibleLookup.getVerseMultilang(reference, displayLanguage);
    }
  } catch (err) {
    warn('Bible lookup failed: ' + err.message);
    broadcast({ action: 'error', error: 'Verset introuvable : ' + err.message });
    return;
  }

  // ── Plugin hook ──
  if (plugins) {
    plugins.emit('onVerseDetected', { ...verse, reference: verse.reference }).catch(() => {});
  }

  // ── AI Theme Generation (safe) ──
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

  // ── OBS gating ──
  const features = featuresStore.readFeatures();
  const multiScene = (features.broadcast || {}).multiScene || {};
  if (multiScene.enabled && !obsGateOpen) {
    log('OBS gate closed — verse buffered: ' + verse.reference);
    broadcast({ action: 'verseBuffered', reference: verse.reference, reason: obsGateReason });
    return;
  }

  // ── Display verse ──
  const durationMs = (features.display || {}).verseDurationMs || 300_000;
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
    theme: theme ? { name: theme.name, mood: theme.mood } : null,
  });

  pushHistory({
    reference: verse.reference,
    text: verse.text.substring(0, 200),
    timestamp: now,
    detectedBy: reference.detectedBy || 'regex',
  });
  broadcast({ action: 'historyUpdated', history: verseHistory });

  if (plugins) {
    plugins.emit('onVerseShown', { ...verse, reference: verse.reference }).catch(() => {});
  }

  log('Displayed: ' + verse.reference);
}

// ===========================================================================
// Voice Command Handler (safe)
// ===========================================================================
async function handleVoiceCommand(command, originalText) {
  switch (command.action) {
    case 'showVerse': {
      if (!command.reference) return;
      try {
        const verse = await bibleLookup.getVerseMultilang(command.reference, displayLanguage);
        broadcast({ action: 'showVerse', ...verse, durationMs: 300_000, triggeredByVoice: true });
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

    case 'nextVerse':
      broadcast({ action: 'nextVerse', triggeredByVoice: true });
      break;

    case 'previousVerse':
      broadcast({ action: 'previousVerse', triggeredByVoice: true });
      break;

    case 'nextChapter':
      broadcast({ action: 'nextChapter', triggeredByVoice: true });
      break;

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
      lastReference = null;
      log('Voice command: EMERGENCY CLEAR');
      break;
    }

    default:
      warn('Unknown voice command action: ' + command.action);
  }
}

// ===========================================================================
// WebSocket handlers
// ===========================================================================
wss.on('connection', (ws) => {
  log('Client WebSocket connecté');

  const features = featuresStore.readFeatures();
  const theme = themeLoader.getActiveTheme();

  ws.send(JSON.stringify({
    action: 'init',
    language: displayLanguage,
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
  }));

  ws.on('message', async (raw) => {
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
        sanitized[k] = msg[k].replace(/[<>"']/g, '');
      } else {
        sanitized[k] = msg[k];
      }
    }

    // ── Manual verse display ──
    if (sanitized.action === 'showVerse') {
      const ref = detector.parseReference(sanitized.reference);
      if (!ref) {
        ws.send(JSON.stringify({ action: 'error', error: 'Référence invalide.' }));
        return;
      }
      try {
        const verse = await bibleLookup.getVerseMultilang(ref, displayLanguage);
        const durationMs = sanitized.durationMs || 300_000;
        broadcast({ action: 'showVerse', ...verse, durationMs, triggeredManually: true });
        pushHistory({ ...verse, triggeredManually: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: verseHistory });
      } catch (err) {
        ws.send(JSON.stringify({ action: 'error', error: err.message }));
      }
      return;
    }

    // ── Hide overlay ──
    if (sanitized.action === 'hideVerse') {
      broadcast({ action: 'hideVerse' });
      lastReference = null;
      return;
    }

    // ── Language switch ──
    if (sanitized.action === 'setLanguage') {
      const lang = sanitized.language;
      if (['fr', 'en', 'both'].includes(lang)) {
        displayLanguage = lang;
        broadcast({ action: 'languageChanged', language: lang });
        log('Language changed: ' + lang);
      }
      return;
    }

    // ── Translation switch ──
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

    // ── Reading mode ──
    if (sanitized.action === 'startReading') {
      const ref = detector.parseReference(sanitized.reference);
      if (!ref) {
        ws.send(JSON.stringify({ action: 'error', error: 'Référence invalide pour le mode lecture.' }));
        return;
      }
      try {
        await readingMode.start(ref, displayLanguage, (verse) => {
          broadcast({ action: 'showVerse', ...verse, durationMs: 300_000, readingMode: true });
          pushHistory({ ...verse, readingMode: true, timestamp: Date.now() });
          broadcast({ action: 'historyUpdated', history: verseHistory });
        });
        ws.send(JSON.stringify({ action: 'readingStarted', reference: ref }));
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

    // ── Bible Semantic Search ──
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

    // ── Get topics ──
    if (sanitized.action === 'getTopics') {
      ws.send(JSON.stringify({
        action: 'topicsList',
        topics: semanticSearch ? semanticSearch.getTopics() : [],
      }));
      return;
    }

    // ── Get moods ──
    if (sanitized.action === 'getMoods') {
      ws.send(JSON.stringify({
        action: 'moodsList',
        moods: themeGenerator ? themeGenerator.getMoods() : [],
      }));
      return;
    }

    // ── Set theme by mood ──
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

    // ── Plugin management ──
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

    // ── AI stats ──
    if (sanitized.action === 'getAiStats') {
      ws.send(JSON.stringify({
        action: 'aiStats',
        semanticDetector: semanticDetector ? semanticDetector.getStats() : null,
        corrector: corrector ? corrector.getStats() : null,
        plugins: plugins ? plugins.metadata : null,
        loadErrors: aiLoadErrors,
      }));
      return;
    }

    // ── Theme application ──
    if (sanitized.action === 'applyTheme') {
      broadcast({ action: 'applyTheme', ...sanitized.css });
      return;
    }

    // ── Ping ──
    if (sanitized.action === 'ping') {
      ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
      return;
    }
  });

  ws.on('close', () => log('Client WebSocket déconnecté'));
  ws.on('error', (err) => warn('WebSocket error: ' + err.message));
});

// ===========================================================================
// Audio pipeline
// ===========================================================================
function startPipeline() {
  audioCapture.on({
    onAudioSegment: async (segmentFile) => {
      try {
        const result = await groq.transcribeWithFallback(segmentFile);
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

  log('Pipeline démarré sur ws://localhost:8765');
  if (aiLoadErrors.length > 0) {
    log('⚠ ' + aiLoadErrors.length + ' AI feature(s) disabled (see logs above)');
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
      wss.clients.forEach(ws => ws.close());
      wss.close();
      if (plugins) plugins.shutdown().catch(() => {});
      if (parentPort) parentPort.postMessage({ type: 'status', status: 'stopped' });
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

// ===========================================================================
// Startup
// ===========================================================================
startPipeline();

process.on('SIGTERM', () => {
  log('SIGTERM received');
  audioCapture.stopRecording();
  wss.close();
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
  warn('Uncaught exception: ' + (err && err.stack || err.message));
  audioCapture.cleanupTempFiles({ force: true });
});
