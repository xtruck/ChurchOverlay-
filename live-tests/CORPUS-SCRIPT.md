# Script d'enregistrement — corpus de mesure chantier 1a

45 énoncés à lire, associés ligne par ligne à `corpus.csv` (colonne `id`). Toutes les colonnes de
vérité terrain (texte attendu, référence attendue, langue, catégorie) sont déjà remplies dans le CSV —
il ne reste que `source_file`/`start_ms`/`end_ms` à compléter après enregistrement (voir §"Après
l'enregistrement" plus bas).

## Chaîne technique — obligatoire

- **Le même micro et la même carte son que l'app utilise en direct**, dans la même salle si possible
  (acoustique réelle : réverbération, bruit de fond ambiant du bâtiment). Un enregistrement au
  téléphone ou un micro différent ne mesure pas la bonne chaîne.
- Format cible : **WAV mono 16 kHz**. Si l'enregistrement se fait via OBS (vidéo), l'audio sera extrait
  ensuite — pas besoin de convertir toi-même, dis-moi juste le format de sortie réel d'OBS.
- Débit naturel, pas précipité — l'objectif est une lecture représentative d'un vrai prédicateur, pas
  une diction de test.

## Comment enregistrer — sessions groupées, pas un fichier par phrase

Certains cas (F, G) ont besoin d'un **timing réel préservé** entre deux énoncés consécutifs — ne les
enregistre donc PAS comme des fichiers séparés. Enregistre par **blocs continus** (un fichier par
bloc ci-dessous), avec une pause naturelle de 2-3 secondes entre deux énoncés d'un même bloc SAUF
mention contraire (F, G, où le timing exact est précisé).

---

### Bloc 1 — Formulations et livres numérotés (fr) — IDs A1-A5, C1-C3

Lis chaque ligne séparément, pause de 2-3s entre chaque :

1. **A1** — « Jean 3.16 »
2. **A2** — « Jean chapitre 3 verset 16 »
3. **A3** — « Jean trois seize »
4. **A4** — « Saint Jean 3.16 »
5. **A5** — « L'Évangile selon Jean, chapitre 3, verset 16 »
6. **C1** — « Premier Corinthiens chapitre 13 verset 4 »
7. **C2** — « Deuxième Timothée chapitre 3 verset 16 »
8. **C3** — « Première Jean chapitre 4 verset 8 »

### Bloc 2 — Anglais (en) — IDs B1-B2

9. **B1** — « John 3:16 »
10. **B2** — « The gospel of John, chapter three, verse sixteen »

### Bloc 3 — Livres difficiles à transcrire (fr) — IDs D1-D7, N1-N4

11. **D1** — « Habacuc chapitre 2 verset 4 »
12. **D2** — « Ecclésiaste chapitre 3 verset 1 »
13. **D3** — « Philémon verset 6 »
14. **D4** — « Aggée chapitre 1 verset 5 »
15. **D5** — « Sophonie chapitre 3 verset 17 »
16. **D6** — « Apocalypse chapitre 21 verset 4 »
17. **D7** — « Deutéronome chapitre 6 verset 5 »
18. **N1** — « Néhémie chapitre 8 verset 10 »
19. **N2** — « Osée chapitre 6 verset 6 »
20. **N3** — « Colossiens chapitre 3 verset 23 »
21. **N4** — « Jacques chapitre 1 verset 5 »

### Bloc 4 — Nombres pièges (fr) — IDs E1-E3

22. **E1** — « Psaume 119 verset 105 »
23. **E2** — « Nombres chapitre 6 verset 24 »
24. **E3** — « Genèse 1.1 »

### Bloc 5 — Rafale, moins de 5 secondes d'écart (fr) — IDs F1-F2

**Timing précis requis** : lis F1, attends **moins de 5 secondes** (pas de silence long), puis lis F2
immédiatement à la suite. C'est le cas qui teste `minFlushIntervalMs` — le but est de reproduire un
prédicateur qui enchaîne deux références coup sur coup.

25. **F1** — « Romains 8.28 »
    _(moins de 5 secondes de silence)_
26. **F2** — « Romains 12.2 »

### Bloc 6 — Doublon à 10 secondes (fr) — IDs G1-G2

**Timing précis requis** : lis G1, attends **environ 10 secondes** (tu peux combler avec une phrase
neutre du type « Regardons ensemble ce que cela signifie pour nous » pour rester naturel), puis répète
G2 à l'identique. Teste `DEDUP_MS` (fenêtre de 30s) — le but est de reproduire un prédicateur qui
annonce une référence puis la reprend en la développant.

27. **G1** — « Jean 14.6 »
    _(~10 secondes, éventuellement comblées par une phrase neutre)_
28. **G2** — « Jean 14.6 »

### Bloc 7 — Changement de langue en pleine phrase — IDs H1-H2

Ne marque **aucune** pause à l'endroit du changement de langue — l'enchaînement doit être fluide,
dans la même phrase.

29. **H1** — « Comme il est écrit in the book of Romans, chapter eight »
30. **H2** — « Let us turn to Matthieu chapitre 5 »

### Bloc 8 — Référence noyée dans une phrase longue — IDs I1-I2

31. **I1** (fr) — « Alors que nous traversons des moments difficiles, je pense à ce que dit
    Philippiens 4.13, qui nous encourage à tenir bon »
32. **I2** (en) — « In these uncertain times, remember what Isaiah 41:10 tells us about not being
    afraid »

### Bloc 9 — Citation sans énoncer la référence — IDs J1-J3

Lis SEULEMENT le texte biblique, sans jamais dire « Jean 3.16 » ou « Psaume 23 » à voix haute.

33. **J1** (fr) — « Car Dieu a tant aimé le monde qu'il a donné son Fils unique »
34. **J2** (fr) — « L'Éternel est mon berger, je ne manquerai de rien »
35. **J3** (en) — « For God so loved the world that he gave his only Son »

### Bloc 10 — Avec bruit de fond réaliste — IDs K1-K5

Enregistre ces 5 lignes avec, respectivement : musique douce en fond (K1, K3), rumeur d'assemblée —
quelques personnes qui parlent doucement, bruits de sièges (K2, K4), bruit de ventilation/climatisation
(K5). Si tu ne peux reproduire qu'un seul type de bruit de fond, utilise-le pour les 5 — c'est déjà
utile.

36. **K1** — « Marc 16.15 » _(musique douce)_
37. **K2** — « Luc 2.11 » _(rumeur d'assemblée)_
38. **K3** — « Actes 2.38 » _(musique douce)_
39. **K4** — « Éphésiens 2.8 » _(rumeur d'assemblée)_
40. **K5** — « Ésaïe 53.5 » _(ventilation/climatisation)_

### Bloc 11 — Contrôle négatif, aucune référence — IDs L1-L3

41. **L1** (fr) — « Bonjour à tous, merci d'être venus ce matin »
42. **L2** (fr) — « N'oubliez pas la collecte spéciale prévue ce dimanche »
43. **L3** (en) — « Let's stand together and worship the Lord »

### Bloc 12 — Pièges pour les commandes vocales — IDs M1-M2

44. **M1** (fr) — « Répétez après moi : Dieu est amour »
45. **M2** (fr) — « Nous allons répéter ce chant une fois de plus »

---

## Après l'enregistrement

Pour chaque bloc, tu obtiens un fichier audio (WAV ou vidéo). Remplis dans `corpus.csv`, pour chaque
`id` :

- **`source_file`** : le nom du fichier du bloc correspondant (ex. `bloc1.wav`), déposé dans
  `live-tests/samples/`.
- **`start_ms`** / **`end_ms`** : l'horodatage de début et de fin de CET énoncé précis dans le
  fichier, en millisecondes (ex. l'énoncé A2 commence à 4200ms et finit à 6100ms dans `bloc1.wav`).
  Un éditeur audio gratuit (Audacity) affiche ces horodatages directement en pointant la souris sur la
  forme d'onde — pas besoin de précision à la milliseconde près, une marge de ~200ms avant/après
  l'énoncé est même préférable (laisse un peu de contexte silencieux, comme un vrai micro en
  continu).

Tu n'as pas besoin de me renvoyer les fichiers un par un : dépose-les dans `live-tests/samples/`,
complète les 3 colonnes dans `corpus.csv`, et dis-le-moi — je lance `corpus-bench.js` dessus.
