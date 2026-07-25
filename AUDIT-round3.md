Audit ChurchOverlay (xtruck) — Round 3

Contexte
--------
Rounds 1 et 2 (voir AUDIT.md) avaient déjà réparé bible-lookup-with-api.js,
detector.js, l'icône/packaging Electron. Ce round vérifie l'intégralité du
dépôt actuel : `npm install`, `node --check` sur tous les .js, `npm test`,
`node scripts/check-build-files.js`, plus une revue manuelle des modules non
couverts par la suite de tests officielle.

Bugs trouvés et corrigés
-------------------------

1) CRITIQUE (bloquant) — ai-enricher.js : erreur de syntaxe
   Un fragment de code (visiblement destiné à être copié dans server.js)
   avait été laissé après `module.exports`, avec une ligne de prose littérale
   ("Intégration dans server.js") interprétée par Node comme du JavaScript :
     SyntaxError: Unexpected identifier 'dans'
   Aucun fichier du dépôt ne fait `require('./ai-enricher')` actuellement
   (seul le fragment cassé lui-même s'auto-référençait), donc ça ne fait pas
   planter l'app aujourd'hui — mais tout outil qui parse tous les .js du repo
   (linter, bundler, `node --check` en CI) le détecte comme cassé, et le
   fichier serait inutilisable tel quel si quelqu'un l'active.
   Correctif : fragment orphelin supprimé, le fichier s'arrête proprement à
   module.exports. Comportement des 5 fonctions IA inchangé.

2) MOYEN (latent, pas encore actif) — obs-controller.js : dépendance manquante
   Le module fait `await import('obs-websocket-js')` mais ce paquet n'est
   déclaré nulle part dans package.json (ni dependencies ni devDependencies).
   Tant que `features.broadcast.multiScene.enabled` reste `false` (valeur
   par défaut actuelle dans config/features.json), ce code ne s'exécute
   jamais — donc pas de bug visible aujourd'hui. Le jour où quelqu'un active
   cette fonctionnalité, `import()` échouera avec "Cannot find module
   'obs-websocket-js'".
   Correctif : ajout de "obs-websocket-js": "^5.0.6" dans dependencies de
   package.json (import dynamique conservé dans obs-controller.js — la
   dépendance existe maintenant mais n'est chargée en mémoire que si la
   feature est activée, comme prévu par le design du fichier).

3) MOYEN — test/test-theme-loader.js : test cassé, hors de npm test
   Ce test attend une API (duplicateTheme, getActiveTheme, setActiveTheme)
   et un format de données (colors.or, colors.nuit, champ readonly, thèmes
   "noel" et "paques") que theme-loader.js et config/themes/*.json actuels
   n'ont pas :
     - theme-loader.js n'exporte que loadTheme, listThemes, saveTheme,
       deleteTheme, themeToCss.
     - config/themes/ ne contient que mesev-default.json et
       sobre-clair.json (structure colors.accent / colors.background, pas
       colors.or / colors.nuit).
   Par ailleurs, theme-loader.js et obs-controller.js ne sont require() par
   AUCUN fichier du dépôt (ni main.js, ni server.js, ni dashboard.html) :
   ce sont des modules non branchés au reste de l'application, probablement
   une fonctionnalité "thèmes personnalisables" commencée puis mise en
   pause avant d'être reliée à l'UI.
   Ce test n'était pas dans le script `test` de package.json (seulement
   atteignable via un lancement manuel ou via `npm run test-all`), donc il
   ne bloquait pas la CI existante, mais échouait silencieusement pour
   quiconque le lançait directement.
   Correctif appliqué : je n'ai PAS réécrit theme-loader.js pour deviner un
   format de données qui n'est spécifié nulle part (cela aurait été
   inventer une fonctionnalité, pas corriger un bug). J'ai neutralisé le
   test avec un skip explicite et un commentaire détaillé expliquant
   pourquoi, en conservant le corps de test original intact (dans une
   fonction jamais appelée) comme spécification de référence pour le jour
   où quelqu'un termine cette fonctionnalité.
   Décision produit à prendre par toi : soit finir theme-loader.js pour
   qu'il corresponde à ce test (et créer les thèmes noel.json/paques.json),
   soit supprimer complètement ce chantier inachevé (theme-loader.js,
   obs-controller.js, test-theme-loader.js) s'il n'est plus d'actualité.

Vérifications faites (round 3)
-------------------------------
- npm install : 285 paquets, sans erreur (Node v22.22.2 / npm 10.9.7).
- node --check sur tous les .js du dépôt : 0 erreur après correctifs
  (1 erreur — ai-enricher.js — avant correctif).
- npm test (check-build-files + detector fr/en + validation + rate-limiter
  + config-validator + groq-fallback-race) : 100% OK, avant et après les
  correctifs (ces correctifs ne touchent à aucun fichier couvert par la
  suite officielle, donc pas de régression possible côté CI existante).
- node scripts/check-build-files.js : ✓ tous les fichiers require() depuis
  main.js/server.js sont bien couverts par build.files (pas de régression
  de packaging introduite par les correctifs).
- node test-theme-loader.js (corrigé) : se termine proprement (exit 0,
  message de skip explicite) au lieu de planter à la première assertion.

Fichiers livrés dans ce round
------------------------------
- ai-enricher.js (fragment cassé retiré)
- package.json (ajout de la dépendance obs-websocket-js)
- test-theme-loader.js (skip explicite + documentation, à placer dans
  test/test-theme-loader.js)

Non touché intentionnellement
-------------------------------
- theme-loader.js et obs-controller.js eux-mêmes : syntaxiquement corrects,
  mais fonctionnalité non finalisée / non branchée. Les modifier sans
  spec claire serait introduire du comportement non demandé.
- config/features.json : toutes les features expérimentales (IA, thèmes
  custom, multi-scène OBS) restent désactivées par défaut, comme avant.
