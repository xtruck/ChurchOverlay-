# Guide de l'opérateur — ChurchOverlay

Ce guide s'adresse à l'équipe de bénévoles qui fait fonctionner ChurchOverlay
pendant un culte — pas aux développeurs. Pour l'installation technique, voir
`QUICKSTART-WINDOWS.md` / `SETUP.md`.

Le tableau de bord a deux onglets, dans la barre latérale :

- **En Direct** — tout ce dont vous avez besoin PENDANT le culte.
- **Réglages** — thèmes, accessibilité, caméra, médiathèque, config,
  aperçu overlay/OBS — à consulter avant/après, pas pendant.

---

## 1. Avant le culte — vérifications rapides

1. Ouvrez l'app, vérifiez que le point de statut (sidebar, en bas) est
   **vert** ("Serveur En Ligne").
2. Onglet **En Direct** → cliquez **Démarrer le Micro**. Le badge doit
   passer sur "Capture active".
3. Dites une phrase test avec une référence biblique claire ("Jean 3:16")
   et vérifiez que le verset s'affiche sur l'overlay (utilisez l'aperçu
   dans Réglages → Overlay, ou regardez directement dans OBS).
4. Si vous utilisez une **caméra USB** ou un **poster principal**, vérifiez-les
   maintenant (voir sections dédiées plus bas) — pas au milieu du culte.
5. Copiez le lien overlay (Réglages → Overlay → **📋 Copier le lien pour
   OBS**) et confirmez qu'il est bien collé comme Source Navigateur dans OBS.

## 2. Pendant le culte

### Détection automatique de versets

Rien à faire — dès qu'une référence biblique est prononcée clairement
("Jean chapitre 3 verset 16", "Romains 8:28"...), elle s'affiche
automatiquement. Un badge indique comment elle a été détectée (citation
exacte, référence explicite, IA). Si le pasteur cite un verset sans le
nommer explicitement ("il est écrit que Dieu a tant aimé le monde..."),
la détection par citation peut aussi le reconnaître.

### Sous-titres

Réglages → Accessibilité de l'overlay :

- **Sous-titres en direct** : affiche la transcription brute (ce qui est
  dit) en bas de l'overlay — utile pour les malentendants ou une salle
  avec un écran éloigné.
- **Sous-titres traduits en direct** (nouveau) : traduit en direct ce qui
  est DIT dans une langue choisie (anglais/espagnol/portugais/allemand).
  **Différent** du mode bilingue ci-dessous : ceci traduit la PAROLE, pas
  seulement les versets cités. Utilise un appel IA gratuit supplémentaire
  par phrase — à laisser désactivé si votre assemblée n'en a pas besoin,
  pour ne pas consommer inutilement le quota gratuit partagé avec la
  transcription.
- **Bouton "🌐 Bilingue (FR + EN)"** (En Direct, sélecteur de langue) :
  affiche le VERSET cité en français et en anglais côte à côte — existe
  depuis longtemps, ne consomme aucun appel IA supplémentaire (juste une
  seconde traduction biblique).

### Bibliothèque de chants et médiathèque (photos/vidéos)

Réglages → Médiathèque / Bibliothèque de chants — ajoutez un fichier ou un
chant une fois, avec un **nom** et éventuellement une **phrase
déclencheuse**. Ensuite, il suffit de **dire le nom** pendant le culte pour
qu'il s'affiche (ex. « affiche Poster annonces », « chantons Amazing
Grace »). Si vous laissez la phrase déclencheuse vide, le nom lui-même sert
de déclencheur — pas besoin de remplir les deux champs.

Un bouton **▶** à côté de chaque élément permet aussi de le déclencher
manuellement, sans le dire à voix haute.

### Poster principal (nouveau)

Cliquez l'**étoile ⭐** à côté d'un média (typiquement une image
d'annonces/logo) pour en faire le **poster principal** : il reste affiché
en continu tant que rien d'autre (verset, autre média) n'est à l'écran —
l'écran ne reste plus jamais vide entre deux versets. Il s'efface
automatiquement dès qu'un verset ou un autre média prend le relais, et
revient tout seul dès que l'écran redevient libre. Un seul poster
principal à la fois — en désigner un nouveau démarque automatiquement
l'ancien.

### Caméra (aperçu opérateur)

Réglages → Caméra : liste les webcams disponibles, aperçu local pour vous
uniquement (pas encore diffusé publiquement). Fonctionne aussi avec une
caméra **NDI** si vous installez l'outil gratuit *NDI Virtual Input*
(suite NDI Tools de NewTek/Vizrt) — elle apparaît alors dans la même liste
que les webcams USB normales.

### En cas de problème pendant le culte

- **Effacer immédiatement l'écran** : bouton d'urgence / raccourci
  correspondant à `emergencyClear` — efface le verset ET tout média
  affiché (le poster principal, s'il y en a un, réapparaît juste après,
  plutôt qu'un écran noir).
- **Micro qui ne détecte rien depuis longtemps** : une alerte apparaît
  automatiquement après ~1 minute de silence continu (micro trop bas ou
  mauvais périphérique sélectionné).

## 3. Après le culte

### Historique de session

Réglages → Historique de session : **Dernières 24h** / **7 derniers
jours** — liste tous les versets affichés et les erreurs éventuelles.

### Export des temps forts (nouveau)

Bouton **🎬 Exporter les temps forts** (sous l'historique de session) :
génère la liste de tout ce qui a été affiché pendant le culte EN COURS
(versets, chants, médias) au format **chapitres YouTube** (à coller
directement dans la description de la vidéo si vous publiez
l'enregistrement) — un export CSV est aussi copié automatiquement dans le
presse-papiers pour un logiciel de montage.

### Questions sur une prédication passée

Réglages → assistant Q&R sermons : posez une question en langage naturel
("qu'est-ce que le pasteur a dit sur la grâce dimanche dernier ?"), les
réponses citent toujours la prédication source — jamais de réponse
inventée sans contenu réel à citer.

---

## Dépannage rapide

| Symptôme | Vérifier |
|---|---|
| Aucun verset ne s'affiche | Micro démarré ? Badge "Capture active" ? Clé Groq configurée (écran de setup) ? |
| Le verset apparaît en retard/coupé | Réseau lent — la détection par citation exacte est la plus rapide, privilégiez des références explicites ("Jean 3:16") |
| Le poster principal ne réapparaît pas | Un verset ou un autre média est peut-être encore actif à l'écran — le poster ne reprend sa place que si RIEN d'autre n'est affiché |
| "show poster X" ne déclenche rien | Vérifiez que le nom/la phrase déclencheuse correspond bien à ce qui est dit — la correspondance est par sous-chaîne, pas par similarité approximative |
| Caméra NDI absente de la liste | Installez/activez "NDI Virtual Input" (NDI Tools gratuit) — sans lui, une source NDI n'apparaît pas comme une webcam standard |
| Sous-titres traduits en retard ou absents | Normal par design (best-effort, jamais bloquant) — vérifiez simplement que le quota gratuit Groq/Gemini n'est pas épuisé par ailleurs |

Pour les détails techniques (variables d'environnement, protocole
WebSocket, architecture), voir `README.md`, `API.md` et
`ARCHITECTURE.md`.
