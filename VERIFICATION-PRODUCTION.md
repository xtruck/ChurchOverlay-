# Liste de vérification — avant de faire confiance en production

Tout ce qui suit a été codé, testé unitairement (`npm test`, lint, `tsc`,
`npm audit` tous verts) et relu attentivement, mais **jamais exécuté dans
une vraie fenêtre Electron avec du vrai matériel** — le développement s'est
fait dans un environnement sans GUI ni périphériques réels. Cochez chaque
ligne après un vrai test, idéalement lors d'un culte "à blanc" plutôt que
le dimanche matin même.

## Priorité haute — fonctionnalités les plus récentes

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
