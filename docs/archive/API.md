# API WebSocket - xtruck Church Overlay

## Vue d'ensemble

Le serveur WebSocket communique sur le port `8765` par défaut (configurable via `PORT`) et utilise le protocole WebSocket pour échanger des messages JSON entre le serveur et les clients (overlay.html, pupitre opérateur, etc.).

## Connexion

**URL par défaut**: `ws://localhost:8765`

### Exemple de connexion en JavaScript

```javascript
const ws = new WebSocket('ws://localhost:8765');

ws.onopen = () => {
  console.log('Connecté au serveur WebSocket');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Message reçu:', message);
};

ws.onerror = (error) => {
  console.error('Erreur WebSocket:', error);
};

ws.onclose = () => {
  console.log('Connexion fermée');
};
```

## Messages Client → Serveur

### 1. showVerse - Afficher un verset

Affiche un verset biblique sur l'overlay.

```json
{
  "action": "showVerse",
  "reference": "Jean 3:16",
  "text": "Car Dieu a tant aimé le monde...",
  "durationMs": 300000
}
```

**Champs**:

- `action` (string, requis): "showVerse"
- `reference` (string, requis): Référence du verset (max 200 caractères)
- `text` (string, requis): Texte du verset (max 5000 caractères)
- `durationMs` (number, optionnel): Durée d'affichage en millisecondes (max 3600000 = 1 heure)

**Réponse**: Le message est relayé à tous les autres clients connectés.

### 2. hideVerse - Masquer le verset

Masque le verset actuellement affiché.

```json
{
  "action": "hideVerse"
}
```

**Champs**:

- `action` (string, requis): "hideVerse"

**Réponse**: Le message est relayé à tous les autres clients connectés.

### 3. updateVerse - Mettre à jour le verset

Met à jour le verset actuellement affiché.

```json
{
  "action": "updateVerse",
  "reference": "Jean 3:17",
  "text": "Car Dieu n'a pas envoyé son Fils...",
  "durationMs": 300000
}
```

**Champs**:

- `action` (string, requis): "updateVerse"
- `reference` (string, requis): Nouvelle référence (max 200 caractères)
- `text` (string, requis): Nouveau texte (max 5000 caractères)
- `durationMs` (number, optionnel): Nouvelle durée (max 3600000)

**Réponse**: Le message est relayé à tous les autres clients connectés.

### 4. lookupReference - Rechercher une référence

Recherche un verset à partir de sa référence biblique.

```json
{
  "action": "lookupReference",
  "reference": "Jean 3:16",
  "durationMs": 300000
}
```

**Champs**:

- `action` (string, requis): "lookupReference"
- `reference` (string, requis): Référence à rechercher (max 200 caractères)
- `durationMs` (number, optionnel): Durée d'affichage (max 3600000)

**Réponse**:

- Succès: Message `showVerse` avec le texte du verset
- Erreur: Message `lookupError` avec le détail de l'erreur

## Messages Serveur → Client

### 1. showVerse - Verset à afficher

Envoyé quand un verset doit être affiché (manuel ou automatique).

```json
{
  "action": "showVerse",
  "reference": "Jean 3:16",
  "text": "Car Dieu a tant aimé le monde...",
  "durationMs": 300000,
  "autoDetected": true,
  "provider": "bibleapi.appspot.com"
}
```

**Champs supplémentaires**:

- `autoDetected` (boolean, optionnel): `true` si détecté automatiquement par transcription
- `provider` (string, optionnel): Provider API utilisé pour la recherche
- `readingMode` (boolean, optionnel): `true` si le verset est affiché dans le cadre du mode lecture (verset par verset)
- `readingModePos` (object, optionnel, mode lecture uniquement): position courante de la lecture — `{ book, chapter, verse, total }` (chapitre + numéro de verset affiché + nombre total de versets du chapitre), pour afficher la progression côté tableau de bord sans recomptage client

### 2. hideVerse - Masquer le verset

Demande de masquer le verset.

```json
{
  "action": "hideVerse"
}
```

### 3. updateVerse - Mise à jour du verset

Mise à jour du verset affiché.

```json
{
  "action": "updateVerse",
  "reference": "Jean 3:17",
  "text": "Car Dieu n'a pas envoyé son Fils...",
  "durationMs": 300000
}
```

### 4. transcript - Transcription audio

Envoyé quand une transcription audio est reçue de Whisper.

```json
{
  "action": "transcript",
  "text": "Ceci est une transcription...",
  "timestamp": 1234567890
}
```

**Champs**:

- `action` (string): "transcript"
- `text` (string): Texte transcrit
- `timestamp` (number): Timestamp de la transcription

### 5. candidateVerse - Verset candidat

Envoyé quand une référence biblique est détectée dans la transcription. Deux
formes distinctes côté réception :

- **Correspondance floue** (`distance` présent) : le texte transcrit ne
  correspondait à aucun livre exact — le détecteur a proposé le livre le
  plus proche. À afficher comme "correction automatique".
- **Spéculative** (`speculative: true`, Étape 5) : une référence a été
  entendue (référence explicite sur un partial en cours de stabilisation,
  ou chapitre seul d'un partial finalisé localement par le silence VAD).
  Le système attend la confirmation du texte final officiel (`showVerse`) —
  une référence ambiguë n'est jamais affichée d'office. Le bandeau doit
  signaler "en attente de confirmation" et être effacé au `showVerse` réel.

```json
{
  "action": "candidateVerse",
  "reference": {
    "book": "jean",
    "chapter": 3,
    "verseStart": 16,
    "verseEnd": 16,
    "raw": "Jean 3:16"
  },
  "transcript": "Lisons Jean 3:16",
  "timestamp": 1234567890
}
```

**Champs complémentaires** (selon la forme) :

- `speculative` (boolean, optionnel): `true` = référence entendue, en attente de confirmation
- `confidence` (string, optionnel): `"medium"` (chapitre seul) ou `"high"` (référence explicite stable)
- `original` (string, optionnel): texte transcrit d'origine (utile pour la correction floue)
- `distance` (number, optionnel): distance de la correspondance floue, si applicable

### 6. lookupError - Erreur de recherche

Envoyé quand la recherche d'un verset échoue.

```json
{
  "action": "lookupError",
  "reference": {
    "book": "jean",
    "chapter": 3,
    "verseStart": 16,
    "verseEnd": 16
  },
  "error": "Impossible de récupérer le verset...",
  "timestamp": 1234567890
}
```

### 7. error - Erreur générale

Envoyé en cas d'erreur de validation ou autre.

```json
{
  "action": "error",
  "error": "Message de l'erreur"
}
```

### 8. pipelineError - Erreur du pipeline audio

Envoyé quand le pipeline audio rencontre une erreur.

```json
{
  "action": "pipelineError",
  "error": "GROQ_API_KEY manquant",
  "timestamp": 1234567890
}
```

### 9. transcriptionError - Erreur de transcription

Envoyé quand la transcription audio échoue.

```json
{
  "action": "transcriptionError",
  "error": "Erreur lors de la transcription",
  "timestamp": 1234567890
}
```

### 10. audioCaptureError - Erreur de capture audio

Envoyé quand la capture audio échoue.

```json
{
  "action": "audioCaptureError",
  "error": "Microphone non disponible",
  "timestamp": 1234567890
}
```

## Validation et Sécurité

### Validation des messages

Tous les messages clients sont validés selon les règles suivantes :

1. **Format JSON**: Tous les messages doivent être du JSON valide
2. **Action requise**: Le champ `action` doit être présent et valide
3. **Types de données**: Les champs doivent respecter les types attendus
4. **Longueurs maximales**:
   - `reference`: max 200 caractères
   - `text`: max 5000 caractères
   - `durationMs`: max 3600000 (1 heure)
5. **Champs non autorisés**: Seuls les champs définis sont acceptés

### Rate Limiting

Pour prévenir les abus, le serveur implémentelimitation de taux :

- **Connexions**: Max 10 connexions par IP
- **Messages**: Max 60 messages par minute par IP
- **Nettoyage automatique**: Les anciennes entrées sont nettoyées toutes les 5 minutes

En cas de dépassement, le message d'erreur suivant est envoyé :

```json
{
  "action": "error",
  "error": "Trop de messages (60/60 par minute)"
}
```

### Sanitization

Les champs texte sont automatiquement nettoyés pour prévenir les injections XSS :

- Les caractères HTML dangereux sont échappés
- Les références et textes sont validés avant traitement

## Codes d'erreur

| Erreur                               | Description                             |
| ------------------------------------ | --------------------------------------- |
| `Format JSON invalide`               | Le message n'est pas du JSON valide     |
| `Action manquante ou invalide`       | Le champ action est manquant ou inconnu |
| `Champ requis manquant: X`           | Un champ requis est absent              |
| `Valeur invalide pour le champ: X`   | La valeur d'un champ n'est pas valide   |
| `Champ non autorisé: X`              | Un champ non défini est présent         |
| `Trop de connexions depuis cette IP` | Limite de connexions dépassée           |
| `Trop de messages`                   | Limite de messages dépassée             |
| `Référence biblique non reconnue`    | La référence n'a pas pu être détectée   |

## Exemples d'utilisation

### Exemple 1: Affichage manuel d'un verset

```javascript
const ws = new WebSocket('ws://localhost:8765');

ws.onopen = () => {
  const message = {
    action: 'showVerse',
    reference: 'Jean 3:16',
    text: "Car Dieu a tant aimé le monde qu'il a donné son Fils unique...",
    durationMs: 300000, // 5 minutes
  };
  ws.send(JSON.stringify(message));
};
```

### Exemple 2: Recherche automatique

```javascript
const ws = new WebSocket('ws://localhost:8765');

ws.onopen = () => {
  const message = {
    action: 'lookupReference',
    reference: 'Jean 3:16',
    durationMs: 300000,
  };
  ws.send(JSON.stringify(message));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.action === 'showVerse') {
    console.log('Verset trouvé:', message.text);
  } else if (message.action === 'lookupError') {
    console.error('Erreur:', message.error);
  }
};
```

### Exemple 3: Suivi des transcriptions

```javascript
const ws = new WebSocket('ws://localhost:8765');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  switch (message.action) {
    case 'transcript':
      console.log('Transcription:', message.text);
      break;
    case 'candidateVerse':
      console.log('Référence détectée:', message.reference);
      break;
    case 'showVerse':
      console.log('Verset affiché:', message.reference);
      break;
  }
};
```

## Configuration

### Variables d'environnement

- `PORT`: Port du serveur WebSocket (défaut: 8765)
- `GROQ_API_KEY`: Clé API Groq pour la transcription cloud (fournisseur principal)
- `DEEPGRAM_API_KEY`: Clé API Deepgram, utilisée en repli si Groq échoue (optionnel)
- `NODE_ENV`: `development` / `production` / `test`

Le microphone (`AUDIO_DEVICE`) n'est plus une variable d'environnement à
éditer à la main depuis v0.5.0 : il est choisi dans la fenêtre de
configuration de l'app (getUserMedia), qui écrit un `deviceId` dans
`config.json`. FFmpeg n'est plus une dépendance du projet.

### Modification de la configuration

Pour modifier les limites de rate limiting, éditez le fichier `server.js` :

```javascript
const rateLimiter = createRateLimiter({
  maxConnections: 10, // Modifier selon vos besoins
  maxMessagesPerMinute: 60, // Modifier selon vos besoins
});
```

## Dépannage

### Connexion refusée

Si vous recevez une erreur de connexion :

1. Vérifiez que `server.js` est en cours d'exécution
2. Vérifiez que le port 8765 n'est pas utilisé par une autre application
3. Vérifiez que vous n'avez pas dépassé la limite de connexions

### Messages rejetés

Si vos messages sont rejetés :

1. Vérifiez le format JSON
2. Vérifiez que tous les champs requis sont présents
3. Vérifiez que les valeurs respectent les limites de taille
4. Vérifiez que vous ne dépassez pas la limite de messages

### Erreur de recherche Bible

Si la recherche échoue :

1. Vérifiez votre connexion internet
2. Vérifiez que la référence biblique est valide
3. Les providers API peuvent être temporairement indisponibles
4. Le système essaiera automatiquement les providers de secours
