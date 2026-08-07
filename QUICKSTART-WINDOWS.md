# Church Overlay - Windows Quick Start Guide

> Mise à jour v0.5.0 : plus de FFmpeg à installer, plus de nom de
> microphone à copier dans `.env`. Le microphone se choisit maintenant
> dans une fenêtre de l'application elle-même.

## 🚀 One-Click Setup (Recommended)

### Step 1: First Time Setup

Double-click: **`install-dependencies.bat`**

This will:

- ✅ Verify Node.js is installed
- ✅ Install npm dependencies
- ✅ Create `.env` configuration file (for the WebSocket port, API keys, etc. — no microphone name needed here)

### Step 2: Start the App

Run in a terminal:

```
npm start
```

This will:

- ✅ Launch the ChurchOverlay app (Electron)
- ✅ On first launch, open a setup window listing your microphones —
  pick one and paste your Groq API key
- ✅ Start the pipeline (microphone → Groq/Deepgram → verse detection → overlay)
- ✅ Show a small dashboard with server status and the overlay URL

> `start-server.bat` (`node server.js` in a plain console, no app window)
> still works, but it runs **without microphone capture** — audio capture
> needs the Electron window to call the browser's microphone API. Use
> `npm start` for the full pipeline.

### Step 3: Connect OBS

1. Open OBS Studio
2. Create a new Scene (or use existing)
3. Add Browser Source:
   - Click `+` under Sources
   - Select "Browser"
   - Click "Create New"
   - Name: "Bible Overlay"
   - URL: `file:///C:/path/to/xtruck/overlay.html`
   - Width: 1920
   - Height: 1080
   - Click OK

4. Position the source on your scene
5. Start streaming!

## ✅ Everything Ready!

When you see in the dashboard/console:

```
[server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
[server] Pipeline complet opérationnel
```

Your system is ready. Just speak Bible verses and they'll appear automatically!

---

## 🧪 Testing Without Audio

Want to test before the service?

Double-click: **`test-overlay.bat`** (or run in PowerShell):

```powershell
node test/test-envoi.js
```

This will:

- ✅ Send a test verse to the overlay
- ✅ Verify OBS connection works
- ✅ Show Bible API is responding

---

## 📋 What Each File Does

| File                       | Purpose                                                          | When to Use             |
| -------------------------- | ---------------------------------------------------------------- | ----------------------- |
| `install-dependencies.bat` | Install Node.js packages & setup                                 | First time only         |
| `npm start`                | Launch the app (setup window + dashboard + mic capture)          | Every time you use it   |
| `start-server.bat`         | Run the WebSocket server without a UI/microphone (debug/testing) | Advanced/testing only   |
| `.env`                     | Configuration file (port, API keys — no microphone name)         | Edit with your settings |
| `overlay.html`             | OBS browser source                                               | Reference in OBS        |

---

## ⚙️ Configuration Options (Advanced)

Edit `.env` to customize:

```ini
# WebSocket server port
PORT=8765

# Optional: Groq API key for transcription (can also be set from the setup window)
GROQ_API_KEY=

# Optional: Deepgram API key, used as a fallback if Groq fails
DEEPGRAM_API_KEY=

# Environment
NODE_ENV=production
```

The microphone itself is **not** configured here — it's chosen from the
app's setup window (or the "Changer de micro" button in the dashboard).

---

## 🆘 Troubleshooting

### "Node.js not found"

1. Download from: https://nodejs.org/
2. Install with default settings
3. Restart your computer
4. Try again

### "No audio devices found" / wrong microphone picked

1. Check Windows audio settings (Settings → Sound → Input devices) —
   the app lists exactly what Windows sees
2. Verify the microphone is not disabled or muted
3. In the app, use "Changer de micro" (dashboard) to re-open the device
   picker and choose again

### "OBS doesn't show overlay"

1. Check browser console in OBS (F12)
2. Verify the ChurchOverlay app is still running
3. Verify file path in OBS matches your location
4. Check browser source URL format

### "Verses don't appear"

1. Check internet connection (transcription and Bible lookups need it)
2. Check the dashboard for a "Problème micro" alert
3. Speak clearly: "Jean 3:16"
4. Wait a few seconds for transcription to process
5. Check the dashboard logs for errors

---

## 🔧 Manual Commands (If Needed)

```powershell
# Test Bible lookup
node bible-lookup-with-api.js

# Run all tests
npm test

# Start the full app (with microphone capture)
npm start

# Start the server only, without microphone capture (debug/testing)
node server.js
```

---

## 📞 Getting Help

1. Check the error messages in the console / dashboard
2. Read `SETUP.md` for detailed explanations
3. Read `README.md` for configuration options
4. Check `ARCHITECTURE.md` for technical details

---

## 🎯 You're All Set!

Everything is configured for your church service. Just:

1. **Before service**: Run `npm start`
2. **In OBS**: Make sure overlay source is active
3. **During service**: Speak Bible references
4. **Verses appear**: Automatically!

Happy streaming! 📖✨
