# ChurchOverlay - Development Setup Guide

## Project Overview

ChurchOverlay is a real-time Bible verse overlay system for church services using speech-to-text transcription and OBS Studio integration. It's an Electron-based application with WebSocket server capabilities.

**Tech Stack:**

- Electron 43.3.0 (desktop app)
- Node.js 20.12+ (Node 22 recommended)
- TypeScript 5.6.3
- Express.js (HTTP server)
- WebSocket (real-time communication)
- SQLite (better-sqlite3, sqlite-vec for Bible search)
- ONNX Runtime (Silero VAD model)
- AI providers: Groq (primary), Deepgram (fallback), Google Gemini (optional)

## Environment Requirements

### System Requirements

- **Node.js**: 20.12+ (Node 22 recommended for Electron 43 compatibility)
- **npm**: 11.17.0+ (current version installed)
- **OS**: Windows 10+, Linux, macOS
- **Memory**: 4GB+ recommended
- **Storage**: ~2GB for node_modules and models

### Current Environment Status

- ✅ Node.js v24.19.0 installed
- ✅ npm 11.17.0 installed
- ❌ node_modules missing (needs npm install)
- ❌ .env file missing (needs creation from .env.example)

## Installation Steps

### 1. Navigate to Project Directory

```bash
cd "C:\Users\anare\Desktop\ChurchOverlay\ChurchOverlay-\ChurchOverlay-"
```

### 2. Install Dependencies

```bash
npm install
```

**Note:** The installation includes native modules that require rebuilding:

- `better-sqlite3` (SQLite database)
- `onnxruntime-node` (AI model runtime)
- `ffmpeg-static` (media processing)

### 3. Create Environment Configuration

```bash
cp .env.example .env
```

### 4. Configure API Keys (Minimum Required)

Edit `.env` and add at minimum:

```ini
GROQ_API_KEY=gsk_YOUR_KEY_HERE
```

**Optional API keys:**

- `DEEPGRAM_API_KEY` (fallback transcription)
- `GEMINI_API_KEY` (AI features - themes, enrichment)

**Get Groq API Key:** https://console.groq.com/keys

### 5. Windows Quick Setup (Alternative)

```bash
# Run the Windows batch script
install-dependencies.bat
```

This will:

- Verify Node.js installation
- Install npm dependencies
- Create .env from .env.example

## Development Commands

### Run Full Application (Electron + Audio Capture)

```bash
npm start
```

- Launches Electron app with setup window
- Microphone selection happens in-app (not via .env)
- Full pipeline: mic → Groq/Deepgram → verse detection → overlay

### Run WebSocket Server Only (No Audio Capture)

```bash
npm run server-only
```

- Runs server.js without Electron UI
- No microphone capture (requires browser context)
- Useful for testing WebSocket communication

### Development Mode

```bash
npm run dev
```

- Alias for `node server.js`

### Testing

```bash
# Full test suite
npm test

# Individual test files
node test/test-detector.js
node test/test-audio-capture.js
node test/test-bible-lookup-multilang.js

# E2E tests (requires Playwright)
npm run test:e2e

# Manual WebSocket test
node test/test-envoi.js
```

### Build & Quality Checks

```bash
# TypeScript compilation
npm run build:ts

# Type checking
npm run type-check

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:check

# Security audit
npm run security:audit
npm run security:fix
```

### Distribution Build

```bash
npm run dist
```

- Creates Windows installer via electron-builder
- Output: `dist/` directory

## Key Configuration Files

### TypeScript Configuration

- **tsconfig.json**: ES2022 target, Node16 module resolution, strict mode enabled
- **global.d.ts**: Type definitions for process.env and Electron IPC bridge

### Code Quality

- **eslint.config.js**: ESLint v10 flat config, supports JS/TS, separate configs for different file types
- **.prettierrc**: Prettier formatting (semi, single quotes, 100 char width)

### Build Configuration

- **package.json**: Electron builder config, scripts, dependencies
- **electron-builder**: Windows NSIS installer with auto-updater support

### Environment Configuration

- **.env.example**: Template for environment variables
- **config/features.json**: Runtime feature flags
- **config/themes/**: Theme definitions

## Project Structure

```
ChurchOverlay-/
├── main.js                    # Electron main process
├── server.js                  # WebSocket server (Node.js)
├── preload.js                 # Electron preload script (IPC bridge)
├── dashboard.html             # Operator dashboard UI
├── dashboard/                 # Dashboard modules (ESM)
│   ├── main.js
│   ├── state.js
│   ├── features/              # Feature modules
│   └── dashboard.css
├── overlay.html               # OBS browser source
├── overlay.js                 # Overlay rendering logic
├── setup.html                 # First-run setup screen
├── audio-capture.js           # Audio capture (getUserMedia)
├── audio-capture-worklet.js   # AudioWorklet for capture
├── detector.js                # Bible verse detection (French)
├── detector-en.js             # Bible verse detection (English)
├── bible-lookup-with-api.js   # Bible API integration
├── groq-wrapper.js            # Groq API wrapper
├── deepgram-wrapper.js        # Deepgram API wrapper
├── asr-engine.js              # ASR provider orchestration
├── silero-vad.js              # Voice activity detection
├── obs-controller.js          # OBS WebSocket control
├── theme-loader.js            # Theme management
├── ai-*.js                    # AI features (enrichment, themes)
├── models/                    # AI models (Silero VAD, Bible vectors)
├── test/                      # Test suite (80+ test files)
├── test/e2e/                  # Playwright E2E tests
└── config/                    # Configuration files
```

## API Key Requirements

### Required for Full Functionality

- **GROQ_API_KEY**: Primary transcription provider (Groq Whisper)
  - Get from: https://console.groq.com/keys
  - Format: starts with `gsk_`

### Optional but Recommended

- **DEEPGRAM_API_KEY**: Fallback transcription
  - Get from: https://console.deepgram.com/
  - Used if Groq fails or times out

### Optional AI Features

- **GEMINI_API_KEY**: Google Gemini for AI themes/enrichment
  - Falls back to GROQ_API_KEY if not set

## WebSocket Configuration

### Default Settings

- **Port**: 8765
- **Host**: 127.0.0.1 (localhost only)
- **Auth**: No auth required for localhost

### Production/LAN Setup

For remote access (OBS on different machine):

```ini
WS_HOST=0.0.0.0
WS_AUTH_TOKEN=16_char_random_string
WS_VIEWER_TOKEN=16_char_different_string
```

**Security Notes:**

- Keep WS_HOST=127.0.0.1 for local-only access
- Set both tokens when exposing beyond localhost
- Tokens must be ≥16 characters
- WS_VIEWER_TOKEN is for OBS overlay (read-only)
- WS_AUTH_TOKEN is for dashboard (full control)

## Audio Capture

### Current Implementation (v0.5.0+)

- Uses `getUserMedia` via hidden Electron window
- No FFmpeg dependency required
- Microphone selected in-app (setup window)
- Only works with `npm start` (Electron app)

### Legacy Note

- Old FFmpeg/DirectShow method removed in v0.5.0
- `node server.js` runs without microphone capture
- Audio capture requires Chromium browser context

## CI/CD Pipeline

### GitHub Actions (`.github/workflows/ci.yml`)

- **Node versions**: 20, 22
- **Steps**:
  1. Install dependencies (with electron binary check skip)
  2. Lint (ESLint)
  3. Format check (Prettier)
  4. Type check (TypeScript)
  5. Unit tests (npm test)
  6. E2E tests (Playwright)
  7. Security audit (npm audit)

### Build Workflow (`.github/workflows/build-windows.yml`)

- Windows-specific Electron build
- Creates NSIS installer
- Auto-updater integration

## Common Issues & Solutions

### Installation Issues

**Problem:** Native module build failures

```bash
# Solution: Rebuild native modules
npm rebuild better-sqlite3
npx @electron/rebuild
```

### Audio Capture Not Working

**Problem:** No microphone detection

- Ensure using `npm start` (not `node server.js`)
- Check Windows microphone permissions
- Verify microphone is not muted
- Use setup window to select correct device

### Transcription Not Starting

**Problem:** No transcription despite valid API keys

- Check GROQ_API_KEY format (should start with `gsk_`)
- Lower MIC_SILENCE_THRESHOLD in .env (try 0.005)
- Verify internet connection
- Check console for `[asr-engine]` errors

### TypeScript Errors

**Problem:** Type checking fails

```bash
# Solution: Rebuild types
npm run build:ts
npm run type-check
```

### E2E Test Failures

**Problem:** Playwright tests flaky

- Ensure server not already running on test port
- Check Playwright Chromium installation: `npx playwright install chromium`
- Run with debug: `npx playwright test --debug`

## Development Workflow

### Feature Development

1. Create feature branch
2. Make changes in appropriate modules
3. Run linting: `npm run lint:fix`
4. Run type check: `npm run type-check`
5. Run tests: `npm test`
6. Test manually with `npm start`
7. Commit changes

### Testing New Features

1. Write unit test in `test/` directory
2. Write E2E test in `test/e2e/` if UI changes
3. Run full test suite: `npm test`
4. Run E2E tests: `npm run test:e2e`

### Building for Production

1. Update version in package.json
2. Run quality checks: `npm run lint && npm run type-check && npm test`
3. Build distribution: `npm run dist`
4. Test installer on clean system

## Additional Resources

### Documentation

- **README.md**: Environment variables reference
- **SETUP.md**: Detailed installation guide
- **QUICKSTART-WINDOWS.md**: Windows-specific quick start
- **ARCHITECTURE.md**: Technical architecture (partially outdated)
- **SECURITY.md**: Security considerations
- **API.md**: WebSocket protocol (in docs/archive/)

### Mission & Development

- **JOURNAL-MISSION.md**: Development mission and roadmap
- **LICENCES-TRADUCTIONS.md**: Translation licenses

### Troubleshooting

- Check console logs for `[server]`, `[asr-engine]`, `[detector]` prefixes
- Logs are written to `logs/` folder (30-day retention)
- Use dashboard status indicators for pipeline health

## Support

### Getting Help

1. Check this guide and documentation files
2. Review console output and logs
3. Test with `node test/test-envoi.js` for WebSocket connectivity
4. Open GitHub issue with:
   - Node version: `node --version`
   - OS version
   - Console output from `npm start`
   - .env settings (without API keys)

### Community

- GitHub Issues: https://github.com/xtruck/ChurchOverlay-/issues
- Repository: https://github.com/xtruck/ChurchOverlay-

## Notes

- The project has extensive test coverage (80+ test files)
- Native modules require rebuilding after npm install
- Audio capture only works in Electron app, not standalone server
- Bible APIs are free and don't require keys
- The app supports both French and English verse detection
- AI features can work with Groq LLM if Gemini key not provided
