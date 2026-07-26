# Environment Variables Reference

## Quick Start

```bash
# 1. Copy example to .env (never commit .env!)
cp .env.example .env

# 2. Edit .env with your values
code .env

# 3. Start the app — the microphone is chosen from the on-screen
#    setup window on first run (getUserMedia device picker), not
#    from .env or a CLI tool.
npm start
```

## Configuration Reference

### WebSocket Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8765 | WebSocket server port |
| `WS_HOST` | 127.0.0.1 | Binding address (127.0.0.1 = local only) |

**Security Note:** Keep `WS_HOST=127.0.0.1` to prevent remote connections. Only change to `0.0.0.0` for testing.

### Audio & Capture

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIO_DEVICE` | (auto) | Browser `deviceId` of the microphone, chosen from the setup window — not a device name, and not meant to be hand-edited |

**Note:** since v0.5.0 audio capture uses `getUserMedia` inside a hidden
Electron window (see `capture.html`/`audio-capture.js`), not FFmpeg. This
only works through the packaged app (`npm start`) — running `node server.js`
standalone has no Chromium context to request the microphone, so capture
stays disabled in that mode.

### Speech-to-Text

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | (optional) | Cloud transcription key from https://console.groq.com/keys |
| `NODE_ENV` | production | Environment (development/production/test) |

**How it works:**
- `GROQ_API_KEY` is the primary transcription provider (cloud, Whisper large-v3).
- `DEEPGRAM_API_KEY` (optional) is used as a fallback if Groq fails or times out.
- There is no local/offline transcription anymore (local Whisper was removed) —
  at least `GROQ_API_KEY` should be set for verse detection to work.

**Get Groq API Key:**
1. Go to https://console.groq.com/keys
2. Sign up or log in
3. Create new API key
4. Paste into `.env`: `GROQ_API_KEY=gsk_xxxxxx...`

### Bible Content

| Variable | Default | Description |
|----------|---------|-------------|
| `BIBLE_PROVIDER` | both | Source (local/api/both) |
| `BIBLE_API_KEY` | (optional) | For premium Bible APIs |

**How it works:**
- `local`: Uses `bible-lsg.json` if available (fastest)
- `api`: Uses free online Bible APIs (no key needed)
- `both`: Tries local first, falls back to API

**Note:** System uses FREE Bible APIs by default. No API key needed!

### Logging & Debug

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | false | Verbose logging (true/false) |

**Enable debug:**
```ini
DEBUG=true
```

Then watch the console for detailed logs:
```
[server] Message validated from client #1: showVerse
[detector] Detected: jean 3:16
[bible-lookup] ✓ Got verse from genuinegospel
[server] Verse sent to overlay: Jean 3:16
```

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONNECTIONS` | 10 | Max WebSocket connections per IP |
| `MAX_MESSAGES_PER_MINUTE` | 60 | Max messages per IP per minute |
| `VALIDATE_MESSAGES` | true | Enable message validation |

**For production (church service):**
- Keep defaults
- `VALIDATE_MESSAGES=true` (prevent XSS attacks)
- `MAX_CONNECTIONS=10` (prevents DDoS)

## Examples

### Minimal Setup
```ini
PORT=8765
NODE_ENV=production
```

### Full Setup (Cloud + Local Fallback)
```ini
PORT=8765
GROQ_API_KEY=gsk_YOUR_KEY_HERE
NODE_ENV=production
DEBUG=false
```

### Development/Testing
```ini
PORT=8765
NODE_ENV=development
DEBUG=true
```

## Secrets Management

**NEVER commit `.env` to git!** It's already in `.gitignore`.

**Safe way to store production keys:**
1. Use `.env.example` for documentation
2. Create `.env` locally (git-ignored)
3. For servers, use environment variables directly (Heroku, Docker, etc.)
4. For GitHub secrets, use the Secrets UI (not the repo)

## Validation

**Check your setup:**
```bash
# Lists all current environment variables
node -e "console.log(process.env)"

# Test a specific variable
node -e "console.log('AUDIO_DEVICE:', process.env.AUDIO_DEVICE)"
```

**Run tests:**
```bash
# Full test suite
npm test

# Individual tests
node tests/test-config-validator.js
node tests/test-validation.js
```

## Troubleshooting

### "No microphone selected" / wrong microphone
Run the packaged app (`npm start`) and use the setup window (or the
"change microphone" button on the dashboard) to pick a device — the list
comes from the browser's own `enumerateDevices()`, the same one Windows
Settings sees. There's no `.env` device name to edit anymore.

### "GROQ_API_KEY invalid"
```bash
# Check key format:
# Should start with "gsk_"
# Get new key from https://console.groq.com/keys
# Make sure you copied the FULL key
```

## Next Steps

- Read `SETUP.md` for full installation guide
- Read `API.md` for WebSocket protocol
- Read `ARCHITECTURE.md` for technical details
