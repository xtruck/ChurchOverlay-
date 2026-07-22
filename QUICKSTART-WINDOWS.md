# Church Overlay - Windows Quick Start Guide

## 🚀 One-Click Setup (Recommended)

### Step 1: First Time Setup
Double-click: **`install-dependencies.bat`**

This will:
- ✅ Verify Node.js is installed
- ✅ Install npm dependencies
- ✅ Create `.env` configuration file
- ✅ Check for FFmpeg

### Step 2: Configure Your Microphone
Double-click: **`setup-microphone.bat`**

This will:
- ✅ List all your audio devices
- ✅ Guide you to set your microphone in `.env`

### Step 3: Start the Server
Double-click: **`start-server.bat`**

This will:
- ✅ Start the WebSocket server
- ✅ Initialize Whisper Speech-to-Text
- ✅ Wait for OBS connections
- ✅ Show server status in console

### Step 4: Connect OBS

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

When you see in the console:
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
node tests/test-envoi.js
```

This will:
- ✅ Send a test verse to the overlay
- ✅ Verify OBS connection works
- ✅ Show Bible API is responding

---

## 📋 What Each File Does

| File | Purpose | When to Use |
|------|---------|-------------|
| `install-dependencies.bat` | Install Node.js packages & setup | First time only |
| `setup-microphone.bat` | Find your microphone | First time setup |
| `start-server.bat` | Start the server | Every time you use it |
| `.env` | Configuration file | Edit with your settings |
| `overlay.html` | OBS browser source | Reference in OBS |

---

## ⚙️ Configuration Options (Advanced)

Edit `.env` to customize:

```ini
# WebSocket server port
PORT=8765

# Your microphone (from setup-microphone.bat)
AUDIO_DEVICE=Your Microphone Name

# Path to FFmpeg (if not in PATH)
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe

# Optional: Groq API key for better accuracy
GROQ_API_KEY=

# Environment
NODE_ENV=production
```

---

## 🆘 Troubleshooting

### "Node.js not found"
1. Download from: https://nodejs.org/
2. Install with default settings
3. Restart your computer
4. Try again

### "FFmpeg not found"
1. Download from: https://ffmpeg.org/download.html
2. Unzip to `C:\ffmpeg`
3. Add to PATH:
   - Windows Settings → Environment Variables
   - System → Advanced → Environment Variables
   - Add: `C:\ffmpeg\bin` to PATH
4. Restart computer

### "No audio devices found"
1. Check Windows audio settings
2. Verify microphone is not disabled
3. Try: Settings → Sound → Input devices
4. Check microphone is set as default

### "OBS doesn't show overlay"
1. Check browser console in OBS (F12)
2. Verify `start-server.bat` is still running
3. Verify file path in OBS matches your location
4. Check browser source URL format

### "Verses don't appear"
1. Check internet connection (APIs need it)
2. Verify microphone in `.env`
3. Speak clearly: "Jean 3:16"
4. Wait ~4 seconds for Whisper to process
5. Check console for errors

---

## 🔧 Manual Commands (If Needed)

If the `.bat` files don't work, you can use PowerShell:

```powershell
# List audio devices
node list-audio-devices.js

# Test Bible lookup
node bible-lookup-with-api.js

# Run all tests
npm test

# Start server manually
node server.js
```

---

## 📞 Getting Help

1. Check the error messages in the console
2. Read `SETUP.md` for detailed explanations
3. Read `README-ENV.md` for configuration options
4. Check `ARCHITECTURE.md` for technical details

---

## 🎯 You're All Set!

Everything is configured for your church service. Just:

1. **Before service**: Run `start-server.bat`
2. **In OBS**: Make sure overlay source is active
3. **During service**: Speak Bible references
4. **Verses appear**: Automatically!

Happy streaming! 📖✨
