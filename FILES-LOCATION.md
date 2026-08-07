# 🎯 Church Overlay - Files Location & What to Click

> ⚠️ **Ce fichier est partiellement obsolète** (il liste encore
> `whisper-wrapper.js`, retiré en v0.3.0, et certains passages plus bas
> n'ont pas encore été mis à jour pour la capture native v0.5.0). Pour
> une marche à suivre à jour, préférez `QUICKSTART-WINDOWS.md` ou
> `README-WINDOWS.md`. En résumé : plus de FFmpeg à installer, plus de
> `setup-microphone.bat` ni de nom de micro dans `.env` — lancez
> simplement `npm start`, le micro se choisit dans la fenêtre de
> configuration de l'app.

## 📁 Where Files Are Located

After you clone/download the repository, you'll see all these files in your `xtruck` folder:

```
xtruck/
├── 🟢 START HERE (First Time)
│   ├── install-dependencies.bat ← DOUBLE-CLICK FIRST
│   ├── setup-microphone.bat ← DOUBLE-CLICK SECOND
│   └── README-WINDOWS.md ← READ THIS
│
├── 🔵 EVERY TIME YOU USE IT
│   └── start-server.bat ← DOUBLE-CLICK TO START
│
├── 🟡 FOR TESTING
│   └── test-overlay.bat ← DOUBLE-CLICK TO TEST
│
├── 📚 DOCUMENTATION
│   ├── README.md
│   ├── QUICKSTART-WINDOWS.md
│   ├── README-WINDOWS.md
│   ├── README.md
│   ├── SETUP.md
│   └── ARCHITECTURE.md
│
├── ⚙️ CONFIG FILES
│   ├── .env ← Your configuration (created automatically)
│   └── .env.example ← Template
│
├── 🎬 OBS OVERLAY
│   └── overlay.html ← Use this in OBS Browser Source
│
├── 📝 SOURCE CODE (for developers)
│   ├── server.js
│   ├── audio-capture.js
│   ├── whisper-wrapper.js
│   ├── detector.js
│   ├── bible-lookup-with-api.js
│   └── ... (other .js files)
│
└── 📦 DEPENDENCIES
    ├── package.json
    ├── package-lock.json
    └── node_modules/ (created after install)
```

---

## 🚀 Quick Setup (What to Click)

### Step 1: First Time Only

**Open File Explorer → navigate to your `xtruck` folder**

**Double-click:** `install-dependencies.bat`

```
What it does:
✅ Checks if Node.js is installed
✅ Installs npm packages
✅ Creates .env file
```

Then run the app (no more `setup-microphone.bat` — the microphone is
chosen inside the app itself):

```
npm start
```

### Step 2: Configure Your Microphone

On first launch, the app opens a setup window that lists your
microphones (the same list Windows Settings shows) — pick one and paste
your Groq API key. There is nothing to edit in `.env` for this anymore.

### Step 3: Every Time You Want to Use It

**Run:** `npm start`

```
A console window will open showing:
[server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
[server] Pipeline complet opérationnel

DO NOT CLOSE THIS WINDOW - leave it running!
```

### Step 4: Set Up OBS

1. Open OBS Studio
2. Create new Scene (if needed)
3. Add Browser Source:
   - Click `+` under Sources
   - Select "Browser"
   - Click "Create New"
   - **Name:** Bible Overlay
   - **URL:** `file:///C:/path/to/xtruck/overlay.html`
     - Replace with your actual path
   - **Width:** 1920
   - **Height:** 1080
   - Click OK
4. Position it on your scene
5. Start streaming!

---

## 🧪 Test It (Optional)

Want to test before your first service?

**Keep `start-server.bat` running, then:**

**Double-click:** `test-overlay.bat`

```
This sends a test verse to your overlay.
You should see "Jean 3:16" appear in OBS!
```

---

## 📍 File Descriptions

### Batch Files (.bat) - Double-Click These!

| File                       | Purpose                   | When                  |
| -------------------------- | ------------------------- | --------------------- |
| `install-dependencies.bat` | Install everything needed | First time only       |
| `setup-microphone.bat`     | Find your microphone      | First time only       |
| `start-server.bat`         | Start the server          | Every time you use it |
| `test-overlay.bat`         | Test without microphone   | Before first service  |

### Configuration Files

| File           | Purpose           | Edit?                        |
| -------------- | ----------------- | ---------------------------- |
| `.env`         | Your settings     | ✅ YES (after first install) |
| `.env.example` | Template          | ❌ NO                        |
| `package.json` | Dependencies list | ❌ NO                        |

### Documentation

| File                    | What It Covers                                |
| ----------------------- | --------------------------------------------- |
| `README-WINDOWS.md`     | **START HERE** - Full setup guide for Windows |
| `QUICKSTART-WINDOWS.md` | Quick overview of what to click               |
| `README.md`             | Environment variables explained               |
| `SETUP.md`              | Detailed setup steps                          |
| `ARCHITECTURE.md`       | How the system works (technical)              |
| `API.md`                | WebSocket API reference (technical)           |

### Source Code (For Developers)

| File                       | Purpose                   |
| -------------------------- | ------------------------- |
| `server.js`                | Main WebSocket server     |
| `overlay.html`             | OBS overlay UI            |
| `audio-capture.js`         | Microphone capture        |
| `whisper-wrapper.js`       | Speech-to-text            |
| `detector.js`              | Bible reference detection |
| `bible-lookup-with-api.js` | Verse lookup              |

---

## 🎯 Find Your Folder Path

When setting up OBS, you need the full path to `overlay.html`:

1. Open File Explorer
2. Navigate to your `xtruck` folder
3. Look at the address bar at top
4. You'll see something like:
   ```
   C:\Users\YourName\Documents\xtruck
   ```
5. Use that in OBS:
   ```
   file:///C:/Users/YourName/Documents/xtruck/overlay.html
   ```

---

## ✅ Verification Checklist

After `start-server.bat` starts, you should see:

- [ ] `[server] Validation de la configuration...`
- [ ] `[server] Configuration validée`
- [ ] `[server] Serveur WebSocket démarré sur ws://127.0.0.1:8765`
- [ ] `[server] Whisper Speech-to-Text prêt et opérationnel`
- [ ] `[server] Capture audio démarrée - Pipeline complet opérationnel`

If you see all of these ✅ **YOU'RE READY!**

---

## 🆘 Common Issues

### "install-dependencies.bat" won't run

- Make sure you're in the right folder
- Right-click and select "Run as Administrator"
- Check Windows antivirus isn't blocking it

### "Node.js not found"

- Download from https://nodejs.org/
- Install with default settings
- **Restart your computer**
- Try again

### "start-server.bat" closes immediately

- Check the error message in the console
- Read `README-WINDOWS.md` for solutions
- Make sure you completed `install-dependencies.bat` first

### "OBS overlay shows nothing"

- Check `start-server.bat` is still running
- Verify the file path in OBS is correct
- Try: Right-click overlay source → Interact → F12 (check console)

---

## 📸 Visual Guide

```
Your Computer
│
├─ File Explorer
│  └─ xtruck/ (your folder)
│     ├─ install-dependencies.bat  ← DOUBLE-CLICK 1st
│     ├─ setup-microphone.bat       ← DOUBLE-CLICK 2nd
│     ├─ start-server.bat          ← DOUBLE-CLICK each time
│     ├─ test-overlay.bat          ← DOUBLE-CLICK to test
│     ├─ overlay.html              ← Copy path to OBS
│     └─ .env                       ← Edit with Notepad
│
└─ OBS Studio
   └─ Browser Source
      └─ URL: file:///C:/xtruck/overlay.html
```

---

## 💡 Pro Tips

1. **Create Desktop Shortcuts:**
   - Right-click `start-server.bat` → Send to → Desktop (create shortcut)
   - Then just double-click from desktop every time

2. **Or use the VBS script:**
   - Right-click `create-shortcut.vbs` → Run
   - Desktop shortcut is created automatically

3. **Keep a console window open:**
   - `start-server.bat` runs and stays open
   - Minimize it, don't close it
   - You'll see useful information if something goes wrong

4. **Test before going live:**
   - Run `test-overlay.bat` before your first service
   - Make sure verse appears in OBS
   - Then you're ready!

---

## 🎬 Ready to Go!

You now have everything set up. Your Church Overlay is ready to use! 🎉

### Summary:

1. **First time:** Click `install-dependencies.bat` then `setup-microphone.bat`
2. **Every time:** Click `start-server.bat`
3. **In OBS:** Add Browser Source pointing to `overlay.html`
4. **During service:** Speak Bible verses, they appear automatically!

Enjoy! 📖✨
