# Church Overlay

Affiche automatiquement dans OBS les passages bibliques cités à l'oral :

`Micro → FFmpeg → Whisper → detector.js → bible-lookup.js → overlay.html`

## 🆕 Sécurité et Améliorations

Cette version inclut des améliorations de sécurité importantes :
- **Validation des messages** : Tous les messages WebSocket sont validés et sanitisés
- **Rate limiting** : Protection contre les abus (10 connexions/IP, 60 messages/minute)
- **Fallback API** : Système de secours automatique pour les API Bible
- **Configuration validée** : Validation des variables d'environnement au démarrage
- **Nettoyage robuste** : Gestion améliorée des fichiers temporaires

## 🚀 Installation Rapide

### Option 1 : Configuration interactive (recommandé)

```powershell
npm run setup
```

Ce script vous guidera à travers :
- Installation des dépendances
- Vérification de FFmpeg
- Configuration du micro
- Création des scripts de démarrage

### Option 2 : Installation manuelle

1. Listez les micros : `node list-audio-devices.js`.
2. Dans PowerShell, configurez celui retenu (pour la session en cours) :
   ```powershell
   $env:AUDIO_DEVICE = 'Nom exact du microphone'
   # Facultatif si ffmpeg n'est pas dans le PATH :
   $env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
   npm start
   ```
3. Dans OBS, créez une source *Browser* pointant vers
   `file:///C:/Users/HP/xtruck/overlay.html` (1920 × 1080).

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

## 📚 Documentation

- **Guide de déploiement** : Voir `DEPLOYMENT_GUIDE.md` pour l'installation complète
- **API WebSocket** : Voir `API.md` pour la documentation complète de l'API
- **Architecture** : Voir `ARCHITECTURE.md` pour les détails techniques
- **Sécurité** : Voir `SECURITY_IMPROVEMENTS.md` pour les améliorations

## Vérification

```powershell
npm test              # Tests de validation et sécurité
npm run test-all      # Tous les tests (incluant audio et Whisper)
node test-envoi.js    # Test manuel de l'overlay
```

## Configuration

Variables d'environnement disponibles :
- `PORT` : Port du serveur WebSocket (défaut: 8765)
- `AUDIO_DEVICE` : Nom du périphérique audio
- `FFMPEG_PATH` : Chemin vers l'exécutable FFmpeg
- `NODE_ENV` : Environnement (development/production/test)

## 🆘 Support

En cas de problème :
1. Consultez `DEPLOYMENT_GUIDE.md` pour le dépannage
2. Exécutez `npm run setup` pour reconfigurer
3. Vérifiez les logs du serveur pour les messages d'erreur
