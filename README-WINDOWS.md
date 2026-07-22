# 🪟 Windows Setup Guide - Church Overlay

## 📥 Prerequisites (One Time)

### 1. Install Node.js
- Download: https://nodejs.org/ (LTS version recommended)
- Run installer with default settings
- Restart your computer

### 2. Install FFmpeg (Optional but Recommended)
- Download: https://ffmpeg.org/download.html
- Extract to: `C:\ffmpeg`
- Add to Windows PATH:
  1. Press `Win + X` → System
  2. Advanced system settings → Environment Variables
  3. System variables → New
     - Variable name: `Path`
     - Variable value: `C:\ffmpeg\bin`
  4. Click OK, OK, OK
  5. Restart computer

---

## 🚀 Quick Start (Every Time)

### First Time Only
```
Double-click: install-dependencies.bat
Double-click: setup-microphone.bat
```

### Every Time You Use It
```
Double-click: start-server.bat
```

That's it! ✨

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
1. Make sure `start-server.bat` is running
2. Open OBS with overlay source
3. Double-click: `test-overlay.bat`
4. You should see "Jean 3:16" appear in OBS!

### With Your Microphone
1. Make sure `start-server.bat` is running
2. Open OBS with overlay source
3. Speak into microphone: **"Jean 3:16"**
4. Wait ~4 seconds
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
# Your microphone name (from setup-microphone.bat)
AUDIO_DEVICE=Microphone (High Definition Audio Device)

# FFmpeg path (if not in system PATH)
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe

# Optional: Groq API key for better accuracy
# Get from: https://console.groq.com/keys
GROQ_API_KEY=

# WebSocket server port (keep default)
PORT=8765

# Keep this for production
NODE_ENV=production
```

---

## 🆘 Common Issues

### Issue: "Node.js not found"
**Solution:**
- Restart your computer after installing Node.js
- Or reinstall from: https://nodejs.org/

### Issue: "FFmpeg not found"
**Solution:**
- Download from: https://ffmpeg.org/download.html
- Extract to: `C:\ffmpeg`
- Add to Windows PATH (see Prerequisites section)
- Restart computer

### Issue: "Microphone not working"
**Solution:**
1. Run: `setup-microphone.bat` to find correct name
2. Edit `.env` with exact microphone name
3. Verify microphone is default in Windows Sound settings
4. Restart `start-server.bat`

### Issue: "OBS overlay shows nothing"
**Solution:**
1. Check `start-server.bat` console shows:
   ```
   [server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
   ```
2. Verify OBS browser source path is correct
3. Check OBS browser console (right-click source → Interact)
4. Press F12 in interact window
5. Look for error messages

### Issue: "Verses don't appear"
**Solution:**
1. Check internet connection (Bible APIs need it)
2. Speak clearly: "Jean 3:16"
3. Wait 4-5 seconds for Whisper to process
4. Check console for errors
5. Verify microphone is unmuted

---

## 📞 Advanced Troubleshooting

### Check Server Status
Open PowerShell and run:
```powershell
node server.js
```

Watch for errors in console. Should see:
```
[server] Validation de la configuration...
[server] Configuration validée
[server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
[server] Whisper Speech-to-Text prêt et opérationnel
[server] Capture audio démarrée
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
   - Double-click `start-server.bat`
   - Open OBS
   - Start streaming!

2. **During Service:**
   - Speak Bible references naturally
   - Verses appear automatically
   - Operator can override if needed

3. **After Service:**
   - Press Ctrl+C in console to stop server
   - Close the window

---

## 📖 More Information

- **Detailed Setup:** Read `SETUP.md`
- **Configuration Options:** Read `README-ENV.md`
- **Technical Details:** Read `ARCHITECTURE.md`
- **API Reference:** Read `API.md`

---

## 🆘 Still Need Help?

Check these files in order:
1. `QUICKSTART-WINDOWS.md` (this file)
2. `SETUP.md`
3. `README-ENV.md`
4. `ARCHITECTURE.md`

Or create an issue on GitHub with:
- Your Windows version
- Error message from console
- Which `.bat` file failed

Happy streaming! 🎬📖✨
