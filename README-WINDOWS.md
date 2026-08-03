# 🪟 Windows Setup Guide - Church Overlay

> Mise à jour v0.5.0 : FFmpeg n'est plus nécessaire. Le microphone se
> choisit dans l'application (fenêtre de configuration), pas dans `.env`.

## 📥 Prerequisites (One Time)

### 1. Install Node.js

- Download: https://nodejs.org/ (LTS version recommended)
- Run installer with default settings
- Restart your computer

That's the only prerequisite — no FFmpeg, no separate speech-to-text
model to download. Microphone capture uses the same audio layer as
Windows Settings, built into the app itself.

---

## 🚀 Quick Start (Every Time)

### First Time Only

```
Double-click: install-dependencies.bat
```

Then run:

```
npm start
```

A setup window opens automatically: pick your microphone from the list
and paste your Groq API key (get one free at https://console.groq.com/keys).

### Every Time You Use It

```
npm start
```

That's it! ✨ (`start-server.bat` also exists, but it runs the server
without a microphone — see "Advanced Troubleshooting" below.)

---

## 🔌 OBS Configuration

1. **Open OBS Studio**
2. **Create new scene** (if needed)
3. **Add Browser source:**
   - Click `+` under "Sources"
   - Select "Browser"
   - Click "Create New"
   - **Name:** Bible Overlay
   - **URL:** `file:///C:/path/to/xtruck/overlay.html`
     - Replace `path/to/xtruck` with your actual folder path
   - **Width:** 1920
   - **Height:** 1080
   - **Uncheck:** "Control audio via OBS" (unless you need it)
   - Click OK
4. **Position** it on your scene
5. **Start streaming!**

---

## 🧪 Test It Out

Before your first service, test the system:

### With Manual Test (No Microphone Needed)

1. Make sure the app (`npm start`) is running
2. Open OBS with overlay source
3. Double-click: `test-overlay.bat`
4. You should see "Jean 3:16" appear in OBS!

### With Your Microphone

1. Make sure the app (`npm start`) is running
2. Open OBS with overlay source
3. Speak into microphone: **"Jean 3:16"**
4. Wait a few seconds
5. The verse should appear automatically!

---

## 📁 File Locations

When configuring OBS overlay.html path, use:

```
file:///C:/Users/YourUsername/Documents/xtruck/overlay.html
```

Replace:

- `YourUsername` with your Windows username
- `xtruck` with your actual folder name

To find your path:

1. Open File Explorer
2. Navigate to your xtruck folder
3. Look at the address bar
4. Copy that path

---

## ⚙️ Configuration (.env)

Edit `.env` file (open with Notepad) to customize:

```ini
# WebSocket server port (keep default)
PORT=8765

# Optional: Groq API key for transcription (can also be set from the setup window)
# Get from: https://console.groq.com/keys
GROQ_API_KEY=

# Optional: Deepgram API key, used as a fallback if Groq fails
DEEPGRAM_API_KEY=

# Keep this for production
NODE_ENV=production
```

There is no `AUDIO_DEVICE` or `FFMPEG_PATH` to set here anymore — the
microphone is chosen from the app's own setup window.

---

## 🆘 Common Issues

### Issue: "Node.js not found"

**Solution:**

- Restart your computer after installing Node.js
- Or reinstall from: https://nodejs.org/

### Issue: "Microphone not working" / wrong microphone picked

**Solution:**

1. In the app dashboard, click "Changer de micro" to reopen the device picker
2. Verify the microphone is not muted and is enabled in Windows Sound settings
3. Restart the app (`npm start`)

### Issue: "OBS overlay shows nothing"

**Solution:**

1. Check the app dashboard/console shows:
   ```
   [server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
   ```
2. Verify OBS browser source path is correct
3. Check OBS browser console (right-click source → Interact)
4. Press F12 in interact window
5. Look for error messages

### Issue: "Verses don't appear"

**Solution:**

1. Check internet connection (transcription and Bible APIs need it)
2. Speak clearly: "Jean 3:16"
3. Wait a few seconds for transcription to process
4. Check the dashboard for a "Problème micro" alert
5. Verify microphone is unmuted

---

## 📞 Advanced Troubleshooting

### Check Server Status

Run the full app (recommended — includes microphone capture):

```powershell
npm start
```

Or run the server alone, without a microphone, for debugging only:

```powershell
node server.js
```

Watch for errors in console. With `npm start` you should see:

```
[server] Validation de la configuration...
[server] Configuration validée
[server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
[audio-capture] Prêt à recevoir des chunks audio (capture native).
[capture.html] Capture démarrée.
```

### Test Bible API

```powershell
node bible-lookup-with-api.js
```

Should return a verse without errors.

### Run Full Test Suite

```powershell
npm test
```

All tests should pass (green checkmarks).

---

## 🎯 You're Ready!

Your Church Overlay is configured and ready to use:

1. **Service Day:**
   - Run `npm start`
   - Open OBS
   - Start streaming!

2. **During Service:**
   - Speak Bible references naturally
   - Verses appear automatically
   - Operator can override if needed

3. **After Service:**
   - Close the ChurchOverlay window (it stays in the system tray) or quit from the tray icon

---

## 📖 More Information

- **Detailed Setup:** Read `SETUP.md`
- **Configuration Options:** Read `README.md`
- **Technical Details:** Read `ARCHITECTURE.md`
- **API Reference:** Read `API.md`

---

## 🆘 Still Need Help?

Check these files in order:

1. `QUICKSTART-WINDOWS.md`
2. `SETUP.md`
3. `README.md`
4. `ARCHITECTURE.md`

Or create an issue on GitHub with:

- Your Windows version
- Error message from console
- Which `.bat` file failed

Happy streaming! 🎬📖✨
