# Setup Guide - Church Overlay

> ⚠️ **This guide is largely outdated.** It predates two major changes:
> local Whisper was removed (v0.3.0 — transcription is now cloud-only via
> Groq, with Deepgram as fallback), and FFmpeg was removed (v0.5.0 —
> microphone capture now uses `getUserMedia` in a hidden Electron window,
> see `capture.html`/`audio-capture.js`). You do **not** need to install
> FFmpeg, and there is no `list-audio-devices.js` or `whisper-server.exe`
> anymore. To set up the app: install Node.js, run `npm install`, then
> `npm start` — the microphone and Groq key are configured from the
> on-screen setup window on first launch. See `README.md` for the current
> environment variables.

## Prerequisites

Before running the system, ensure you have:

- **Node.js 16+** ([Download](https://nodejs.org/))
- **FFmpeg** ([Download](https://ffmpeg.org/download.html))
- **Git** (to clone this repo)
- **Windows/Linux/Mac** (tested on Windows 10+)

## Step 1: Clone & Install

```bash
git clone https://github.com/xtruck/xtruck.git
cd xtruck
npm install
```

## Step 2: Configure Environment

### Copy the example config:

```bash
cp .env.example .env
```

### Edit `.env` with your settings:

```powershell
# Windows PowerShell
code .env  # or use any text editor
```

### Find your microphone:

```bash
node list-audio-devices.js
```

Example output:
```
0: Microphone (High Definition Audio Device)
1: Speakers (High Definition Audio Device)
```

### Update `.env`:

```ini
# Use the exact name from the list above
AUDIO_DEVICE=Microphone (High Definition Audio Device)

# Optional: If FFmpeg is not in your PATH
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe

# Optional: Get from https://console.groq.com/keys for better accuracy
GROQ_API_KEY=
```

## Step 3: Verify Your Setup

```bash
# Test configuration
npm test

# Test Bible lookup (uses free API)
node bible-lookup-with-api.js

# Test manual overlay
node tests/test-envoi.js
```

Expected output:
```
✅ Bible loaded successfully
✅ Rate limiter OK
✅ Validation OK
```

## Step 4: Start the Server

```bash
npm start
```

Expected output:
```
[server] Configuration validée, démarrage sur le port 8765
[server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
[server] Démarrage du serveur Whisper Speech-to-Text...
[server] Whisper Speech-to-Text prêt et opérationnel
[server] Démarrage de la capture audio...
[server] Capture audio démarrée - Pipeline complet opérationnel
```

## Step 5: Configure OBS

1. **Open OBS Studio**
2. **Create a new Scene** (or use existing one)
3. **Add a Browser Source**:
   - Click `+` under Sources
   - Select "Browser"
   - Name it "Bible Overlay"
4. **Set the URL**:
   ```
   file:///C:/xtruck/overlay.html
   ```
   (Replace `C:/xtruck` with your actual path)

5. **Set Size**:
   - Width: 1920
   - Height: 1080

6. **Position** it on your scene (usually full screen)

## Step 6: Test the Full Pipeline

1. **Start the server**: `npm start` (or it's already running)
2. **Open OBS** and make sure the Bible Overlay source is visible
3. **Test manually**:
   ```bash
   # In a new terminal/PowerShell window:
   node tests/test-envoi.js
   ```
   You should see "Jean 3:16" appear in your OBS overlay!

4. **Test with audio** (when ready for live sermon):
   - Speak into your microphone: "Jean 3:16"
   - Wait ~4 seconds for Whisper to transcribe
   - The verse should appear automatically

## Troubleshooting

### `FFmpeg not found`

```bash
# Verify FFmpeg is installed:
ffmpeg -version

# If not in PATH, set it in .env:
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
```

### `Whisper server not found`

```bash
# Verify whisper-server.exe exists:
ls whisper/whisper-server.exe

# If missing, download it or run:
npm run setup-whisper  # (if script exists)
```

### `Bible verse not found`

The system uses free Bible APIs. If they're down:

1. **Check internet connection**
2. **Wait a few seconds** (API might be temporarily slow)
3. **Check console for errors**:
   ```bash
   # Look for messages like:
   # [bible-lookup] ✗ helloao-lsg a échoué: ...
   # [bible-lookup] ✗ getbible-ls1910 a échoué: ...
   ```
   The app tries `bible.helloao.org` first, then falls back to
   `api.getbible.net` automatically — you only need to worry if *both* fail.

### OBS overlay shows nothing

1. **Verify server is running**:
   ```bash
   # Should see:
   # [server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
   ```

2. **Check OBS browser console**:
   - Right-click the Bible Overlay source
   - Select "Interact"
   - Press F12 to open console
   - Look for errors

3. **Verify file path**:
   ```bash
   # Make sure overlay.html exists:
   ls overlay.html
   ```

### Audio not being captured

1. **Check microphone in .env**:
   ```bash
   node list-audio-devices.js
   # Copy the exact name
   ```

2. **Verify FFmpeg can access it**:
   ```bash
   # If you know FFmpeg is installed:
   ffmpeg -list_devices true -f dshow -i dummy
   ```

3. **Check Windows audio settings**:
   - Go to Settings → Sound
   - Verify microphone is not muted
   - Set it as default device

## Getting Help

**Check the logs:**
```bash
# The server prints detailed logs to console
# Look for [server] prefixed messages
# Save logs to file:
npm start > server.log 2>&1
```

**Read the docs:**
- `README.md` - Quick start
- `ARCHITECTURE.md` - Technical overview
- `API.md` - WebSocket protocol
- `SECURITY_IMPROVEMENTS.md` - Security features

**Still stuck?** Create an issue on GitHub with:
1. Your Node version: `node --version`
2. Your OS
3. Console output from `npm start`
4. `.env` settings (without API keys!)
