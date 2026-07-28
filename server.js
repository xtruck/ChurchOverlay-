/**
 * ============================================================================
 * server.js — Pipeline audio → transcription cloud → détection de référence
 * biblique → overlay en temps réel (WebSocket)
 * ----------------------------------------------------------------------------
 * CHANGELOG v1.0.0 — AI Innovation Pack Integration
 * - Voice Commands: detectCommand() runs BEFORE verse detection
 * - Transcription Correction: correctFast() + correctSmart() after STT
 * - Semantic Detection: AI-powered implicit verse detection when regex fails
 * - Bible Semantic Search: topic-based verse search via WebSocket API
 * - AI Theme Generator: auto-generates themes based on verse mood
 * - Plugin System: hooks throughout the pipeline
 * - All existing features preserved: reading mode, OBS gating, rate limiting,
 *   duplicate prevention, multi-language, translation switching, etc.
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
// Core modules
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
// NEW: AI Innovation Pack modules
// ---------------------------------------------------------------------------
const { SemanticDetector } = require('./semantic-detector');
const { detectCommand } = require('./voice-commands');
const { TranscriptionCorrector } = require('./transcription-corrector');
const { BibleSemanticSearch } = require('./bible-semantic-search');
const { PluginSystem } = require('./plugin-system');
const { AIThemeGenerator } = require('./ai-theme-generator');

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const WebSocket = require('ws');
const SERVER_PORT = parseInt(process.env.PORT, 10) || 8765;
const wss = new WebSocket.Server({ port: SERVER_PORT });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let displayLanguage = 'fr'; // 'fr' | 'en' | 'both'
let lastReference = null;
let lastShownAt = 0;
const DEDUP_MS = 30_000;
const verseHistory = [];
const MAX_HISTORY = 20;

// NEW: AI module instances
const semanticDetector = new SemanticDetector(groq);
const corrector = new TranscriptionCorrector(groq);
const semanticSearch = new BibleSemanticSearch();
const plugins = new PluginSystem();
const themeGenerator = new AIThemeGenerator(groq);

// NEW: Load plugins from config/plugins directory
const pluginsDir = path.join(APP_ROOT, 'config', 'plugins');
if (fs.existsSync(pluginsDir)) {
  plugins.loadFromDirectory(pluginsDir);
}

// NEW: Load semantic search index (async, non-blocking)
semanticSearch.loadIndex().catch(() => {});

// NEW: Recent transcript context for AI features
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
// NEW: Update transcript context for AI features
// ---------------------------------------------------------------------------
function updateTranscriptContext(text) {
  recentTranscripts.push(text);
  if (recentTranscripts.length > MAX_CONTEXT_TRANSCRIPTS) {
    recentTranscripts.shift();
  }
  semanticDetector.addContext(text);
}

// ---------------------------------------------------------------------------
// NEW: Build recent context string for theme generation
// ---------------------------------------------------------------------------
function getRecentContext(maxChars = 300) {
  const context = recentTranscripts.slice(-5).join(' ');
  return context.length > maxChars ? context.slice(-maxChars) : context;
}

// ===========================================================================
// MAIN PIPELINE: processTranscript
// ===========================================================================
async function processTranscript(text) {
  log('Processing transcript: ' + text.substring(0, 100));

  // ── NEW: Plugin hook ──
  plugins.emit('onTranscript', text).catch(() => {});

  // ── NEW: Voice Command Detection (runs BEFORE everything else) ──
  const command = detectCommand(text);
  if (command) {
    log('Voice command detected: ' + command.action);
    await handleVoiceCommand(command, text);
    return; // Command consumed — don't process as verse
  }

  // ── NEW: Transcription Correction ──
  let correctedText = text;
  try {
    correctedText = await corrector.correct(text, 'auto');
    if (correctedText !== text) {
      log('Transcription corrected: ' + correctedText.substring(0, 80) + '...');
      broadcast({ action: 'transcriptCorrected', original: text, corrected: correctedText });
    }
  } catch (err) {
    warn('Transcription correction failed: ' + err.message);
  }

  // Update context with (corrected) transcript
  updateTranscriptContext(correctedText);

  // ── STEP 1: Regex/Fuzzy Bible Detection ──
  let reference = detector.detectBilingual(correctedText);

  // ── NEW: STEP 2 — AI Semantic Detection (when regex fails) ──
  if (!reference) {
    try {
      const semanticResult = await semanticDetector.detect(correctedText);
      if (semanticResult) {
        reference = semanticResult;
        log(`Semantic detection: ${semanticResult.raw} (confidence: ${semanticResult.confidence.toFixed(2)}) — ${semanticResult.reasoning}`);
        broadcast({
          action: 'semanticDetected',
          reference: semanticResult.raw,
          confidence: semanticResult.confidence,
          reasoning: semanticResult.reasoning,
          alternativeRefs: semanticResult.alternativeRefs,
        });
      }
    } catch (err) {
      warn('Semantic detection error: ' + err.message);
    }
  }

  // ── STEP 3: Quote-based detection (existing feature, from cache) ──
  if (!reference) {
    const quoted = bibleLookup.findByQuotedText(correctedText);
    if (quoted && quoted.score >= 0.55) {
      log(`Quote match: ${quoted.reference} (score: ${quoted.score.toFixed(2)})`);
      reference = { book: '', chapter: 0, verseStart: 0, detectedBy: 'quote' };
      // We'll use the cached verse directly below
    }
  }

  // ── No reference found ──
  if (!reference) {
    return;
  }

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
    if (reference.detectedBy === 'quote' && bibleLookup.findByQuotedText(correctedText)) {
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

  // ── NEW: Plugin hook ──
  plugins.emit('onVerseDetected', { ...verse, reference: verse.reference }).catch(() => {});

  // ── NEW: AI Theme Generation ──
  let theme = null;
  try {
    const recentContext = getRecentContext();
    theme = await themeGenerator.generate(verse.text, recentContext, 'auto');
    if (theme && (theme.source === 'ai' || theme.mood !== 'default')) {
      log(`Theme applied: "${theme.name}" (${theme.mood || 'default'})`);
      broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme) });
    }
  } catch (err) {
    warn('Theme generation failed: ' + err.message);
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

  // ── History ──
  pushHistory({
    reference: verse.reference,
    text: verse.text.substring(0, 200),
    timestamp: now,
    detectedBy: reference.detectedBy || 'regex',
  });
  broadcast({ action: 'historyUpdated', history: verseHistory });

  // ── NEW: Plugin hook ──
  plugins.emit('onVerseShown', { ...verse, reference: verse.reference }).catch(() => {});

  log('Displayed: ' + verse.reference);
}

// ===========================================================================
// NEW: Voice Command Handler
// ===========================================================================
async function handleVoiceCommand(command, originalText) {
  switch (command.action) {
    case 'showVerse': {
      if (!command.reference) return;
      try {
        const verse = await bibleLookup.getVerseMultilang(command.reference, displayLanguage);
        const durationMs = 300_000;
        broadcast({ action: 'showVerse', ...verse, durationMs, triggeredByVoice: true });
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
      log('Voice command: next verse');
      break;

    case 'previousVerse':
      broadcast({ action: 'previousVerse', triggeredByVoice: true });
      log('Voice command: previous verse');
      break;

    case 'nextChapter':
      broadcast({ action: 'nextChapter', triggeredByVoice: true });
      log('Voice command: next chapter');
      break;

    case 'setTheme': {
      const theme = themeGenerator.getTheme(command.theme);
      broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme), triggeredByVoice: true });
      log('Voice command: theme ' + command.theme);
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
      log('Voice command: extend time +' + command.extraMs + 'ms');
      break;

    case 'pauseTimer':
      broadcast({ action: 'pauseTimer', triggeredByVoice: true });
      log('Voice command: pause timer');
      break;

    case 'resumeTimer':
      broadcast({ action: 'resumeTimer', triggeredByVoice: true });
      log('Voice command: resume timer');
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

  // Send current state to new client
  const features = featuresStore.readFeatures();
  const theme = themeLoader.getActiveTheme();
  ws.send(JSON.stringify({
    action: 'init',
    language: displayLanguage,
    history: verseHistory,
    theme: themeLoader.themeToCss(theme),
    translations: bibleLookup.listTranslations(),
    plugins: plugins.getPluginList(),
    aiFeatures: {
      semanticDetection: true,
      voiceCommands: true,
      transcriptionCorrection: true,
      dynamicThemes: true,
      bibleSearch: true,
    },
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

    // ── NEW: Bible Semantic Search ──
    if (sanitized.action === 'searchBible') {
      const query = String(sanitized.query || '').trim();
      if (!query) {
        ws.send(JSON.stringify({ action: 'error', error: 'Requête requise.' }));
        return;
      }
      try {
        const results = await semanticSearch.search(query, sanitized.topK || 5);
        ws.send(JSON.stringify({
          action: 'searchResults',
          query,
          results,
          timestamp: Date.now(),
        }));
      } catch (err) {
        ws.send(JSON.stringify({ action: 'searchError', query, error: err.message }));
      }
      return;
    }

    // ── NEW: Get available topics ──
    if (sanitized.action === 'getTopics') {
      ws.send(JSON.stringify({
        action: 'topicsList',
        topics: semanticSearch.getTopics(),
      }));
      return;
    }

    // ── NEW: Get available moods ──
    if (sanitized.action === 'getMoods') {
      ws.send(JSON.stringify({
        action: 'moodsList',
        moods: themeGenerator.getMoods(),
      }));
      return;
    }

    // ── NEW: Set theme by mood ──
    if (sanitized.action === 'setMoodTheme') {
      const mood = sanitized.mood;
      const theme = themeGenerator.getTheme(mood);
      broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme) });
      ws.send(JSON.stringify({ action: 'themeApplied', mood, themeName: theme.name }));
      return;
    }

    // ── NEW: Plugin management ──
    if (sanitized.action === 'listPlugins') {
      ws.send(JSON.stringify({ action: 'pluginsList', plugins: plugins.getPluginList() }));
      return;
    }

    if (sanitized.action === 'togglePlugin') {
      plugins.setEnabled(sanitized.pluginName, sanitized.enabled);
      ws.send(JSON.stringify({ action: 'pluginToggled', pluginName: sanitized.pluginName, enabled: sanitized.enabled }));
      return;
    }

    // ── NEW: AI stats ──
    if (sanitized.action === 'getAiStats') {
      ws.send(JSON.stringify({
        action: 'aiStats',
        semanticDetector: semanticDetector.getStats(),
        corrector: corrector.getStats(),
        plugins: plugins.metadata,
      }));
      return;
    }

    // ── Theme application (from main.js) ──
    if (sanitized.action === 'applyTheme') {
      broadcast({ action: 'applyTheme', ...sanitized.css });
      return;
    }

    // ── Ping / keepalive ──
    if (sanitized.action === 'ping') {
      ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
      return;
    }
  });

  ws.on('close', () => {
    log('Client WebSocket déconnecté');
  });

  ws.on('error', (err) => {
    warn('WebSocket error: ' + err.message);
  });
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
        plugins.emit('onError', { type: 'transcription', message: err.message }).catch(() => {});
      } finally {
        // Cleanup temp file
        try { fs.unlinkSync(segmentFile); } catch (_) {}
      }
    },
    onError: (err) => {
      warn('Audio capture error: ' + err.message);
      broadcast({ action: 'audioError', error: err.message });
    },
  });

  audioCapture.startBrowserCapture();

  // Signal main.js that pipeline is ready for audio chunks
  if (parentPort) {
    parentPort.postMessage({ type: 'audio-pipeline-ready' });
  }

  log('Pipeline démarré sur ws://localhost:8765');
}

// ===========================================================================
// Worker IPC (from main.js)
// ===========================================================================
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'shutdown') {
      log('Shutdown requested by main process');
      audioCapture.stopRecording();
      wss.clients.forEach(ws => ws.close());
      wss.close();
      plugins.shutdown().catch(() => {});
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

// Graceful shutdown on SIGTERM/SIGINT
process.on('SIGTERM', () => {
  log('SIGTERM received');
  audioCapture.stopRecording();
  wss.close();
  plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received');
  audioCapture.stopRecording();
  wss.close();
  plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  warn('Uncaught exception: ' + (err && err.stack || err.message));
  audioCapture.cleanupTempFiles({ force: true });
});
