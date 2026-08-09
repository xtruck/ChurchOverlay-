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

### Caméra (aperçu opérateur) — DroidCam (méthode utilisée par l'équipe)

Réglages → Caméra : liste les webcams disponibles, aperçu local pour vous
uniquement (pas encore diffusé publiquement).

**DroidCam, pas à pas :**

1. Installez l'app **DroidCam** sur le téléphone (Play Store / App Store).
2. Installez le **client DroidCam pour PC** (Dev47Apps, gratuit) sur
   l'ordinateur qui fait tourner ChurchOverlay — c'est l'étape que
   presque tout le monde oublie : sans ce client de bureau **lancé et
   connecté**, le téléphone n'apparaît nulle part, même si l'app est
   ouverte sur le téléphone.
3. Connectez : soit en **Wi-Fi** (le téléphone affiche une adresse IP à
   entrer dans le client DroidCam PC), soit en **USB** (câble +
   débogage USB activé sur le téléphone). Une fois connecté dans le
   client DroidCam, celui-ci crée une **webcam virtuelle** sur ce PC.
4. Dans ChurchOverlay, cliquez **🔄 Actualiser** dans le panneau Caméra —
   le téléphone apparaît dans la liste (nom du type « DroidCam Source
   2 »), sélectionnez-le et démarrez l'aperçu pour confirmer que l'image
   arrive bien.
5. Répétez sur chaque PC/téléphone si vous utilisez plusieurs caméras
   DroidCam en parallèle (un client DroidCam PC par ordinateur).

Fonctionne aussi avec :

- une caméra **NDI**, via l'outil gratuit _NDI Virtual Input_ (suite NDI
  Tools de NewTek/Vizrt) ;
- **Iriun Webcam** ou **EpocCam** — même principe que DroidCam (client de
  bureau requis, puis le téléphone apparaît comme une webcam normale).

### Caméras IP (plusieurs téléphones, sans rien installer sur ce PC)

Réglages → Caméras IP (téléphones) — la méthode recommandée pour
**3 à 5 téléphones utilisés comme caméras multi-angles** (scène, salle,
gros plan...) sans DroidCam et sans app à installer sur le téléphone.

**Méthode recommandée — scanner un QR code (nouveau, aucune app) :**

1. **Avant de générer le QR**, donnez un **nom** à cette caméra (ex.
   « Téléphone scène », « Téléphone salle ») — important si vous utilisez
   plusieurs téléphones : sans nom, ils apparaîtraient tous sous le même
   nom générique, impossibles à distinguer dans la liste. Choisissez aussi
   la **qualité** (Basse/Moyenne/Haute — Basse si le Wi-Fi de l'église est
   faible ou déjà chargé par plusieurs téléphones à la fois).
2. Cliquez **📷 Générer un QR code (téléphone, sans app)**.
3. Sur le téléphone, ouvrez l'appareil photo (ou un lecteur QR) et scannez
   le code affiché — une page s'ouvre directement dans le navigateur du
   téléphone (Chrome/Safari), rien à installer.
4. Autorisez l'accès à la caméra quand le navigateur le demande. La page
   affiche « En direct » une fois connectée. Un bouton **🔄** en haut de
   l'écran permet de basculer entre caméra avant/arrière sans re-scanner.
5. Le téléphone apparaît automatiquement dans la liste ci-dessous, avec un
   aperçu et un badge en ligne/hors ligne — comme n'importe quelle caméra
   IP. Cliquez **📋** dessus pour copier son lien à coller dans OBS.
6. **Important :** le QR n'est valable que **10 minutes** et ne fonctionne
   qu'**une seule fois** — s'il a expiré ou a déjà été scanné, régénérez-en
   un nouveau. Laissez l'écran du téléphone allumé pendant le culte (la
   page essaie de l'empêcher de se verrouiller automatiquement).
7. **Si vous retirez la caméra depuis le tableau de bord** (🗑️), le
   téléphone en est informé (« Caméra retirée ») et arrête d'envoyer des
   images tout seul — pas besoin de fermer l'onglet à la main.
8. **Condition technique :** cette méthode a besoin que le serveur
   ChurchOverlay soit accessible sur le réseau Wi-Fi de l'église (pas
   seulement en local sur ce PC) — voir `README.md` (`WS_HOST` et jetons de
   sécurité). Si ce n'est pas configuré, le bouton affiche un message clair
   plutôt qu'un QR qui ne fonctionnerait pas.

**Alternative manuelle — app « IP Webcam » déjà installée :**

1. Sur le téléphone, installez une app gratuite type **« IP Webcam »**
   (Android, par Pavel Khlebovich).
2. Connectez le téléphone au **même Wi-Fi** que le PC.
3. Ouvrez l'app, appuyez sur « Démarrer le serveur » — elle affiche une
   adresse du type `http://192.168.1.50:8080`.
4. Dans ChurchOverlay, ajoutez un nom et collez cette adresse suivie de
   `/video` (ex. `http://192.168.1.50:8080/video`).

### Habillage caméra (logo, titre) — logo et texte par-dessus la caméra (nouveau)

Réglages → Habillage caméra. ChurchOverlay ne peut pas fusionner un logo
directement dans l'image de la caméra — c'est toujours OBS qui compose les
calques. Ce que ce panneau apporte : **une seule fois** que c'est branché
dans OBS, plus jamais besoin d'y retourner pour changer un texte.

**Réglage initial (une seule fois) :**

1. Cliquez **📋 Copier le lien pour OBS** dans le panneau « Habillage
   caméra ».
2. Dans OBS, ajoutez une **nouvelle** Source Navigateur (en plus de celle
   de l'overlay versets, et en plus de votre source caméra) — collez-y ce
   lien.
3. Dans la liste des sources de la scène, faites glisser cette nouvelle
   source **au-dessus** de votre source caméra (DroidCam, caméra IP...),
   pour qu'elle s'affiche par-dessus l'image et pas dessous.

**Ensuite, à chaque culte, tout se passe dans ChurchOverlay :**

- **+ Choisir un logo** : image, **GIF animé**, ou **courte vidéo**
  (.mp4/.webm, lue en boucle silencieuse) — affiché en permanence dans le
  coin choisi (menu déroulant : haut-gauche, haut-droit, bas-gauche,
  bas-droit) et à la **taille** choisie (petit/moyen/grand, second menu
  déroulant). Réglé une fois, reste d'un culte à l'autre.
- **Titre / Sous-titre** (ex. « Pasteur Jean Dupont » / « Culte du
  dimanche ») : un bandeau en bas de l'écran, à activer avec **👁️
  Afficher sur la diffusion** au moment voulu, et masquer ensuite avec le
  même bouton. Contrairement au logo, le titre n'est PAS mémorisé d'un
  culte à l'autre — à retaper (ou laisser vide) à chaque service.

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

| Symptôme                                             | Vérifier                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aucun verset ne s'affiche                            | Micro démarré ? Badge "Capture active" ? Clé Groq configurée (écran de setup) ?                                                                                                             |
| Le verset apparaît en retard/coupé                   | Réseau lent — la détection par citation exacte est la plus rapide, privilégiez des références explicites ("Jean 3:16")                                                                      |
| Le poster principal ne réapparaît pas                | Un verset ou un autre média est peut-être encore actif à l'écran — le poster ne reprend sa place que si RIEN d'autre n'est affiché                                                          |
| "show poster X" ne déclenche rien                    | Vérifiez que le nom/la phrase déclencheuse correspond bien à ce qui est dit — la correspondance est par sous-chaîne, pas par similarité approximative                                       |
| DroidCam absent de la liste                          | Le **client DroidCam pour PC** doit être lancé ET connecté au téléphone (Wi-Fi ou USB) — l'app seule sur le téléphone ne suffit pas. Cliquez 🔄 Actualiser après connexion.                 |
| Caméra NDI absente de la liste                       | Installez/activez "NDI Virtual Input" (NDI Tools gratuit) — sans lui, une source NDI n'apparaît pas comme une webcam standard                                                               |
| Caméra de téléphone (IP) "Hors ligne"                | Le téléphone a perdu le Wi-Fi, l'app "IP Webcam" a été fermée/mise en veille, ou son adresse IP a changé — rouvrez l'app sur le téléphone et, si besoin, mettez à jour l'adresse collée     |
| "Générer un QR code" affiche une erreur              | Le serveur n'est accessible qu'en local (`WS_HOST=127.0.0.1`, le défaut) — le téléphone ne peut pas l'atteindre. Voir `README.md` pour configurer l'accès réseau et les jetons de sécurité. |
| Le téléphone scanné n'affiche rien                   | Le QR a peut-être expiré (10 min) ou a déjà été utilisé (usage unique) — régénérez-en un nouveau et scannez-le tout de suite après                                                          |
| Le téléphone affiche « Caméra retirée »              | Normal — l'opérateur a supprimé cette caméra depuis le tableau de bord. Générez un nouveau QR pour reconnecter ce téléphone.                                                                |
| Badge « En ligne » alors que le téléphone est éteint | Attendez ~15-20s : le tableau de bord revérifie périodiquement chaque flux, y compris ceux déjà marqués « En ligne » — un téléphone réellement mort finit par basculer sur « Hors ligne ».  |
| Logo/titre invisibles dans OBS                       | Vérifiez que la Source Navigateur "Habillage caméra" a bien été ajoutée dans OBS (étape unique) ET qu'elle est positionnée AU-DESSUS de la source caméra dans la liste des sources          |
| Sous-titres traduits en retard ou absents            | Normal par design (best-effort, jamais bloquant) — vérifiez simplement que le quota gratuit Groq/Gemini n'est pas épuisé par ailleurs                                                       |

Pour les détails techniques (variables d'environnement, protocole
WebSocket, architecture), voir `README.md`, `API.md` et
`ARCHITECTURE.md`.
