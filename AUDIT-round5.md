# Audit round 5 — mise en service

Audit complet du dépôt (installation, exécution réelle du pipeline, revue de
code) avec pour objectif de rendre l'application opérationnelle. Contrairement
aux rounds précédents, chaque défaut listé ci-dessous a été **reproduit**
avant correction, et couvert par un test qui échoue sans le correctif.

## Corrections

### 1. `lastQuoteMatch` non déclaré — la détection par citation ne marchait jamais (bloquant)

`server.js` (mode strict) lisait puis assignait `lastQuoteMatch` sans aucune
déclaration. Dès qu'un verset était reconnu **sans que sa référence soit
prononcée** (`findByQuotedText`), le traitement du segment levait
`ReferenceError: lastQuoteMatch is not defined`, attrapé plus haut et diffusé
comme `transcriptionError` : aucun verset n'était jamais affiché par ce
chemin. Invisible en test, le mock de `findByQuotedText` renvoyant toujours
`null`.

Correctif : déclaration au niveau module + `test/integration-quote-match.js`
(server.js réel, citation reconnue puis répétée) — ce test échoue avec le code
précédent.

### 2. Config et thèmes écrits dans `app.asar` — inopérant dans l'app installée

`theme-loader.js` et `main.js` écrivaient dans `<app>/config/features.json` et
`<app>/config/themes/`. Avec `asar: true` (packaging NSIS), ces fichiers sont
dans une archive **en lecture seule** : changer de thème, créer/dupliquer un
thème ou enregistrer la config OBS échouait systématiquement chez un
utilisateur installé, alors que tout fonctionnait en développement.

Correctif : nouveau `features-store.js` (config livrée + surcharges
utilisateur dans `userData`, fusion profonde à la lecture, écriture atomique)
et `theme-loader.setUserDataDir()` (thèmes utilisateur dans
`userData/themes`, prioritaires sur ceux livrés). `main.js` et le worker
`server.js` pointent tous deux vers `userData`, donc l'overlay reçoit bien le
thème choisi. Couvert par `test/test-features-store.js`.

### 3. Mot de passe OBS stocké en clair (sécurité)

`obs-controller.js` sait lire un champ `passwordEncrypted` (`safeStorage`)
depuis le round 4, mais `obs-set-config` (main.js) écrivait toujours le mot de
passe **en clair** dans `features.json`. Correctif : chiffrement via
`safeStorage` à l'enregistrement, suppression du champ en clair existant, et
`obs-get-config` signale la présence d'un mot de passe (chiffré ou hérité)
sans jamais renvoyer sa valeur. Le repli en clair ne subsiste que si le
chiffrement système est indisponible, avec avertissement.

### 4. Config OBS relue à chaud

`obs-controller.js` figeait `config/features.json` au premier `require()`, ce
qui obligeait `main.js` à purger le cache de modules après chaque
enregistrement — et faisait perdre la connexion OBS en cours au passage. La
config est maintenant relue à chaque `connect()` via `features-store`, et le
hack d'invalidation de cache a disparu.

### 5. `GROQ_API_KEY` posée à la chaîne `"null"` dans le worker

`startServer()` faisait `GROQ_API_KEY: config.groqApiKey` sans condition :
clé absente ou indéchiffrable ⇒ le worker recevait la chaîne `"null"`, donc
le validateur la considérait comme configurée et chaque segment partait vers
Groq pour revenir en 401, au lieu de l'avertissement « clé non configurée ».

### 6. `.env` documenté mais jamais lu

Le README décrivait `.env` comme la façon de fournir les clés, alors que rien
ne le chargeait (aucune dépendance `dotenv`). `npm run server-only` utilise
désormais `node --env-file-if-exists=.env`, et le README explique où vivent
réellement les clés selon le mode d'exécution (fenêtre de configuration
chiffrée pour l'app, `.env`/variables d'environnement pour le serveur seul).

### 7. `package-lock.json` désynchronisé

Le lock déclarait encore la version `0.3.3` (package.json : `0.4.3`).

## Vérifié, sans changement nécessaire

- **Récupération des versets** : les deux fournisseurs (`bible.helloao.org`,
  `api.getbible.net`) répondent ; `Jean 3:16`, cache mémoire et cache disque
  testés en réel.
- **Serveur WebSocket** : démarre sur 8765, bind `127.0.0.1`, validation de
  schéma + limitation de débit + contrôle d'origine actifs.
- **Détection** : suite `detector` / `detector-en` / reading mode / buffer de
  phrase complète et verte (113 assertions).
- **Sécurité Electron** : `contextIsolation: true`, `nodeIntegration: false`,
  clés API chiffrées via `safeStorage`, aucun secret dans le dépôt.
- **`npm audit --omit=dev --audit-level=high`** : 0 vulnérabilité.
- Aucun autre `no-undef` dans le dépôt (scripts inline des pages HTML inclus).

## Reste à faire (hors périmètre code)

- **Transcription en direct** : nécessite une vraie clé `GROQ_API_KEY` — le
  chemin micro → Groq → détection n'a pas pu être exercé de bout en bout sans
  clé.
- **Intégration OBS** : nécessite OBS Studio avec obs-websocket activé.
- **Installateur Windows** : produit par le workflow `build-windows.yml`, non
  exécutable depuis un environnement Linux.
- Fichiers morts conservés et documentés comme tels : `ai-enricher.js`
  (dépendance `emergentintegrations` non déclarée), `bible-lookup.js`
  (attend un `bible-lsg.json` absent), thèmes `mesev-default.json` /
  `sobre-clair.json` (doublons de `nuit` / `claire`).
