# Instructions de Développement ChurchOverlay (v0.9.1)

## Commandes de Build & Test

- Démarrer l'application complète Electron : `npm start`
- Lancer le serveur WebSocket seul : `npm run server-only`
- Exécuter la suite de tests complète : `npm test`
- Lancer les tests de validation uniquement : `node test/test-validation.js`
- Linter le projet : `npm run lint`

## 3 Contraintes d'Architecture Immuables (À Respecter Absolument)

### 1. PAS DE FFMEG LOCAL POUR L'AUDIO

- La capture audio est 100% native via l'API Web Audio (getUserMedia/WASAPI) et est relayée au Worker Node.js [3, 4].
- La transcription (ASR) passe exclusivement par les API Cloud (Groq Whisper et Deepgram) [5]. Aucun Whisper local ni binaire FFmpeg local ne doit être réintroduit sur le flux audio de direct [5].

### 2. RESPECT STRICT DES PRIVILÈGES WEBSOCKET (RBAC)

- Deux tokens distincts : `WS_AUTH_TOKEN` (opérateur) et `WS_VIEWER_TOKEN` (lecture seule pour l'overlay OBS) [6, 7].
- Le rôle d'un client est exclusivement déterminé par le jeton présenté dans l'en-tête `Sec-WebSocket-Protocol` (jamais dans l'URL) [7].
- L'overlay public ('overlay.js') est un consommateur passif en lecture seule et ne doit jamais exécuter d'actions opérateur.

### 3. VALIDATION SYSTÉMATIQUE DE TOUTES LES ACTIONS

- Chaque action WebSocket doit être déclarée dans 'action-registry.js' (RBAC), posséder un schéma strict de validation dans 'validation.js', et être routée via 'CATEGORY_HANDLERS' [8, 9].
- Aucun traitement de message WebSocket ne doit être géré en "inline" ou de manière "sauvage" dans 'server.js' [9]. Le test unitaire 38 de 'test-validation.js' doit rester 100% vert [8, 10].
