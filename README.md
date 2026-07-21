# Church Overlay

Affiche automatiquement dans OBS les passages bibliques cités à l'oral :

`Micro → FFmpeg → Whisper → detector.js → bible-lookup.js → overlay.html`

## Démarrage

1. Listez les micros : `node list-audio-devices.js`.
2. Dans PowerShell, configurez celui retenu (pour la session en cours) :
   ```powershell
   $env:AUDIO_DEVICE = 'Nom exact du microphone'
   # Facultatif si ffmpeg n'est pas dans le PATH :
   $env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
   npm start
   ```
3. Dans OBS, créez une source *Browser* pointant vers
   `file:///C:/ChurchOverlay/overlay.html` (1920 × 1080).

Le serveur reste utilisable pour l'affichage manuel si Whisper, FFmpeg ou la
recherche en ligne ne sont pas disponibles.

## Contrôle manuel

Envoyez un message WebSocket à `ws://localhost:8765` :

```json
{ "action": "showVerse", "reference": "Jean 3:16", "text": "…", "durationMs": 300000 }
```

ou demandez une recherche par référence :

```json
{ "action": "lookupReference", "reference": "Jean 3:16" }
```

`bible-lookup.js` isole le fournisseur de textes et conserve un cache mémoire.
Testez impérativement la recherche avant un culte : l'API publique utilisée par
défaut peut évoluer ou être indisponible.

## Vérification

```powershell
npm test
node test-envoi.js
```
