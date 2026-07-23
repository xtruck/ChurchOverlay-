# Guide de Déploiement - xtruck Church Overlay

## 📋 Prérequis

### Logiciels requis
- **Node.js** v18 ou supérieur (v24.18.0 testé)
- **FFmpeg** (pour la capture audio)
- **OBS Studio** (pour l'affichage des versets)

### Fichiers requis
- `whisper-server.exe` (dossier `whisper/`)
- `ggml-base.bin` ou `ggml-tiny.bin` (dossier `whisper/models/`)
- Node.js modules (`ws`, `form-data`)

## 🚀 Installation

### 1. Installation des dépendances Node.js

```powershell
cd xtruck
npm install
```

### 2. Vérification de FFmpeg

```powershell
ffmpeg -version
```

Si FFmpeg n'est pas installé :
1. Téléchargez FFmpeg depuis https://ffmpeg.org/download.html
2. Extrayez et ajoutez au PATH Windows
3. Vérifiez avec `ffmpeg -version`

### 3. Configuration du micro

Lancez le script pour lister les micros disponibles :

```powershell
node list-audio-devices.js
```

Copiez le nom exact du micro souhaité, puis configurez :

```powershell
$env:AUDIO_DEVICE = "Nom exact du microphone"
```

### 4. (Optionnel) Configuration de FFmpeg personnalisé

Si FFmpeg n'est pas dans le PATH :

```powershell
$env:FFMPEG_PATH = "C:\chemin\vers\ffmpeg.exe"
```

## 🔧 Configuration

### Variables d'environnement

| Variable | Description | Défaut | Requis |
|----------|-------------|--------|--------|
| `PORT` | Port du serveur WebSocket | 8765 | Non |
| `AUDIO_DEVICE` | Nom du périphérique audio | "" | Oui (pour audio) |
| `FFMPEG_PATH` | Chemin vers FFmpeg | "ffmpeg" | Non |
| `NODE_ENV` | Environnement | "development" | Non |

### Configuration OBS Studio

1. Dans OBS, ajoutez une source **Browser**
2. URL : `file:///C:/Users/HP/xtruck/overlay.html`
3. Largeur : 1920, Hauteur : 1080
4. Activez "Control audio via OBS" si nécessaire

## 🎯 Démarrage

### Mode complet (avec transcription audio)

```powershell
$env:AUDIO_DEVICE = "Votre Micro"
npm start
```

### Mode manuel (sans transcription audio)

```powershell
npm start
```

Le serveur démarrera sans transcription audio mais permettra l'affichage manuel des versets.

## 🧪 Tests

### Tests de sécurité et validation

```powershell
npm test
```

### Tests complets (incluant audio et Whisper)

```powershell
npm run test-all
```

### Test manuel de l'overlay

```powershell
node tests/test-envoi.js
```

## 📊 Surveillance

### Vérification du démarrage

Au démarrage, le serveur affiche :

```
=== Résultats de la validation ===
✓ Configuration valide
================================

[server] Configuration validée, démarrage sur le port 8765
[server] Serveur WebSocket démarré sur ws://127.0.0.1:8765
[server] Whisper Speech-to-Text prêt et opérationnel
```

### État du système

Le serveur envoie des messages WebSocket pour les erreurs :
- `pipelineError` : Erreur du pipeline audio
- `transcriptionError` : Erreur de transcription
- `audioCaptureError` : Erreur de capture audio
- `lookupError` : Erreur de recherche Bible

## 🔒 Sécurité

### Protection intégrée

- **Validation des messages** : Tous les messages sont validés et sanitisés
- **Rate limiting** : 10 connexions/IP, 60 messages/minute
- **Fallback API** : Système de secours automatique pour les API Bible
- **Configuration validée** : Validation au démarrage

### Pour la production

1. **Authentication** : Ajoutez l'authentification WebSocket
2. **HTTPS/WSS** : Utilisez des connexions sécurisées
3. **Firewall** : Limitez l'accès au port 8765
4. **Monitoring** : Surveillez les logs et erreurs

## 🛠️ Dépannage

### Problème : "FFmpeg non trouvé"

**Solution** :
```powershell
# Vérifiez l'installation
ffmpeg -version

# Si non installé, téléchargez et ajoutez au PATH
# Ou configurez FFMPEG_PATH
$env:FFMPEG_PATH = "C:\chemin\vers\ffmpeg.exe"
```

### Problème : "Aucun micro configuré"

**Solution** :
```powershell
# Listez les micros
node list-audio-devices.js

# Configurez le micro
$env:AUDIO_DEVICE = "Nom exact du microphone"
```

### Problème : "Port déjà utilisé"

**Solution** :
```powershell
# Changez le port
$env:PORT = 8766
npm start
```

### Problème : Whisper ne démarre pas

**Solution** :
1. Vérifiez que `whisper-server.exe` existe dans `whisper/`
2. Vérifiez que le modèle existe dans `whisper/models/`
3. Le serveur continuera en mode manuel

### Problème : API Bible inaccessible

**Solution** :
- Le système utilise automatiquement les providers de secours
- Vérifiez votre connexion internet
- Les versets déjà recherchés sont en cache

## 📱 Utilisation

### Affichage manuel d'un verset

Envoyez un message WebSocket à `ws://localhost:8765` :

```json
{
  "action": "showVerse",
  "reference": "Jean 3:16",
  "text": "Car Dieu a tant aimé le monde...",
  "durationMs": 300000
}
```

### Recherche automatique

```json
{
  "action": "lookupReference",
  "reference": "Jean 3:16",
  "durationMs": 300000
}
```

### Masquer le verset

```json
{
  "action": "hideVerse"
}
```

## 🔄 Mise à jour

### Pour mettre à jour les modules de sécurité

```powershell
# Arrêtez le serveur (Ctrl+C)
# Mettez à jour les fichiers
# Redémarrez
npm start
```

### Pour mettre à jour les dépendances

```powershell
npm update
```

## 📞 Support

En cas de problème :

1. Consultez `API.md` pour la documentation API
2. Consultez `ARCHITECTURE.md` pour les détails techniques
3. Consultez `SECURITY_IMPROVEMENTS.md` pour les améliorations de sécurité
4. Vérifiez les logs du serveur pour les messages d'erreur

## 🎯 Bonnes pratiques

### Avant un culte

1. **Testez la configuration** : `npm test`
2. **Testez la recherche Bible** : `node tests/test-envoi.js`
3. **Vérifiez le micro** : `node list-audio-devices.js`
4. **Testez OBS** : Vérifiez que l'overlay s'affiche correctement
5. **Ayez un plan de secours** : Mode manuel disponible

### Pendant le culte

1. **Surveillez les logs** : Recherchez les erreurs
2. **Ayez le test-envoi.js prêt** : Pour affichage manuel si nécessaire
3. **Connexion internet** : Vérifiez qu'elle est stable
4. **Micro configuré** : Vérifiez qu'il fonctionne

### Après le culte

1. **Nettoyez les fichiers temporaires** : Le serveur le fait automatiquement
2. **Vérifiez les logs** : Notez les problèmes éventuels
3. **Mettez à jour si nécessaire** : Appliquez les correctifs

## 📈 Performance

### Ressources recommandées

- **CPU** : 4 cœurs minimum (pour Whisper)
- **RAM** : 2 GB minimum (4 GB recommandé)
- **Disque** : 500 MB pour les modèles Whisper
- **Réseau** : Connexion internet stable pour API Bible

### Optimisation

- Utilisez le modèle `ggml-tiny.bin` pour des systèmes moins puissants
- Ajustez `maxConnections` et `maxMessagesPerMinute` dans `server.js`
- Désactivez la transcription audio si non nécessaire

## 🔍 Maintenance

### Nettoyage automatique

Le serveur nettoie automatiquement :
- Les fichiers temporaires audio (> 1 heure)
- Les connexions WebSocket fermées
- L'historique des messages (toutes les 5 minutes)

### Nettoyage manuel

```powershell
# Supprimez le dossier temporaire si nécessaire
Remove-Item -Recurse -Force temp-audio
```

### Logs

Les logs sont affichés dans la console. Pour les sauvegarder :

```powershell
npm start > server.log 2>&1
```