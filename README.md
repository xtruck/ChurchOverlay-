# Environment Variables Reference

## Quick Start

Requires **Node.js 20.12+**, **Node 22 recommended** (Electron 43's installer
fails to load `@electron/get` on some Node 20 releases).

```bash
npm install

# Full desktop app: the Groq/Deepgram keys and the microphone are entered in
# the in-app setup screen and stored encrypted in Electron's userData folder.
# No .env needed.
npm start

# WebSocket server alone (no microphone: browser capture needs Electron).
# This mode reads .env if present — useful to test the pipeline headless.
cp .env.example .env   # then fill in GROQ_API_KEY
npm run server-only
```

**Where do the API keys live?**

| How you run it                 | Source of `GROQ_API_KEY` / `DEEPGRAM_API_KEY`                      |
| ------------------------------ | ------------------------------------------------------------------ |
| `npm start` / installed `.exe` | Setup window → encrypted in `userData/config.json` (`safeStorage`) |
| `npm run server-only`          | Real environment variables, or `.env` at the repo root             |

## Configuration Reference

### WebSocket Server

| Variable  | Default   | Description                              |
| --------- | --------- | ---------------------------------------- |
| `PORT`    | 8765      | WebSocket server port                    |
| `WS_HOST` | 127.0.0.1 | Binding address (127.0.0.1 = local only) |

**Security Note:** Keep `WS_HOST=127.0.0.1` to prevent remote connections. Only change to `0.0.0.0` for testing.

### Audio Capture

Microphone capture is done natively in the renderer via `getUserMedia`
(`dashboard.html` / `setup.html`) — there is no FFmpeg dependency and no
`AUDIO_DEVICE` environment variable. The microphone is listed and selected
directly from the app's setup screen.

### Speech-to-Text (cloud-only)

| Variable           | Default       | Description                                                   |
| ------------------ | ------------- | ------------------------------------------------------------- |
| `GROQ_API_KEY`     | (recommended) | Cloud transcription key from https://console.groq.com/keys    |
| `DEEPGRAM_API_KEY` | (optional)    | Fallback transcription key from https://console.deepgram.com/ |
| `NODE_ENV`         | production    | Environment (development/production/test)                     |

**How it works:**

- Transcription is 100% cloud-based: Groq first, Deepgram as fallback if Groq fails or times out.
- There is no local Whisper fallback (removed in v0.3.0) and no FFmpeg dependency (removed since the getUserMedia migration).

**Get a Groq API Key:**

1. Go to https://console.groq.com/keys
2. Sign up or log in
3. Create new API key
4. Paste it into the app's setup window (or into `.env` for `npm run server-only`)

### Bible Content

Verse text is fetched directly from two independent free providers with
automatic fallback: `bible.helloao.org` (Louis Segond 1910), then
`api.getbible.net`. No API key or provider configuration is needed.

### Logging & Debug

| Variable | Default | Description                  |
| -------- | ------- | ---------------------------- |
| `DEBUG`  | false   | Verbose logging (true/false) |

**Enable debug:**

```ini
DEBUG=true
```

Then watch the console for detailed logs:

```
[server] Message validated from client #1: showVerse
[detector] Detected: jean 3:16
[bible-lookup] ✓ Got verse from helloao-lsg
[server] Verse sent to overlay: Jean 3:16
```

### Security

| Variable                  | Default | Description                      |
| ------------------------- | ------- | -------------------------------- |
| `MAX_CONNECTIONS`         | 10      | Max WebSocket connections per IP |
| `MAX_MESSAGES_PER_MINUTE` | 60      | Max messages per IP per minute   |
| `VALIDATE_MESSAGES`       | true    | Enable message validation        |

**For production (church service):**

- Keep defaults
- `VALIDATE_MESSAGES=true` (prevent XSS attacks)
- `MAX_CONNECTIONS=10` (prevents DDoS)

## Examples

### Minimal Setup (Groq only)

```ini
PORT=8765
GROQ_API_KEY=gsk_YOUR_KEY_HERE
NODE_ENV=production
```

### Full Setup (Groq + Deepgram fallback)

```ini
PORT=8765
GROQ_API_KEY=gsk_YOUR_KEY_HERE
DEEPGRAM_API_KEY=YOUR_DEEPGRAM_KEY_HERE
NODE_ENV=production
DEBUG=false
```

### Development/Testing

```ini
PORT=8765
GROQ_API_KEY=gsk_YOUR_KEY_HERE
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

Note: inside the packaged app, Groq/Deepgram keys entered via the setup
screen are encrypted at rest using Electron's `safeStorage` — they are not
stored in plain text in `config.json`.

## Validation

**Check your setup:**

```bash
# Lists all current environment variables
node -e "console.log(process.env)"

# Test a specific variable
node -e "console.log('GROQ_API_KEY set:', !!process.env.GROQ_API_KEY)"
```

**Run tests:**

```bash
# Full test suite
npm test

# Individual tests
node test/test-config-validator.js
node test/test-validation.js
```

## Troubleshooting

### "GROQ_API_KEY invalid"

```bash
# Check key format:
# Should start with "gsk_"
# Get new key from https://console.groq.com/keys
# Make sure you copied the FULL key
```

### No microphone detected

Open the app's setup screen and click "Refresh" — it lists microphones via
`getUserMedia`. If none appear, check your OS microphone permissions
(Windows: Settings → Privacy → Microphone → "Allow desktop apps to access
your microphone").

## Next Steps

- Read `SETUP.md` for full installation guide
- Read `API.md` for WebSocket protocol
- Read `ARCHITECTURE.md` for technical details
