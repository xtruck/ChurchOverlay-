Audit ChurchOverlay (xtruck) — Rapport

Contexte

App Electron (Windows) : micro → FFmpeg → Whisper/Groq → détection de référence biblique → API biblique → overlay.html (OBS). Application 100% française.

Bugs trouvés et corrigés

1. CRITIQUE — La recherche de verset ne fonctionnait JAMAIS

bible-lookup-with-api.js utilisait deux fournisseurs :

genuinegospel.com/api/verses/french/... → 404 (URL inexistante)

dump JSON aruljohn/bible-api via jsdelivr → 404 (fichier inexistant dans le repo)

Résultat : peu importe la référence détectée (manuelle ou automatique), bibleLookup.getVerse() échouait systématiquement avec "Could not fetch verse from any provider" — la fonctionnalité principale de l'app ne marchait jamais, même avec une bonne connexion internet.

Correctif : remplacement par bible.helloao.org, une API JSON gratuite, sans clé, qui sert la traduction française "Louis Segond 1910" (fra_lsg). Vérifié en live : Jean 3:16, Psaumes 23:1, Romains 8:28, 1 Corinthiens 13:4-7, Apocalypse 21:4 renvoient maintenant le vrai texte. Un chapitre est mis en cache dès son premier téléchargement pour éviter de re-télécharger à chaque verset.

2. Incohérence dans detector.js (détection chapitre seul)

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
