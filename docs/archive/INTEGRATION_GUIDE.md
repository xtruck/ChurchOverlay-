# 🚀 ChurchOverlay AI Integration Guide

## Overview

This guide shows you how to integrate the new AI-powered modules into your existing ChurchOverlay application.

## 📦 Files to Add

Copy these files into your project root (same folder as `server.js`):

```
churchoverlay/
├── semantic-detector.js          ← NEW: AI implicit verse detection
├── voice-commands.js             ← NEW: Hands-free voice control
├── transcription-corrector.js    ← NEW: Biblical STT post-processor
├── bible-semantic-search.js      ← NEW: Topic-based verse search
├── plugin-system.js              ← NEW: Extensible plugin architecture
├── ai-theme-generator.js         ← NEW: Dynamic theme generation
├── auto-updater.js               ← NEW: Automatic updates
└── config/
    └── plugins/                  ← NEW: Plugin directory (create this)
```

## 🔧 Step 1: Update package.json

Add `electron-updater` to dependencies:

```json
"dependencies": {
  "form-data": "^4.0.6",
  "ws": "^8.21.1",
  "obs-websocket-js": "^5.0.6",
  "electron-updater": "^6.3.0"
}
```

Then run:

```bash
npm install
```

## 🔧 Step 2: Update server.js

### 2.1 Add requires at the top

```javascript
// After existing requires, add:
const { SemanticDetector } = require('./semantic-detector');
const { detectCommand } = require('./voice-commands');
const { TranscriptionCorrector } = require('./transcription-corrector');
const { BibleSemanticSearch } = require('./bible-semantic-search');
const { PluginSystem } = require('./plugin-system');
const { AIThemeGenerator } = require('./ai-theme-generator');
```

### 2.2 Initialize new modules

```javascript
// After existing initializations, add:
const semanticDetector = new SemanticDetector(groq);
const corrector = new TranscriptionCorrector(groq);
const semanticSearch = new BibleSemanticSearch();
semanticSearch.loadIndex();
const plugins = new PluginSystem();
plugins.loadFromDirectory(path.join(__dirname, 'config', 'plugins'));
const themeGenerator = new AIThemeGenerator(groq);
```

### 2.3 Modify processTranscript() — Add voice commands + semantic detection

Find the `processTranscript` function and add this at the very beginning:

```javascript
async function processTranscript(text) {
  console.log('[server] Processing transcript:', text.substring(0, 100));

  // ── NEW: Voice Command Detection (before verse detection) ──
  const command = detectCommand(text);
  if (command) {
    console.log('[server] Voice command detected:', command.action);

    if (command.action === 'showVerse' && command.reference) {
      // Direct verse display from voice
      try {
        const verse = await bibleLookup.getVerseMultilang(command.reference, displayLanguage);
        broadcast({ action: 'showVerse', ...verse, durationMs: 300000, triggeredByVoice: true });
        pushHistory({ ...verse, triggeredByVoice: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: verseHistory });
      } catch (err) {
        console.warn('[server] Voice command verse lookup failed:', err.message);
      }
    } else if (command.action === 'hideVerse') {
      broadcast({ action: 'hideVerse', triggeredByVoice: true });
    } else if (
      command.action === 'nextVerse' ||
      command.action === 'previousVerse' ||
      command.action === 'nextChapter'
    ) {
      // Forward to reading mode or overlay
      broadcast({ action: command.action, triggeredByVoice: true });
    } else if (command.action === 'setTheme') {
      const theme = themeGenerator.getTheme(command.theme);
      broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme) });
    } else if (command.action === 'setLanguage') {
      displayLanguage = command.language;
      broadcast({ action: 'languageChanged', language: displayLanguage, triggeredByVoice: true });
    } else if (command.action === 'setTranslation') {
      const newId = bibleLookup.setTranslation(command.language, command.code);
      broadcast({
        action: 'translationChanged',
        language: command.language,
        code: command.code,
        translationId: newId,
        triggeredByVoice: true,
      });
    } else if (command.action === 'extendTime') {
      broadcast({ action: 'extendTime', extraMs: command.extraMs, triggeredByVoice: true });
    } else if (command.action === 'pauseTimer') {
      broadcast({ action: 'pauseTimer', triggeredByVoice: true });
    } else if (command.action === 'resumeTimer') {
      broadcast({ action: 'resumeTimer', triggeredByVoice: true });
    } else if (command.action === 'emergencyClear') {
      broadcast({ action: 'hideVerse', emergency: true });
      broadcast({ action: 'emergencyClear' });
    }

    // Emit to plugins
    plugins.emit('onTranscript', text);
    return; // Command consumed, don't process as verse
  }

  // ── NEW: Transcription correction ──
  const correctedText = await corrector.correct(text);
  if (correctedText !== text) {
    console.log('[server] Transcription corrected:', correctedText.substring(0, 80));
  }
  const textToProcess = correctedText;

  // ── NEW: Semantic detection (if regex fails) ──
  let reference = detectBilingual(textToProcess);

  if (!reference) {
    // Try AI semantic detection
    const semanticResult = await semanticDetector.detect(textToProcess);
    if (semanticResult) {
      reference = semanticResult;
      console.log(
        `[server] Semantic detection: ${semanticResult.raw} (${semanticResult.reasoning})`
      );
    }
  }

  // ... rest of existing processTranscript logic ...
}
```

### 2.4 Add semantic search to WebSocket handlers

In the `ws.on('message', ...)` handler, add a new action:

```javascript
if (sanitized.action === 'searchBible') {
  const query = String(sanitized.query || '').trim();
  if (!query) {
    ws.send(JSON.stringify({ action: 'error', error: 'Query required.' }));
    return;
  }

  try {
    const results = await semanticSearch.search(query, sanitized.topK || 5);
    ws.send(
      JSON.stringify({
        action: 'searchResults',
        query,
        results,
        timestamp: Date.now(),
      })
    );
  } catch (err) {
    ws.send(JSON.stringify({ action: 'searchError', query, error: err.message }));
  }
  return;
}
```

### 2.5 Add theme auto-generation on verse display

In the verse lookup success path (after `bibleLookup.getVerseMultlang`), add:

```javascript
// Auto-generate theme based on verse content
const recentContext = transcript.getRecent ? transcript.getRecent(200) : '';
const theme = await themeGenerator.generate(verse.text, recentContext, 'auto');
if (theme.source === 'ai' || theme.mood !== 'default') {
  broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme) });
}
```

### 2.6 Add plugin hooks throughout pipeline

Add these calls at key points:

```javascript
// After transcription:
plugins.emit('onTranscript', result.text);

// After verse detection:
plugins.emit('onVerseDetected', verse);

// After verse display:
plugins.emit('onVerseShown', verse);

// On error:
plugins.emit('onError', error);
```

## 🔧 Step 3: Update main.js for Auto-Updater

Add at the top:

```javascript
const { initAutoUpdater } = require('./auto-updater');
```

After `app.whenReady()`, add:

```javascript
// Initialize auto-updater
initAutoUpdater(mainWindow, {
  SILENT_INSTALL: false, // Set true for silent updates
  SHOW_NOTIFICATION: true,
});
```

## 🔧 Step 4: Update overlay.html

### 4.1 Add theme CSS variables support

In your overlay CSS, add:

```css
:root {
  --overlay-bg: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  --overlay-text: #ffffff;
  --overlay-accent: #e94560;
  --overlay-font: 'Playfair Display', Georgia, serif;
  --overlay-border: rgba(255, 255, 255, 0.1);
  --overlay-glow: rgba(233, 69, 96, 0.3);
  --overlay-shadow: rgba(0, 0, 0, 0.5);
}

.verse-container {
  background: var(--overlay-bg);
  color: var(--overlay-text);
  font-family: var(--overlay-font);
  border: 1px solid var(--overlay-border);
  box-shadow:
    0 0 30px var(--overlay-glow),
    0 10px 40px var(--overlay-shadow);
}
```

### 4.2 Handle new actions in WebSocket

Add handlers for:

- `applyTheme` — update CSS variables
- `emergencyClear` — immediate hide with animation
- `triggeredByVoice` — show small voice indicator

## 🔧 Step 5: Update dashboard.html

### 5.1 Add Bible Search UI

Add a search box:

```html
<div class="search-section">
  <input type="text" id="bibleSearch" placeholder="Rechercher un sujet biblique..." />
  <button onclick="searchBible()">🔍 Rechercher</button>
  <div id="searchResults"></div>
</div>
```

Add JavaScript:

```javascript
function searchBible() {
  const query = document.getElementById('bibleSearch').value;
  ws.send(JSON.stringify({ action: 'searchBible', query }));
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.action === 'searchResults') {
    displaySearchResults(msg.results);
  }
  // ... existing handlers ...
};
```

### 5.2 Add Voice Command Indicator

Show when voice commands are detected:

```html
<div id="voiceIndicator" class="hidden">🎤 Commande vocale détectée</div>
```

### 5.3 Add Theme Preview

Show current mood/theme:

```html
<div id="themeIndicator">Thème: <span id="currentTheme">Défaut</span></div>
```

## 🔧 Step 6: Update electron-builder config

In `package.json` build section, add:

```json
"publish": {
  "provider": "github",
  "owner": "xtruck",
  "repo": "xtruck",
  "releaseType": "release"
}
```

## 🧪 Testing

### Test Voice Commands

1. Start the app
2. Speak: "Montre Jean 3:16"
3. Verify verse appears
4. Speak: "Cache l'overlay"
5. Verify overlay hides

### Test Semantic Detection

1. Say: "le passage où Jésus marche sur l'eau"
2. Check logs for `[semantic] Detected: Matthieu 14:25`
3. Verify verse appears in overlay

### Test Transcription Correction

1. Say: "Moise a conduit le peuple"
2. Check that transcript shows "Moïse" not "Moise"

### Test Bible Search

1. In dashboard, search "forgiveness"
2. Verify results include Ephesians 4:32

### Test Dynamic Themes

1. Say a verse about joy
2. Verify overlay changes to gold/orange theme
3. Say a verse<response clipped><NOTE>Result is longer than **10000 characters**, will be **truncated**.</NOTE>
