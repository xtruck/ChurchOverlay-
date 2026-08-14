# Setup Guide - Church Overlay

## Prerequisites

Before running the app, ensure you have:

- **Node.js 18+** ([Download](https://nodejs.org/))
- **Git** (to clone this repo)
- **Windows/Linux/Mac** (packaged builds target Windows 10+)

No FFmpeg, no local Whisper binaries, no `list-audio-devices.js` — the
microphone is captured natively via `getUserMedia` and configured from the
app's own on-screen setup window.

## Step 1: Clone & Install

```bash
git clone https://github.com/xtruck/ChurchOverlay-.git
cd xtruck
npm install
```

## Step 2: Configure Environment (API keys only)

### Copy the example config:

```bash
cp .env.example .env
```

### Edit `.env` with your settings:

```powershell
# Windows PowerShell
code .env  # or use any text editor
```

```ini
# Recommended primary transcription provider
GROQ_API_KEY=gsk_YOUR_KEY_HERE

# Optional fallback if Groq fails or times out
DEEPGRAM_API_KEY=YOUR_DEEPGRAM_KEY_HERE
```

You do not need to configure a microphone here — that happens in Step 4,
from the app itself.

## Step 3: Verify Your Setup

```bash
# Full test suite (syntax, detector, validation, rate limiter, audio
# segmentation, reading mode, OBS gating, live integration...)
npm test

# Send a manual test verse to a running server via WebSocket
node test/test-envoi.js
```

`npm test` should finish with every suite passing and no failed assertions.

## Step 4: Start the App and Configure the Microphone

```bash
npm start
```

On first launch, the setup window opens:

1. It lists available microphones via `getUserMedia` — pick yours from the dropdown.
2. Paste your Groq (and optionally Deepgram) API key if you didn't set them in `.env`.
3. Click "Enregistrer et démarrer".

The dashboard then shows the pipeline status and the WebSocket server
starts on `ws://127.0.0.1:8765` (or the `PORT` you configured).

## Step 5: Configure OBS

1. **Open OBS Studio**
2. **Create a new Scene** (or use an existing one)
3. **Add a Browser Source**:
   - Click `+` under Sources
   - Select "Browser"
   - Name it "Bible Overlay"
4. **Set the URL** (the dashboard shows you the exact path to use):
   ```
   file:///C:/xtruck/overlay.html
   ```
   (Replace `C:/xtruck` with your actual install path)
5. **Set Size**:
   - Width: 1920
   - Height: 1080
6. **Position** it on your scene (usually full screen)

## Step 6: Test the Full Pipeline

1. **Start the app**: `npm start` (or it's already running)
2. **Open OBS** and make sure the Bible Overlay source is visible
3. **Test manually**, in a new terminal:
   ```bash
   node test/test-envoi.js
   ```
   You should see "Jean 3:16" appear in your OBS overlay!
4. **Test with audio** (when ready for a live sermon):
   - Speak into your microphone: "Jean 3:16"
   - Wait a couple of seconds for cloud transcription (Groq)
   - The verse should appear automatically

## Troubleshooting

### No microphone appears in the setup window

- Check your OS microphone permissions (Windows: Settings → Privacy →
  Microphone → "Allow desktop apps to access your microphone").
- Click "Actualiser" in the setup window to re-scan devices.
- Make sure a microphone is physically plugged in and not muted.

### `Bible verse not found`

The app uses free Bible APIs. If they're down:

1. **Check internet connection**
2. **Wait a few seconds** (API might be temporarily slow)
3. **Check console for errors**:
   ```
   [bible-lookup] ✗ helloao-lsg a échoué: ...
   [bible-lookup] ✗ getbible-ls1910 a échoué: ...
   ```
   The app tries `bible.helloao.org` first, then falls back to
   `api.getbible.net` automatically — you only need to worry if _both_ fail.

### OBS overlay shows nothing

1. **Verify the server is running** — the dashboard status indicator
   should show "En ligne", and the console should show:
   ```
   [server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
   ```
2. **Check OBS browser console**:
   - Right-click the Bible Overlay source
   - Select "Interact"
   - Press F12 to open console
   - Look for errors
3. **Verify the file path**:
   ```bash
   # Make sure overlay.html exists at the path you set in OBS:
   ls overlay.html
   ```

### `GROQ_API_KEY invalid` / no automatic detection

- Check the key format: it should start with `gsk_`.
- Get a new key from https://console.groq.com/keys.
- Make sure you copied the full key, no trailing spaces.

## Getting Help

**Check the logs:**

```bash
# The server prints detailed logs to console
# Look for [server] prefixed messages
# Save logs to file:
npm start > server.log 2>&1
```

**Read the docs:**

- `README.md` - Environment variables reference
- `ARCHITECTURE.md` - Technical overview
- `API.md` - WebSocket protocol
- `SECURITY_IMPROVEMENTS.md` - Security features

**Still stuck?** Open an issue on GitHub with:

1. Your Node version: `node --version`
2. Your OS
3. Console output from `npm start`
4. Your `.env` settings (without API keys!)
