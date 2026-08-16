Audit ChurchOverlay (xtruck) — Rapport

Contexte

App Electron (Windows) : micro → FFmpeg → Whisper/Groq → détection de référence biblique → API biblique → overlay.html (OBS). Application 100% française.

Bugs trouvés et corrigés

CRITIQUE — La recherche de verset ne fonctionnait JAMAIS

bible-lookup-with-api.js utilisait deux fournisseurs :

genuinegospel.com/api/verses/french/... → 404 (URL inexistante)

dump JSON aruljohn/bible-api via jsdelivr → 404 (fichier inexistant dans le repo)

Résultat : peu importe la référence détectée (manuelle ou automatique), bibleLookup.getVerse() échouait systématiquement avec "Could not fetch verse from any provider" — la fonctionnalité principale de l'app ne marchait jamais, même avec une bonne connexion internet.

Correctif : remplacement par bible.helloao.org, une API JSON gratuite, sans clé, qui sert la traduction française "Louis Segond 1910" (fra_lsg). Vérifié en live : Jean 3:16, Psaumes 23:1, Romains 8:28, 1 Corinthiens 13:4-7, Apocalypse 21:4 renvoient maintenant le vrai texte. Un chapitre est mis en cache dès son premier téléchargement pour éviter de re-télécharger à chaque verset.

Incohérence dans detector.js (détection chapitre seul)

La suite de tests officielle (tests/test-detector.js, exécutée par npm test) attend que "Psaume 23" (chapitre seul, sans verset) soit détecté. Mais le mini test intégré en bas de detector.js (exécuté seulement via node detector.js) attendait l'inverse pour "Jean 3" / "Jean chapitre 3" — 2 échecs sur 17 à chaque exécution manuelle. Corrigé pour que les deux suites soient cohérentes avec le comportement réellement voulu (chapitre seul = détecté, comme testé officiellement).

Vérifications faites (sans régression)

npm test (detector + validation + rate-limiter + config-validator) : 100% OK

node detector.js (17 cas) : 17/17 OK

Recherche de versets réels contre l'API en direct : OK (voir ci-dessus)

node --check sur tous les fichiers modifiés : aucune erreur de syntaxe

Non testé ici (nécessite Windows + matériel)

Le pipeline complet (micro FFmpeg dshow → whisper-server.exe → overlay OBS) est spécifique à Windows et nécessite un micro physique + les binaires whisper-server.exe/modèles .bin non présents dans le repo. Cette partie n'a pas pu être testée en conditions réelles dans cet environnement Linux, mais le code n'a montré aucune anomalie logique à la lecture (gestion des timeouts, nettoyage des fichiers temporaires, fallback Groq→local, tous corrects).

Fichiers modifiés

bible-lookup-with-api.js (réécrit)

detector.js (commentaires/expectations de test alignés, pas de changement de comportement de production)

Round 2 — Audit & complétion du setup Electron

Contexte : npm test passait déjà (13+13+10+17 cas OK), la recherche de versets était déjà réparée (round 1). Ce round s'est concentré sur l'appli Electron elle-même (main.js/preload.js/dashboard.html/setup.html) et sur ce qu'il manquait pour packager une build Windows installable.

Bugs trouvés et corrigés

CRITIQUE — APP_ROOT pointait hors du dossier de l'app dans main.js

main.js est à la racine du dépôt, juste à côté de server.js, overlay.html, etc. Mais le code faisait const APP_ROOT = path.join(__dirname, '..'), soit un dossier au-dessus de l'endroit réel du projet. Conséquences en production (build packagée) :

spawn(process.execPath, [path.join(APP_ROOT, 'server.js')]) échouait (server.js introuvable) → le pipeline ne démarrait jamais après le premier écran de configuration.

L'URL overlay envoyée au tableau de bord (overlayUrl) était fausse, donc le lien à coller dans OBS pointait vers un fichier inexistant.

Correctif : APP_ROOT = __dirname.

Icônes manquantes — icon.png et icon.ico étaient référencés partout (fenêtres Electron, tray, installeur NSIS via build.win.icon dans package.json) mais absents du dépôt. electron-builder --win nsis aurait échoué ou produit un exécutable sans icône. Génération de :

icon.png (256×256, utilisé par les fenêtres/tray)

icon.ico (multi-résolution 16/24/32/48/64/128/256, requis par NSIS/Windows)

Sources conservées dans assets/ (icône source 1024×1024 + toutes les résolutions intermédiaires) pour régénérer si besoin.

package-lock.json désynchronisé — le lockfile committé ne listait aucune devDependencies (ni electron, ni electron-builder) et portait encore l'ancien nom de projet overlay-versets-mesev. Un npm ci frais n'aurait donc pas installé Electron. Régénéré via npm install.

author manquant dans package.json — electron-builder avertit (et certains packagers refusent de builder) sans champ author. Ajouté.

Vérifications faites

npm install : 311 paquets, sans erreur.

npm test : 100% OK (detector 17/17, validation 13/13, rate-limiter 9/9, config-validator 10/10).

node --check sur tous les .js du dépôt : aucune erreur de syntaxe.

bible-lookup-with-api.js : appel réel à bible.helloao.org en direct (Jean 3:16 → texte Louis Segond 1910 correct, provider helloao-lsg).

Pipeline bout-en-bout sans matériel : node server.js démarre le serveur WebSocket, se dégrade proprement (avertissement, pas de crash) quand whisper-server.exe/FFmpeg périphérique ne sont pas disponibles (attendu sur Linux/sans matériel), puis node tests/test-envoi.js envoie bien un verset réel (texte Jean 3:16) via WebSocket au serveur qui l'accepte.

npx electron-builder --dir --linux : la configuration de packaging (build dans package.json) est valide et produit un dist/linux-unpacked sans erreur (télécharge Electron, résout icônes/fichiers). Confirme que le setup Electron est maintenant complet ; seule la génération du binaire Windows (--win nsis) nécessite d'être lancée sur/pour Windows (ou en CI Windows), non testable telle quelle dans ce bac à sable Linux.

Non testé ici (nécessite Windows + matériel réel)

Capture micro réelle via FFmpeg dshow, transcription Whisper/Groq en conditions réelles, et l'installeur NSIS final. Le code n'a montré aucune anomalie logique à la lecture.
