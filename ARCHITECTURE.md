# Architecture Pipeline Speech-to-Text - Église Mesev

> ⚠️ **Document en grande partie obsolète.** Il décrit une version plus
> ancienne du pipeline (Whisper local comme moteur principal). Depuis
> v0.3.0, Whisper local a été **retiré entièrement** du projet (c'était le
> plus gros consommateur CPU de l'app). Le pipeline réel est maintenant :
>
> ```
> Micro → capture.html (getUserMedia/AudioWorklet, fenêtre Electron cachée)
>       → main.js → audio-capture.js → groq-wrapper.js (cloud)
>       → deepgram-wrapper.js (repli, si configuré) → detector.js
>       → bible-lookup-with-api.js → server.js (WebSocket) → overlay.html (OBS)
> ```
>
> Tout ce qui suit ce bandeau concernant `whisper-wrapper.js`,
> `whisper-server.exe`, ou les modèles `.bin` ne s'applique plus. Ce
> fichier mériterait une réécriture complète — non faite ici pour rester
> concentré sur la suppression de Whisper, le pipeline et les logs.
>
> **Mise à jour v0.5.0** : FFmpeg/DirectShow a lui aussi été retiré (voir
> CHANGELOG en tête de `audio-capture.js` et de `main.js`). FFmpeg ne
> voyait tout simplement pas certains micros — un problème de couche de
> capture, indépendant du nom affiché. La capture micro passe désormais
> par `capture.html`, une fenêtre Electron cachée qui utilise
> `getUserMedia`/`AudioWorklet` (la même couche audio que Windows/Chromium).
> Toutes les mentions de FFmpeg, DirectShow, `ffmpeg -list_devices`, ou
> `list-audio-devices.js` plus bas dans ce document sont également
> obsolètes.
>
> **Mise à jour — Studio Pro** : le tableau de bord opérateur
> (`dashboard.html` + `dashboard/`) dispose désormais d'un espace "Studio
> Pro" (`dashboard/features/propresenter-studio.js`), une interface façon
> ProPresenter 7 (grille de diapositives, moniteur PGM/aperçu, raccourcis
> Master Clear F1-F4) qui est l'espace actif par défaut à l'ouverture — les
> panneaux classiques ("Direct Classique", "Préparation", "Régie") restent
> accessibles via la barre latérale. Ce document ne couvre pas le tableau
> de bord (uniquement le pipeline audio→verset→overlay ci-dessus) ; voir le
> commentaire d'en-tête de `dashboard/features/propresenter-studio.js` pour
> le détail de cette interface.

## Vue d'ensemble

Système complet de transcription audio en temps réel pour affichage automatique de versets bibliques via OBS Studio.

```
Micro → audio-capture.js → whisper-wrapper.js → server.js → overlay.html (OBS)
```

## Composants

### 1. `audio-capture.js` - Capture Audio en Continu

**Rôle**: Capture l'audio du micro et segmente intelligemment pour transcription.

**Fonctionnalités**:

- Capture audio via FFmpeg (DirectShow sur Windows)
- Segmentation automatique (3 secondes par défaut)
- Chevauchement entre segments (500ms) pour éviter la perte de contexte
- Création de fichiers WAV pour chaque segment
- Gestion du buffer circulaire

**Configuration**:

```javascript
{
  sampleRate: 16000,      // Whisper recommande 16000 Hz
  channels: 1,            // Mono
  bitDepth: 16,           // PCM 16-bit
  segmentDuration: 3000,  // 3 secondes par segment
  overlapDuration: 500,   // 500ms de chevauchement
  silenceThreshold: 0.3,  // Seuil VAD
  minSpeechDuration: 500, // Durée minimum parole
}
```

**API**:

```javascript
audioCapture.startRecording();
audioCapture.stopRecording();
audioCapture.on({ onAudioSegment, onError });
audioCapture.isRecording();
audioCapture.cleanupTempFiles();
```

**Dépendance**: FFmpeg (doit être installé et dans PATH)

---

### 2. `whisper-wrapper.js` - Wrapper Whisper Speech-to-Text

**Rôle**: Gère le processus whisper-server.exe et fournit une API structurée.

**Fonctionnalités**:

- Gestion automatique du processus whisper-server.exe
- Configuration VAD (Voice Activity Detection) intégrée
- API HTTP vers whisper-server (port 8080)
- Support transcription fichier et buffer
- Callbacks pour événements (ready, transcript, error)

**Configuration**:

```javascript
{
  whisperServerPath: './whisper/whisper-server.exe',
  modelPath: './whisper/models/ggml-small.bin',
  host: '127.0.0.1',
  port: 8080,
  language: 'fr',
  threads: 4,
  vadEnabled: true,
  vadThreshold: 0.5,
  vadMinSpeechDuration: 250,
  vadMinSilenceDuration: 1000,
}
```

**API**:

```javascript
whisper.startServer(options);
whisper.stopServer();
whisper.transcribeFile(audioFilePath);
whisper.transcribeBuffer(audioBuffer);
whisper.on({ onTranscript, onError, onReady });
whisper.isRunning();
whisper.getConfig();
```

**Dépendances**:

- whisper-server.exe (inclus dans dossier whisper/)
- ggml-small.bin (modèle Whisper, 487 MB)
- form-data (npm)

---

### 3. `server.js` - Serveur WebSocket Pont

**Rôle**: Coordination centrale et relai vers overlay.html.

**Fonctionnalités**:

- Serveur WebSocket (port 8765) pour communication avec overlay.html
- Démarrage automatique de whisper-server au lancement
- Relai des transcriptions vers clients connectés
- Gestion des connexions WebSocket
- Arrêt propre de tous les processus

**Flux de données**:

```
audio-capture → whisper-wrapper → server.js → overlay.html
```

**API WebSocket**:

```javascript
// Client → Server
{ action: "showVerse", reference: "...", text: "...", durationMs: 5000 }
{ action: "hideVerse" }
{ action: "updateVerse", reference: "...", text: "..." }

// Server → Client (overlay.html)
// Même format relayé à tous les clients connectés
```

---

### 4. `overlay.html` - Interface Overlay OBS

**Rôle**: Affichage des versets dans OBS Studio via Browser Source.

**Fonctionnalités**:

- Animations sophistiquées (croix, halo, particules)
- API JavaScript complète (window.ChurchOverlay)
- Gestion du temps d'affichage avec barre de progression
- Contrôles pause/reprise/extension
- Mode démo pour tests (?demo=1)

**API**):

```javascript
ChurchOverlay.showVerse({ reference, text, durationMs });
ChurchOverlay.updateVerse({ reference, text });
ChurchOverlay.hideVerse();
ChurchOverlay.pauseTimer();
ChurchOverlay.resumeTimer();
ChurchOverlay.extendTime(extraMs);
ChurchOverlay.getStatus();
```

---

## Pipeline Complet

### Étape 1: Capture Audio

```
Micro → FFmpeg → audio-capture.js
```

- FFmpeg capture le micro en continu
- audio-capture.js segmente en fichiers WAV de 3 secondes
- Chevauchement de 500ms entre segments

### Étape 2: Transcription

```
Segment WAV → whisper-wrapper.js → whisper-server.exe
```

- whisper-wrapper envoie chaque segment à whisper-server
- Whisper transcrit le texte en français
- VAD intégré filtre les silences

### Étape 3: Relai vers Overlay

```
Transcription → server.js → overlay.html
```

- server.js reçoit la transcription
- Analyse pour détecter les versets bibliques (TODO: detector.js)
- Envoi vers overlay.html via WebSocket

### Étape 4: Affichage

```
overlay.html → OBS Studio → Église
```

- overlay.html affiche le verset avec animations
- Barre de temps gère l'affichage automatique
- Opérateur peut contrôler (pause, extension, annulation)

---

## Scripts de Test

### `test-whisper.js`

Teste le module whisper-wrapper indépendamment:

```bash
node test-whisper.js
```

### `test-audio-capture.js`

Teste la capture audio (requiert FFmpeg et micro):

```bash
node test-audio-capture.js
```

### `test-envoi.js`

Teste le circuit WebSocket complet:

```bash
node test-envoi.js           # Envoi verset par défaut
node test-envoi.js hide      # Masquer overlay
```

---

## Démarrage du Système

### 1. Installation des dépendances

```bash
npm install
```

### 2. Installation de FFmpeg (requis pour audio-capture)

```bash
# Télécharger FFmpeg depuis https://ffmpeg.org/download.html
# Ajouter à PATH Windows
# Vérifier: ffmpeg -version
```

### 3. Démarrage du serveur

```bash
node server.js
```

Le serveur démarre automatiquement:

- Serveur WebSocket sur ws://localhost:8765
- Serveur Whisper sur http://127.0.0.1:8080

### 4. Configuration OBS

1. Ajouter Browser Source dans OBS
2. URL: `file:///C:/ChurchOverlay/overlay.html`
3. Largeur: 1920, Hauteur: 1080
4. Activer "Control audio via OBS" si nécessaire

---

## Prochaines Étapes

### Étape 5: Pipeline Audio Complet

- [ ] Intégrer audio-capture dans server.js
- [ ] Connecter audio-capture → whisper-wrapper automatiquement
- [ ] Implémenter detector.js (détection de versets bibliques)
- [ ] Implémenter context-tracker.js (suivi du contexte)
- [ ] Implémenter bible-lookup.js (recherche versets dans Bible)

### Étape 6: Interface Opérateur

- [ ] Panneau de contrôle pour l'opérateur
- [ ] Visualisation en temps réel des transcriptions
- [ ] Validation manuelle des versets détectés
- [ ] Contrôles avancés (volume, sensibilité micro)

### Étape 7: Optimisation

- [ ] Cache des transcriptions pour éviter doublons
- [ ] Ajustement dynamique des paramètres VAD
- [ ] Mode "apprentissage" pour améliorer la détection
- [ ] Statistiques et logs détaillés

---

## Structure des Fichiers

```
ChurchOverlay/
├── server.js                    # Serveur WebSocket principal
├── whisper-wrapper.js          # Wrapper Whisper Speech-to-Text
├── audio-capture.js            # Capture audio en continu
├── overlay.html                # Interface overlay OBS
├── test-envoi.js              # Test WebSocket
├── test-whisper.js            # Test Whisper
├── test-audio-capture.js      # Test capture audio
├── package.json               # Dépendances npm
├── ARCHITECTURE.md            # Ce fichier
├── whisper/
│   ├── whisper-server.exe     # Serveur Whisper HTTP
│   ├── ggml-small.bin         # Modèle Whisper (487 MB)
│   └── models/                # Autres modèles potentiels
└── temp-audio/                # Fichiers audio temporaires (créé auto)
```

---

## Performances

### Whisper

- **Modèle**: ggml-small (487 MB)
- **Latence**: ~1-2 secondes par segment de 3 secondes
- **CPU**: 4 threads recommandés
- **Mémoire**: ~600 MB (modèle + buffers)

### Audio Capture

- **Taux d'échantillonnage**: 16000 Hz
- **Segmentation**: 3 secondes
- **Chevauchement**: 500 ms
- **Format**: PCM 16-bit mono

### Latence Totale

- **Micro → Transcription**: ~3-4 secondes
- **Transcription → Overlay**: <100 ms (WebSocket)
- **Total**: ~4 secondes (acceptable pour usage culte)

---

## Dépannage

### Whisper ne démarre pas

- Vérifier que ggml-small.bin existe dans whisper/models/
- Vérifier que whisper-server.exe existe dans whisper/
- Logs: `[whisper-wrapper]` et `[whisper-server]`

### Capture audio ne fonctionne pas

- Vérifier que FFmpeg est installé: `ffmpeg -version`
- Vérifier que le micro est connecté
- Logs: `[audio-capture]` et `[audio-capture FFmpeg]`

### Overlay ne reçoit pas les messages

- Vérifier que server.js tourne: `node server.js`
- Vérifier que overlay.html est ouvert dans OBS
- Vérifier la console du navigateur OBS (F12)
- Logs: `[server]`

---

## Notes Techniques

### Pourquoi whisper-server.exe au lieu de whisper-stream.exe?

- **API structurée**: HTTP REST plus facile à intégrer
- **VAD intégré**: Voice Activity Detection natif
- **Contrôle total**: Paramètres ajustables dynamiquement
- **Séparation**: Architecture plus modulaire et testable

### Pourquoi FFmpeg pour capture audio?

- **Cross-platform**: Fonctionne sur Windows, Linux, macOS
- **Formats supportés**: WAV, MP3, FLAC, OGG
- **DirectShow**: Accès direct aux périphériques Windows
- **Mature**: Stable et largement utilisé

### Pourquoi segmentation 3 secondes?

- **Équilibre**: Assez long pour contexte, assez court pour latence
- **Whisper**: Optimal pour le modèle small
- **VAD**: Permet détection précise des segments de parole

---

## Licence et Crédits

- **Whisper**: OpenAI (MIT License)
- **FFmpeg**: GPL v2+
- **ws (WebSocket)**: MIT License
- **form-data**: MIT License

Projet développé pour l'Église Mesev.
