# Architecture — ChurchOverlay

Ce document décrit l'application telle qu'elle existe réellement à ce jour
(0.9.1). Il remplace l'ancienne version, obsolète depuis le retrait de
Whisper local (v0.3.0) et de FFmpeg/DirectShow (v0.5.0) — ce contenu n'a
plus aucun rapport avec le pipeline actuel et a été supprimé plutôt que
mis à jour au fil de l'eau.

## Vue d'ensemble

ChurchOverlay est une application Electron pour la conduite d'un culte en
direct : transcription vocale en continu, détection automatique de
versets bibliques, et diffusion d'un overlay (verset, scène, média) vers
un vidéoprojecteur ou une source Navigateur OBS. Un tableau de bord
opérateur pilote tout le reste (médiathèque, chants, feuille de route,
IA, branding, caméras réseau).

```text
Micro (getUserMedia/AudioWorklet, capture.html)
  → audio-capture.js → groq-wrapper.js (cloud, principal)
  → deepgram-wrapper.js (repli, si configuré)
  → detector.js/detector-en.js/semantic-detector.js (détection de référence)
  → bible-lookup-with-api.js (texte du verset, cache disque)
  → server.js (WebSocket) → overlay.html (OBS / vidéoprojecteur)
                          → dashboard.html (opérateur)
```

Aucun modèle ML local, aucun binaire externe (Whisper/FFmpeg) : toute la
transcription passe par une API cloud (Groq Whisper, repli Deepgram). La
capture audio elle-même utilise l'API Web Audio standard d'un navigateur
Chromium (Electron), pas de couche native séparée.

## Processus Electron

- **main.js** — processus principal Electron. Crée la fenêtre du tableau
  de bord (`dashboard.html`), gère les fenêtres d'affichage secondaires
  (`overlay.html`, `stage-display.html`, `announcement-loop.html` — voir
  `DISPLAY_MODES`/`createDisplayWindow()`), la persistance chiffrée des
  clés API et jetons WS (`safeStorage`), l'auto-updater, le tray, et
  démarre le pipeline serveur (voir plus bas).
- **preload.js** — pont `contextBridge` entre le processus principal et le
  renderer. `contextIsolation: true` et `nodeIntegration: false` partout
  (toutes les `BrowserWindow`) ; le renderer n'a accès qu'aux fonctions
  explicitement exposées via `window.churchOverlay`, jamais à Node/`fs`
  directement.
- **Content-Security-Policy + sandboxing** — chaque fenêtre reçoit une CSP
  explicite (voir les `<meta http-equiv="Content-Security-Policy">` en
  tête de chaque page HTML) et `webPreferences.sandbox: true`. La
  navigation renderer→URL externe et `window.open()` sont restreints
  (voir `main.js`, gestion de `will-navigate`/`setWindowOpenHandler`).
- **server.js** — tourne comme un **Worker** `worker_threads` (pas un
  process séparé), spawné par `main.js` avec `resourceLimits.
maxOldGenerationSizeMb` borné et un **recyclage automatique toutes les
  4h** (`scheduleWorkerRecycle()`), pour qu'une fuite mémoire lente sur
  un culte de plusieurs heures ne s'accumule jamais indéfiniment.
  Communication avec `main.js` via `parentPort.postMessage`/`.on('message')`
  (statut, logs, PCM audio brut, changement de thème, état de la porte OBS).

## server.js et les gestionnaires WebSocket

`server.js` (~3200 lignes, réduit depuis ~4700 par l'extraction ci-dessous)
reste le point d'entrée : configuration, middlewares HTTP
(`http-routes.js`), authentification/gate WebSocket, et la construction de
`CATEGORY_HANDLERS` — une `Map` fusionnant les gestionnaires de chaque
domaine, chacun extrait dans son propre module :

```text
media-ws-handlers.js               scene-ws-handlers.js
song-ws-handlers.js                rundown-ws-handlers.js
camera-ws-handlers.js              branding-ws-handlers.js
accessibility-ws-handlers.js       reading-translation-ws-handlers.js
trust-ws-handlers.js               ai-assistant-ws-handlers.js
service-import-export-ws-handlers.js
core-verse-ws-handlers.js          timer-ws-handlers.js
plugins-exports-ws-handlers.js     diagnostics-ws-handlers.js
misc-ws-handlers.js                agent-ws-handlers.js
```

Chaque module exporte `createHandlers(ctx)`, où `ctx` regroupe les
dépendances partagées dont ce domaine a besoin (stores, `broadcast`,
`log`, etc. — injection explicite, pas d'import direct de `server.js`
depuis un handler). `createHandlers()` retourne une `Map<action,
handler>` ; `server.js` fusionne toutes ces `Map` dans `CATEGORY_HANDLERS`
au démarrage et route chaque message entrant via
`CATEGORY_HANDLERS.get(sanitized.action)`. Un gestionnaire a la
signature `async (ws, sanitized, requestId, sendError) => {}`.

**Ajouter une nouvelle action** : créer (ou étendre) le fichier
`*-ws-handlers.js` du domaine concerné, l'enregistrer dans son
`createHandlers()`, ajouter l'entrée correspondante dans
`action-registry.js` (métadonnées RBAC — voir plus bas) et, si l'action
prend un payload, un schéma dans `validation.js`.

## Authentification et autorisation

Deux jetons indépendants, générés aléatoirement (32 octets) au premier
lancement de l'app installée et persistés chiffrés (`safeStorage`) par
`main.js` (`ensureWsToken()`) :

- **`WS_AUTH_TOKEN`** — opérateur, contrôle complet du pipeline.
- **`WS_VIEWER_TOKEN`** — lecture seule, utilisé par l'overlay/OBS et les
  autres écrans d'affichage. Une fuite de ce jeton (ex. URL copiée dans
  une scène OBS partagée par erreur) ne donne jamais accès aux actions
  opérateur.

Le jeton voyage via l'en-tête de handshake `Sec-WebSocket-Protocol` (pas
`?token=` dans l'URL WebSocket — un proxy/CDN devant un serveur exposé
journalise typiquement l'URI de requête). `determineClientRole()`
détermine le rôle depuis le jeton présenté, jamais depuis le chemin de
connexion. Le rôle attribué (`ws.clientRole`) gate en entrée
(`OPERATOR_ACTIONS`, construit depuis `action-registry.js` via
`listOperatorOnlyActions()`) — la seule source de vérité RBAC.

**Validation d'origine** (`validateOrigin()`) — défense en profondeur
pour un bind non local (`WS_HOST` différent de `127.0.0.1`/`localhost`),
comparaison **exacte** contre `ALLOWED_ORIGINS` (pas de préfixe — un
`origin.startsWith(...)` aurait laissé passer un Origin forgé du type
`http://localhost:<port>.attacker.example`). Un bind non local exige de
toute façon `WS_AUTH_TOKEN` configuré (le serveur refuse de démarrer
sinon) : l'origine seule n'a jamais été le vrai contrôle d'accès.

## Validation des messages

`validation.js` définit un schéma (`{required, optional, validators}`)
pour chacune des **103 actions client** de `action-registry.js` (objet
`CLIENT_ACTIONS`, couverture vérifiée par test, voir
`test/test-validation.js` Test 38). Chaque champ non listé dans le schéma
est rejeté (`Champ non autorisé`), chaque valeur est typée/bornée. Un
champ optionnel dont le client envoie explicitement `null` (ex.
"désactiver la traduction secondaire") doit l'accepter dans son
validateur — une erreur déjà rencontrée une fois (voir historique Git,
`setSecondaryTranslation`).

`action-registry.js` reste la source de vérité pour l'autorisation
(`operatorOnly`) et les métadonnées affichées côté client (palette de
commandes Ctrl+K).

## Persistance

Tous les stores JSON locaux (médiathèque, scènes, chants, feuille de
route, archive de sermons, branding — caméra et tableau de bord) écrivent
via **`persistence/atomic-json-store.js`** : fichier temporaire à suffixe
unique (PID + compteur), `fsync` explicite avant `rename()` atomique sur
la cible, nettoyage du fichier temporaire si une étape échoue. Chaque
store garde son API existante (`writeIndex`/`writeConfig`/...) — seule
l'implémentation interne appelle le module partagé. Chaque lecture
(`readIndex`/...) tolère un fichier corrompu ou absent (repli sur un
index vide, avertissement en log).

`session-store.js` est à part : une base **SQLite** (`better-sqlite3`,
mode WAL) pour l'historique de session (versets affichés, erreurs) — un
mécanisme best-effort, ses écritures ne doivent jamais faire échouer le
pipeline principal.

## File de tâches (opérations coûteuses)

**`task-queue.js`** — file FIFO bornée, concurrence 1 par défaut,
indépendante de tout serveur HTTP/WebSocket. Utilisée pour sortir les
opérations d'I/O disque potentiellement lourdes du chemin synchrone des
gestionnaires WebSocket (import PowerPoint aujourd'hui — lecture async du
fichier + parsing, en file plutôt qu'inline dans le handler). `enqueue()`
rend une Promise ; une tâche qui échoue n'arrête jamais la file pour les
tâches suivantes.

## Contre-pression WebSocket

`broadcast()` (server.js) vérifie `ws.bufferedAmount` de chaque client
avant l'envoi (**`websocket-backpressure.js`**, fonction pure et
testable) : sous 1 Mo, envoi normal ; entre 1 et 4 Mo, ce message précis
est sauté pour ce client (log limité à 1 avertissement/10s) ; au-delà de
4 Mo, la connexion est terminée (`ws.terminate()`) — un socket qui ne
draine plus du tout n'accumule pas indéfiniment. `broadcast()` accepte
aussi un flag `operatorOnly` (filtre les clients `viewer`) — le mécanisme
existe mais n'est volontairement câblé sur aucune action existante : un
audit complet de ce que consomme chaque page pouvant se connecter en
`viewer` (`overlay.js`, `stage-display.html`, `branding-overlay.html`,
`announcement-loop.html` — chacune un sous-ensemble différent d'actions)
est nécessaire avant de restreindre une diffusion sans risquer de casser
un affichage public en direct.

## Tableau de bord (dashboard.html)

- **`dashboard/state.js`** — état partagé (`state`), connexion WebSocket
  et reconnexion.
- **`dashboard/ws-dispatch.js`** — un grand `switch` sur `message.action`
  reçu du serveur, délègue à la feature concernée.
- **`dashboard/utils.js`** — `showToast`, `addActivity`,
  `escapeHtmlDashboard`, `confirmDialog` (remplace les `confirm()`/
  `prompt()` natifs du navigateur par une modale stylée cohérente avec le
  reste du tableau de bord).
- **`dashboard/features/*.js`** (37 fichiers) — un module par panneau
  (médiathèque, studio de scènes, feuille de route, réglages API,
  branding, caméras IP, palette de commandes...).

**Reconnexion** : à la reconnexion WebSocket, le tableau de bord
redemande explicitement l'état à jour (scène active, feuille de route,
médiathèque, overlays, clients connectés) plutôt que de laisser un état
mémorisé périmé s'afficher comme s'il était toujours courant — voir
`test/integration-dashboard-reconnect-hydration.js` pour le scénario
complet.

**HTML/JS** : dashboard.html utilise encore majoritairement des
gestionnaires `onclick="..."` inline plutôt que `addEventListener` — un
chantier de nettoyage identifié mais pas encore fait (voir « Limites
connues » plus bas), à ne pas confondre avec un risque de sécurité actif
(aucune valeur contrôlée par l'utilisateur n'est interpolée dans ces
attributs).

## Tests

- `npm test` — suite Node native (~99 fichiers), stores/détection/
  validation/WS en isolation ou avec un vrai `server.js` démarré
  (`test/integration-*.js`, `test/test-ws-*.js`). Utilise
  `CHURCHOVERLAY_DATA_DIR` pour isoler son propre dossier de données —
  **toujours le définir en environnement de développement partagé**, sans
  quoi plusieurs exécutions successives polluent le vrai dossier
  `userData` de la machine et peuvent produire des échecs qui n'ont rien
  à voir avec le code (constaté en pratique).
- `npm run test:e2e` — Playwright, dashboard réel dans un vrai navigateur
  contre un vrai `server.js`.
- `npm run lint` / `npm run format:check` / `npm run type-check` — ESLint,
  Prettier (`**/*.{ts,js,json,md}` uniquement — pas le HTML/CSS), `tsc
--noEmit` (JSDoc typé, pas de migration TypeScript des fichiers `.js`).

## Commandes de développement

```bash
npm install         # installe les dépendances, rebuild better-sqlite3
cp .env.example .env  # puis renseigner au moins GROQ_API_KEY
npm start            # lance l'app Electron complète
npm run dev           # server.js seul (node), sans Electron — pas de capture micro native
npm test              # suite de tests complète
npm run test:e2e      # suite Playwright
```

## Limites connues et chantiers de suite

- **Inline `onclick=`/styles dans dashboard.html** — 34+ fichiers
  `dashboard/features/*.js` exposent leurs fonctions sur `window` pour
  que le HTML puisse les appeler en `onclick="..."` ; migrer vers
  `addEventListener` + `data-action` déléguée est un chantier séparé,
  volontairement pas fait en une seule passe (trop de surface pour être
  vérifié en une fois sans risquer de régression sur un outil utilisé en
  direct).
- **`broadcast({operatorOnly: true})`** — mécanisme prêt, pas encore
  appliqué à des diffusions existantes (voir plus haut).
- **`server.js` reste ~3200 lignes** — composition/bootstrap + logique
  HTTP/auth encore en place ; les ~17 domaines de gestionnaires WS sont
  extraits, une extraction plus poussée (routes HTTP, cycle de vie du
  worker) reste possible mais n'apporterait plus le même gain.
