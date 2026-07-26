Audit ChurchOverlay (xtruck) — Round 4

Contexte

Les rounds 1 à 3 (voir AUDIT.md et AUDIT-round3.md) avaient déjà traité : la recherche de versets cassée, l'incohérence de packaging Electron (APP_ROOT, icônes, lockfile), un fichier avec erreur de syntaxe (ai-enricher.js), une dépendance manquante (obs-websocket-js), et le chantier des thèmes personnalisables.

Ce round 4 est un audit complet indépendant, backend (server.js et tous les modules require()'d par lui : validation.js, rate-limiter.js, config-validator.js, groq-wrapper.js, deepgram-wrapper.js, bible-lookup-with-api.js, audio-capture.js, context-tracker.js) et frontend (main.js, preload.js, dashboard.html, setup.html, overlay.html).

Méthode : npm install, npm test (100% OK avant et après), node --check sur tous les .js, npm audit --omit=dev (0 vulnérabilité), npm run check-files (packaging OK), revue manuelle ligne par ligne du pont Electron (contextIsolation/nodeIntegration, contextBridge, IPC), de la validation des messages WebSocket, du rate limiting, et recherche d'injections XSS dans les 3 pages HTML (grep innerHTML).

Constat général : le code est déjà dans un état très mature après 3 rounds d'audit — contextIsolation activé partout, aucune clé API en dur, verrou mono-instance, garde-fous de crash worker, échappement HTML systématique avant tout innerHTML (dashboard.html), et overlay.html n'utilise que textContent (jamais de risque d'injection même avec du texte biblique renvoyé par une API tierce compromise).

Bug trouvé et corrigé

MOYEN — Mot de passe OBS stocké en clair (incohérent avec le reste de l'app)

main.js chiffre systématiquement les clés Groq et Deepgram avec safeStorage (API Electron liée au trousseau du système : Credential Manager sous Windows, Keychain sous macOS) avant de les écrire dans config.json — voir saveConfigAsync(). Mais le mot de passe du serveur OBS WebSocket, configuré depuis le dashboard (obs-set-config), était écrit tel quel dans config/features.json :

if (typeof password === 'string') features.broadcast.multiScene.password = password;
fs.writeFileSync(featuresPath, JSON.stringify(features, null, 2), 'utf8');

Conséquence : quiconque a accès en lecture au dossier d'installation de l'app (autre utilisateur du même PC, sauvegarde non chiffrée, etc.) pouvait lire le mot de passe OBS en clair dans un fichier JSON, alors que l'app promet explicitement ailleurs ("jamais de secret en dur / en clair") de protéger ce type de donnée. obs-controller.js le lisait ensuite directement (cfg.password) pour se connecter.

Correctif :

main.js (obs-set-config) : le mot de passe est maintenant chiffré via safeStorage.encryptString() et stocké dans un nouveau champ passwordEncrypted (base64), avec repli explicite (log d'avertissement, pas d'écriture silencieuse) si le chiffrement système n'est pas disponible — exactement le même traitement que pour Groq/Deepgram. Un mot de passe vide envoyé volontairement efface bien le champ chiffré ; un champ undefined (utilisateur n'a pas touché au champ) ne touche à rien. Un éventuel reliquat en clair d'une ancienne version est purgé à chaque sauvegarde.

main.js (obs-get-config) : hasPassword teste maintenant les deux champs (passwordEncrypted en priorité, password en repli pour une config déjà existante non migrée) sans jamais renvoyer la valeur au renderer.

obs-controller.js : nouvelle fonction resolvePassword(cfg) qui déchiffre passwordEncrypted avant de s'en servir dans obsClient.connect(...), avec le même repli que main.js sur cfg.password en clair (config pré-correctif, jamais réécrite depuis).

Fichiers modifiés dans ce round

main.js (obs-get-config / obs-set-config)

obs-controller.js (resolvePassword + connect)

Vérifications faites

npm install : 291 paquets, sans erreur.

npm audit --omit=dev --audit-level=high : 0 vulnérabilité.

npm test (suite officielle complète, 9 fichiers de test) : 100% OK, avant et après le correctif (aucune régression — le correctif ne touche à aucun fichier couvert par la suite officielle, la feature OBS restant désactivée par défaut).

node --check sur tous les .js du dépôt : 0 erreur.

node scripts/check-build-files.js : ✓ OK (aucun fichier ajouté/renommé).

Revue manuelle des 3 pages HTML pour XSS (grep innerHTML) : tout texte d'origine externe (logs serveur, transcriptions, historique de versets, texte biblique) passe soit par textContent (overlay.html), soit par une fonction d'échappement dédiée avant tout innerHTML (dashboard.html) — aucune injection possible trouvée.

Revue manuelle du pont Electron (main.js/preload.js) : contextIsolation activé, nodeIntegration désactivé, contextBridge n'expose que des fonctions précises (pas d'accès Node/Electron brut au renderer) — conforme aux bonnes pratiques de sécurité Electron.

Non modifié intentionnellement

La fonctionnalité OBS multi-scène reste désactivée par défaut (config/features.json : enabled: false, mot de passe vide) — le correctif est un durcissement préventif, pas une réaction à un incident.

Aucun changement de comportement fonctionnel ailleurs : le reste du dépôt (backend WebSocket, détection bilingue, cache API biblique, rate limiting, validation des messages) n'a montré aucune anomalie à la lecture dans ce round.
