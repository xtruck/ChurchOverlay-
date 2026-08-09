# Liste de vérification — avant de faire confiance en production

Tout ce qui suit a été codé, testé unitairement (`npm test`, lint, `tsc`,
`npm audit` tous verts) et relu attentivement, mais **jamais exécuté dans
une vraie fenêtre Electron avec du vrai matériel** — le développement s'est
fait dans un environnement sans GUI ni périphériques réels. Cochez chaque
ligne après un vrai test, idéalement lors d'un culte "à blanc" plutôt que
le dimanche matin même.

## Priorité haute — fonctionnalités les plus récentes

### Caméra téléphone par QR code (nouveau, à tester avec un vrai réseau Wi-Fi)

- [ ] Configurer `WS_HOST` sur une adresse réseau (pas `127.0.0.1`) avec
      `WS_AUTH_TOKEN`/`WS_VIEWER_TOKEN` définis (voir README.md), sinon le
      bouton "Générer un QR code" doit afficher un message d'erreur clair —
      confirmer que ce message apparaît bien quand `WS_HOST` reste local.
- [ ] Une fois configuré : cliquer "Générer un QR code" → un QR valide
      apparaît (le scanner avec une app QR tierce pour vérifier qu'il
      encode bien une URL `http://<ip-du-pc>:<port>/phone-camera.html?pair=...`
      avant même de tester avec un téléphone).
- [ ] Scanner avec un vrai téléphone → la page s'ouvre dans le navigateur
      (PAS de redirection vers un store d'applications), demande la
      permission caméra, affiche "En direct" une fois accordée.
- [ ] Le téléphone apparaît automatiquement dans le panneau "Caméras IP"
      du tableau de bord, SOUS LE NOM CHOISI avant de générer le QR (pas
      un nom générique) — tester avec 2-3 téléphones en parallèle pour
      confirmer qu'ils restent bien distinguables dans la liste.
- [ ] Générer un QR avec chacune des 3 qualités (Basse/Moyenne/Haute) →
      confirmer une différence visible de netteté/fluidité, et que
      "Basse" utilise sensiblement moins de données mobiles/Wi-Fi.
- [ ] Sur le téléphone, cliquer le bouton 🔄 → la caméra bascule avant/
      arrière sans recharger la page ; sur un appareil à une seule caméra,
      confirmer qu'un message clair apparaît plutôt qu'un écran noir.
- [ ] Réessayer de scanner le MÊME QR une deuxième fois → doit échouer
      clairement (usage unique) — confirmer qu'aucune deuxième caméra
      fantôme n'apparaît.
- [ ] Attendre 10+ minutes puis scanner un QR non utilisé → doit échouer
      clairement (expiré).
- [ ] Verrouiller l'écran du téléphone manuellement pendant la capture →
      noter si le flux s'interrompt (limite connue : l'API Wake Lock n'est
      pas garantie sur tous les navigateurs/OS) ; **surtout**, confirmer
      qu'après ~15-20s le badge du tableau de bord bascule bien sur "Hors
      ligne" plutôt que de rester "En ligne" indéfiniment (correctif de
      fiabilité — voir isFrameFresh côté serveur).
- [ ] Couper le Wi-Fi du téléphone quelques secondes PENDANT la capture,
      puis le réactiver → le flux doit reprendre tout seul, sans avoir à
      re-scanner le QR (le secret de flux reste valide, seul le réseau a
      été coupé).
- [ ] Supprimer la caméra téléphone depuis le panneau "Caméras IP" →
      confirmer (a) que le téléphone cesse d'être accepté (son ancien
      secret de flux ne doit plus fonctionner) ET (b) que la page du
      téléphone affiche bien "Caméra retirée" au lieu de continuer à
      essayer d'envoyer des images indéfiniment.
- [ ] Coller le lien copié (📋) dans OBS comme Source Navigateur → l'image
      du téléphone s'affiche dans OBS.
- [ ] Jumeler un 9ème téléphone alors que 8 caméras IP existent déjà (le
      plafond `MAX_ITEMS`) → la plus ancienne est retirée de la liste
      automatiquement ; confirmer qu'elle ne réapparaît pas plus tard et
      que scanner à nouveau son ancien QR (s'il restait valide) échoue
      proprement (correctif fuite de ressources — le jumelage orphelin
      est bien nettoyé, pas seulement caché de la liste).

### Bouton "✅ Tester avant le culte" (élargi)

- [ ] Cliquer le bouton avec une configuration complète (médiathèque,
      poster principal, logo, cache biblique, caméras IP toutes actives) →
      confirmer que chaque ligne s'affiche en vert avec un détail correct
      (nombre d'éléments, statut du cache, etc.), pas seulement les clés
      API/WS comme avant.
- [ ] Cliquer le bouton avec `WS_HOST` local (`127.0.0.1`) → la ligne
      "Caméra téléphone (QR)" doit clairement indiquer que ce n'est pas
      utilisable en l'état, sans être présentée comme une erreur bloquante.

### Caméras de téléphone (DroidCam) et habillage caméra

- [ ] DroidCam : avec le client PC lancé et connecté au téléphone, cliquer
      🔄 Actualiser dans le panneau Caméra → le téléphone apparaît dans la
      liste (ne doit plus être filtré comme "caméra virtuelle").
- [ ] Habillage caméra : copier le lien, l'ajouter comme Source Navigateur
      dans OBS, la positionner AU-DESSUS de la source caméra dans la scène
      → confirmer que le logo/texte s'affiche bien PAR-DESSUS l'image
      caméra et pas en dessous.
- [ ] Choisir un logo → il apparaît dans le coin choisi sur la Source
      Navigateur OBS en quelques secondes (broadcast WebSocket), sans
      recharger la source dans OBS.
- [ ] Changer la position du logo (menu déroulant) → il se déplace bien
      dans le coin choisi, sans jamais chevaucher le bandeau titre/sous-titre
      (toujours en bas, centré).
- [ ] Changer la taille du logo (petit/moyen/grand) → la taille change bien
      sur la Source Navigateur OBS, sans déborder de l'écran en "grand".
- [ ] Choisir un logo GIF animé → l'animation joue bien (aperçu dashboard
      ET Source Navigateur OBS).
- [ ] Choisir un logo vidéo (.mp4 ou .webm) → la vidéo joue en boucle,
      sans son, sans contrôles visibles, aussi bien dans l'aperçu du
      tableau de bord que sur la Source Navigateur OBS.
- [ ] Taper un titre/sous-titre, cliquer "Afficher sur la diffusion" →
      le bandeau apparaît avec une animation de fondu/glissement, pas un
      "saut" brutal. Cliquer "Masquer" → il disparaît proprement.
- [ ] Redémarrer l'app → le logo et sa position doivent être conservés (ils
      sont persistés), mais le titre/sous-titre doivent repartir vides
      (volontairement NON persistés, voir GUIDE-OPERATEUR.md).
- [ ] Recharger la Source Navigateur "Habillage caméra" dans OBS pendant
      qu'un titre est affiché → il doit réapparaître correctement (état
      renvoyé via le message `init` à la reconnexion).

### Poster principal

- [ ] Marquer un média comme principal (⭐) → il apparaît immédiatement sur
      l'overlay si rien d'autre n'est affiché.
- [ ] Dire une phrase déclenchant un verset PENDANT que le poster principal
      est affiché → le verset doit bien prendre le dessus (c'était cassé
      avant le correctif de cette session : le verset restait caché
      derrière le média).
- [ ] Laisser le verset s'effacer (fin de sa durée d'affichage) → le poster
      principal doit réapparaître tout seul, sans action manuelle.
- [ ] Déclencher un AUTRE média (poster/vidéo non-principal) → il doit
      prendre le dessus sur le poster principal ; à sa fin, le poster
      principal doit revenir.
- [ ] Tester le bouton/raccourci "effacement d'urgence" pendant que le
      poster principal est affiché → l'écran doit se vider brièvement puis
      le poster principal doit revenir (pas un écran noir permanent).
- [ ] Retirer le statut de poster principal (cliquer l'étoile à nouveau) →
      l'écran doit rester vide entre deux versets, comme avant cette
      fonctionnalité.
- [ ] Supprimer le média actuellement principal → vérifier qu'aucune image
      cassée ne réapparaît ensuite.

### Caméra (aperçu opérateur) et NDI

- [ ] Brancher une webcam USB → apparaît dans la liste, aperçu fonctionne.
- [ ] Débrancher la webcam PENDANT que l'aperçu est actif → message clair,
      pas de plantage.
- [ ] Refuser la permission caméra (Windows) → message clair, pas de
      plantage silencieux.
- [ ] Changer de caméra en cours d'utilisation → bascule proprement.
- [ ] Si vous avez une source NDI : installer "NDI Virtual Input" (NDI
      Tools, gratuit) → la source doit apparaître dans la liste comme une
      webcam normale et être sélectionnable.

### Sous-titres traduits en direct

- [ ] Activer, choisir une langue, parler pendant ~1 minute → la traduction
      apparaît sous les sous-titres bruts, avec un délai raisonnable.
- [ ] Vérifier qu'un flot de parole rapide/haché ne fait pas exploser le
      nombre d'appels IA (throttle de 1,5s attendu) ni ne ralentit/casse la
      détection de versets pendant ce temps.
- [ ] Désactiver → la ligne de traduction disparaît immédiatement.
- [ ] Recharger l'overlay (F5 dans OBS ou fermer/rouvrir la fenêtre
      d'affichage) pendant que c'est activé → l'état doit être correct au
      rechargement (voir action `init`).

### Export des temps forts

- [ ] Après un culte de test avec plusieurs versets/médias affichés,
      cliquer "🎬 Exporter les temps forts" → vérifier que le texte
      "chapitres YouTube" généré a bien un format valide (coller dans une
      description YouTube réelle pour confirmer qu'ils deviennent
      cliquables).
- [ ] Vérifier que le CSV copié dans le presse-papiers s'ouvre correctement
      dans Excel/Google Sheets (encodage, colonnes).

### Détails d'affichage média (durée + style)

- [ ] Régler une durée personnalisée sur une image → elle se masque bien au
      bout du temps réglé, pas 15s par défaut.
- [ ] Tester chacun des 4 styles (Fondu / Glissement / Zoom / Coupe
      instantanée) sur un vrai média → confirmer visuellement que
      l'animation correspond au nom, et qu'aucune ne "saute" bizarrement.
- [ ] Modifier durée/style d'un média DÉJÀ uploadé (pas seulement à
      l'ajout) → le prochain déclenchement doit utiliser les nouvelles
      valeurs.

## Priorité moyenne — audit de performance (session précédente)

- [ ] Le badge CPU/RAM dans la barre latérale affiche des valeurs qui
      montent/descendent de façon crédible (pas bloqué à 0 ou une valeur
      fixe).
- [ ] Laisser le dashboard ouvert et minimisé/en arrière-plan pendant
      10-15 min → confirmer que l'usage CPU ne grimpe pas anormalement
      (le throttle de visibilité doit s'appliquer).
- [ ] Les particules d'ambiance (canvas) sur l'overlay ne causent pas de
      ralentissement visible dans OBS, y compris avec un enregistrement
      actif en parallèle.
- [ ] Un navigateur/OBS avec `prefers-reduced-motion` activé ne montre
      aucune particule.

## Priorité basse mais à ne pas oublier — fonctionnalités des sessions

antérieures, si jamais non testées

- [ ] Détection vocale de commandes (hotkeys globaux, si configurés).
- [ ] Bibliothèque de chants (déclenchement vocal + manuel).
- [ ] Stage Display / Diaporama d'annonces (fenêtres séparées).
- [ ] Base biblique hors-ligne : couper le réseau en plein culte et
      vérifier qu'un verset déjà en cache s'affiche quand même.
- [ ] Intégration ProPresenter / Planning Center, si utilisée par votre
      église.
- [ ] Page compagnon (`companion.html`) sur un second écran/téléphone.

## Sécurité — à faire une seule fois, pas à chaque culte

- [ ] Confirmer que `WS_HOST` reste `127.0.0.1` (défaut) sauf besoin réel
      d'accès distant. Si vous DEVEZ l'ouvrir au réseau, `WS_AUTH_TOKEN` et
      `WS_VIEWER_TOKEN` doivent être définis (le serveur refuse de démarrer
      sinon) — voir `README.md`.
- [ ] Si `WS_HOST` est ouvert au réseau : n'accordez le jeton opérateur
      (`WS_AUTH_TOKEN`) qu'à des personnes de confiance — il permet
      d'ajouter n'importe quel fichier local du poste serveur à la
      médiathèque publique (voir l'audit de sécurité, limitation connue et
      acceptée plutôt que corrigée pour ne pas casser la sélection libre de
      fichiers).

---

Une fois une ligne testée en conditions réelles et confirmée correcte,
cochez-la (`[x]`) et notez la date à côté si vous voulez garder une trace
pour l'équipe.
