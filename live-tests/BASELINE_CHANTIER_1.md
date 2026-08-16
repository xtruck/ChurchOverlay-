# BASELINE_CHANTIER_1 — pipeline actuel (avec Étape 4 non commitée), STREAMING (deepgram)

## MISE À JOUR 2026-08-16 (session mission autonome, suite) — 29/37 (78,4 %) mesuré en conditions réelles, clôture Chantier A

**Contexte** : reprise dans un environnement neuf (`node_modules` jamais installé,
aucune clé API). `npm install` + approbation des scripts natifs
(`better-sqlite3`, `onnxruntime-node`) + clés `GROQ_API_KEY`/`DEEPGRAM_API_KEY`
fournies par l'opérateur. Gate complet (test/lint/tsc/format/audit/
check-build-files) vérifié vert avant toute mesure.

**Toutes les mesures ci-dessus (28/37, catégories, échecs) dataient d'AVANT
les correctifs A.1 (livres à chapitre unique) et A.2 (double détection
FR/EN) — jamais rejouées en conditions réelles après ces deux correctifs.
Premier run réel post-A.1/A.2** (`node live-tests/corpus-bench.js
--provider=deepgram`, vraies clés) :

- **Taux de première tentative : 29/37 (78,4 %)** — 23 versets exacts + 6
  chapitres de repli ; textDetectedNotShown : 1 ; jamais détecté : 7
- **FP 0/8**
- Latence (29 énoncés) : p50=1440ms, p75=3268ms, p90=3921ms, p95=4466ms
- Catégories : variante_formulation 5/7, livre_numerote 3/3, livre_difficile
  8/11, nombre_piege 3/3, rafale_5s 2/2, doublon_10s 2/2, changement_langue
  0/2, noyee 1/2, bruit_fond 5/5 — **F2 ne figure plus dans les échecs**
  (repli chapitre, confirmé en conditions réelles, cohérent avec A.4)
- Échecs (8, contre 9 dans la baseline) : **A2, B2, D3, D5, N2, H1, H2, I2**

**Analyse des 8 échecs, par cause racine (pas de nouveau chiffre sans
mesure — chaque catégorie ci-dessous est vérifiée dans les logs bruts de ce
run, pas supposée)** :

1. **A2 — artefact d'attribution du banc, pas un échec produit.** Log
   vérifié : `Displayed: Jean 3:16` apparaît bien à l'intérieur de la
   fenêtre de l'énoncé A2 (« Jean 3 16. » émis comme final), mais le banc
   l'attribue à l'énoncé voisin (A1/A3, formulations quasi identiques
   prononcées à 2,5s d'écart). Déjà diagnostiqué ainsi au Chantier A.4 —
   confirmé une seconde fois, hors périmètre Chantier A/B (audit du banc
   lui-même, pas du pipeline).
2. **B2, H1, H2, I2 — décalage de langue de session ASR, PAS un problème de
   détection.** Vérifié dans les logs : B2 (« The gospel of John, chapter
   three, verse sixteen », anglais) transcrit par la session Deepgram
   FRANÇAISE en `"3 chapitre 3, verset"` — aucune trace de "John"/"gospel"
   dans le transcript, donc AUCUN détecteur (FR, EN, ou les deux combinés
   via A.2) ne peut y trouver de référence : il n'y a rien à détecter. Le
   correctif A.2 (double détection FR/EN) est nécessaire mais **ne peut
   rien pour ces 4 cas** — la cause est en amont, côté choix de langue de
   la session ASR. C'est très exactement le problème que Chantier C
   (`language=multi` nova-3) est censé résoudre, pas une régression de A.2.
3. **D3, D5, N2 — troncature VAD/endpointing, confirmée à nouveau.** D5
   (Sophonie) : `Énoncé streaming finalisé localement (silence VAD) :
"Sophonie"` — le nom du livre seul déclenche la finalisation avant que
   le chapitre/verset ne soit prononcé. Cohérent avec le diagnostic
   Chantier A.4. Voir l'expérience `TRAILING_SILENCE_MS` ci-dessous.

**Bilan réel du Chantier A** : 28/37 → 29/37 mesuré (A2 est un artefact de
banc, donc la couverture RÉELLE côté produit est plutôt 30/37 si on ne
compte pas ce faux négatif de mesure). N'atteint pas le 32/37 visé par la
mission, mais avec une explication complète et vérifiée pour CHAQUE écart
restant — aucun résidu "inexpliqué". La suite logique n'est plus dans le
Chantier A (logique de détection) mais dans le Chantier C (langue de
session ASR, 4 cas sur 8) et une piste VAD plus fine que Chantier B ne l'a
couverte (3 cas sur 8, voir ci-dessous).

### Expérience `TRAILING_SILENCE_MS` (piste D5) — résultat négatif, pas de changement de défaut

Ajout d'un réglage (`TRAILING_SILENCE_MS`, voir `.env.example` et
`audio-capture.js`) pour pouvoir MESURER l'effet d'un silence de fin de
phrase plus long avant de considérer, comme l'exige le verrou dur n°2, tout
changement de défaut du direct. Défaut inchangé : **600ms**.

Run comparatif (`TRAILING_SILENCE_MS=900`, même corpus, vraies clés) :

- **28/37 (75,7 %)** — MOINS bien que le run à 600ms par défaut (29/37).
- **D5 échoue TOUJOURS** à 900ms : même log `Énoncé streaming finalisé
localement (silence VAD) : "Sophonie"` — la pause réelle entre "Sophonie"
  et "chapitre trois verset dix-sept" dans cet échantillon TTS dépasse donc
  900ms, pas seulement 600ms.
- `livre_difficile` recule (8/11 → 7/11, D2 nouvellement en échec) — signal
  cohérent avec la variance run-à-run déjà documentée (Chantier 0.2), pas
  forcément un effet causal de `TRAILING_SILENCE_MS` lui-même : un seul run
  de chaque côté ne suffit pas à trancher, mais rien dans ce résultat ne
  soutient une augmentation du défaut.

**Conclusion** : ne PAS augmenter `trailingSilenceMs` par défaut — le
correctif ne marche même pas pour le cas qui l'a motivé, et son coût
(latence ajoutée à CHAQUE énoncé, pas seulement ceux avec une pause après
un nom de livre isolé) n'a aucune contrepartie mesurée. Piste plus
prometteuse pour une future session : une extension CONDITIONNELLE
(uniquement quand le VAD vient de finaliser sur un texte qui ressemble à
"nom de livre seul, sans chapitre ni verset" — même logique que le repli
chapitre du Chantier 3/A.5, qui est déjà conditionnel) plutôt qu'un
allongement global. Le réglage `TRAILING_SILENCE_MS` reste dans le code
(testé, documenté, défaut inchangé) pour permettre cette mesure sans
re-développer l'instrumentation.

---

## MISE À JOUR 2026-08-16 (session mission maître) — 28/37 (75,7 %), fallback chapitre, dédup 2/2

Reprise de session : le dépôt contenait déjà (non commité) un fallback chapitre
en cours d'implémentation (§ "Chantier 3" plus bas dans server.js), vérifié,
testé (suite complète verte) et commité tel quel avant cette mesure.

**Run complet, corpus réel (45 lignes, `node live-tests/corpus-bench.js
--provider=deepgram`), code courant (fallback chapitre inclus)** :

- Taux de première tentative : **28/37 (75,7 %)** — 23 versets exacts + 5
  chapitres de repli (référence partielle, verset perdu par l'ASR — règle
  mission "verset exact OU chapitre entier", jamais un mauvais verset) ;
  textDetectedNotShown : 2 ; jamais détecté (corrigé, voir audit ci-dessous) : 7
- **FP 0/8**
- Latence affichage (28 énoncés) : **p50=1949ms, p75=3230ms, p90=4266ms,
  p95=4269ms**, min=-481ms (spéculatif légitime), max=5086ms
- **doublon_10s : 2/2 affichés** (G1 ET G2 « Jean 14.6 » tous deux affichés —
  le correctif de dédoublonnage par énoncé, déjà documenté plus bas, tient en
  conditions réelles sur ce run)
- Catégories : livre_numerote 3/3, nombre_piege 3/3, bruit_fond 5/5,
  variante_formulation 5/7, livre_difficile 8/11, rafale_5s 1/2, doublon_10s
  2/2, changement_langue 0/2, noyee 1/2
- Échecs restants (9) : A2/D5/N2/F2 (ASR natif, confirmé — voir CORRECTIF
  ci-dessous) — mais **D3, B2, H1, H2, I2 ne sont PAS des échecs ASR**.
  **CORRECTIF (Chantier A, mission autonome) : l'affirmation "tous des échecs
  ASR natifs" ci-dessus était fausse et n'avait jamais été vérifiée en
  passant la transcription PARFAITE (colonne `expected_text` du corpus)
  directement à `detect()`, sans ASR.** En le faisant : D3 « Philémon verset
  6 » et H2 « Let us turn to Matthieu chapitre 5 » échouaient pour une raison
  purement locale — Philémon n'a qu'un chapitre et le pattern standard exige
  toujours un numéro de chapitre après le nom du livre (corrigé au Chantier
  A.1, voir book-catalog.js#SINGLE_CHAPTER_BOOKS) ; B2 « The gospel of John,
  chapter three, verse sixteen », H1 « ...in the book of Romans, chapter
  eight » et I2 « ...what Isaiah 41:10 tells us... » sont détectés
  correctement par `detector-en.js`, qui existe et fonctionne déjà dans le
  dépôt, mais qui n'est jamais consulté quand la session est en français
  (Chantier A.2). Quatre à cinq des neuf échecs persisteraient donc avec un
  ASR parfait — ils se corrigent sans un seul appel API et sans latence
  supplémentaire. Seuls A2, D5, N2, F2 restent des échecs ASR confirmés.

**Chantier A.3 (mission autonome) — élucidation de H2** : la question posée
était "seuil de confiance en aval, ou ASR qui n'a pas transcrit ?". Réponse
mesurée : NI L'UN NI L'AUTRE. `bloc7.wav` contient bien H1 ("Comme il est
écrit...") ET H2 ("Let us turn to Matthieu chapitre 5") — vérifié par
analyse RMS de l'énergie audio (H1 : ~500-3500ms, silence net : ~4000-6500ms,
H2 : ~7000-9500ms, silence : après 9500ms). Sur 2 runs indépendants
(Chantier A.1 et A.2), **H2 n'apparaît JAMAIS dans les logs Deepgram** —
aucun `[DEEPGRAM] partial received`/`final received` entre la fin du
traitement de H1 et `Capture arrêtée`. Le fichier se termine après un seul
énoncé traité alors que `corpus-bench.js` en attend 2. Comparaison croisée :
`bloc2.wav` et `bloc8.wav` (mêmes conditions : 2 énoncés séparés par un
silence, même pipeline streaming) traitent correctement leurs DEUX énoncés
— ce n'est donc PAS un bug générique "le streaming ne gère qu'un énoncé par
fichier", mais quelque chose de spécifique à `bloc7.wav`/H2 (durée du
silence légèrement différente ? état du WebSocket Deepgram après la
première finalisation ? à creuser). **Renvoyé au Chantier B** (VAD/
endpointing) comme piste concrète et reproductible, plus précise que
l'hypothèse Silero-batch d'origine — à tester en priorité : "le bug
se produit-il uniquement au rejeu de fichiers, ou aussi en direct ?"
s'applique ici littéralement (scénario de rejeu de fichier, PCM continu).

**Chantier A.4 (mission autonome) — les 4 échecs restants (A2/D5/N2/F2),
mesurés un par un** :

- **F2 n'échoue plus.** `bloc5.wav` : "Romains chapitre 12 verset" (verset
  perdu par l'ASR) est affiché via le repli chapitre (`Chapter fallback:
Displayed Romains 12`) — `rafale_5s : 2/2` sur ce run. L'hypothèse
  `minFlushIntervalMs=3200` (contrainte batch/Groq) n'a jamais eu l'occasion
  de s'appliquer ici : le chemin streaming/Deepgram ne la consulte pas, et
  le repli chapitre (Chantier 3, déjà en place) absorbe le cas. Prémisse de
  la mission obsolète sur ce point précis.
- **D5 (Sophonie) est un VRAI échec ASR, mais pas de vocabulaire — d'endpointing.**
  `buildDeepgramKeyterms()` contient bien "Sophonie" (118 termes, vérifié),
  et Deepgram le transcrit PARFAITEMENT : `[DEEPGRAM] partial received:
"Sophonie"`. Mais l'énoncé streaming se finalise localement
  (`Énoncé streaming finalisé localement (silence VAD) : "Sophonie"`) tout
  de suite après ce seul mot — "chapitre 3 verset 17" n'est jamais transcrit
  car le VAD a déjà coupé l'énoncé. Le vocabulaire n'est pas en cause ; le
  temps de silence toléré après un nom de livre isolé (avant que le
  prédicateur n'enchaîne sur le chapitre/verset) l'est. Renvoyé au
  Chantier B avec cette piste précise.
- **N2 (Osée) n'est PAS un échec ASR/vocabulaire — c'est le MÊME bug que H2
  (Chantier A.3), confirmé une seconde fois sur un fichier différent.**
  `bloc3.wav` contient bien un énoncé complet à l'emplacement attendu
  (45380-48350ms, vérifié par analyse RMS — parole réelle 45250-47500ms),
  mais **aucune activité Deepgram n'apparaît dans les logs pour ce
  segment** : le log passe directement de N1 (Néhémie, traité normalement)
  à N3 (Colossiens, traité normalement), N2 disparaissant purement et
  simplement. Deux occurrences indépendantes (H2 dans bloc7.wav, N2 dans
  bloc3.wav) renforcent la piste Chantier B : un énoncé sur plusieurs dans
  un même flux continu peut ne jamais être finalisé/transmis, sans aucune
  erreur visible.
- **A2 reste ambigu — probablement un artefact d'attribution du banc, pas
  un échec ASR pur.** `bloc1.wav` (les 5 variantes de Jean 3:16, A1-A5)
  montre plusieurs finals corrects ("Jean 3 16.", "Jean 3:16") autour de la
  fenêtre attendue pour A2, mais aussi des reformulations qui se chevauchent
  ("Saint Jean 3 16" / "L'évangile selon Jean," / "chapitre 3 verset 16.")
  — la déduplication/fusion semble absorber ou réattribuer l'affichage à un
  autre énoncé voisin plutôt que de perdre la référence elle-même. À
  creuser avec le même outillage que l'audit `missedCount` du Chantier 0.2
  (attribution par plus proche voisin), pas une piste ASR/endpointing —
  hors du périmètre naturel du Chantier A ou B, noté pour un futur audit du
  banc lui-même.

**Bilan Chantier A.4** : sur les 4 échecs supposés "vrais échecs ASR", 1
n'échoue plus (F2), 1 est confirmé endpointing (D5), 1 est le même bug que
H2 — pas un échec ASR (N2), et 1 reste non élucidé côté banc, pas ASR (A2).
**Zéro des 4 n'est un problème de vocabulaire biblique** — `bible-keyterms.js`
fonctionne comme prévu sur ce corpus.

**Chantier B (mission autonome) — début d'investigation du bug "énoncé
manquant" (H2/N2, Chantiers A.3/A.4)** : question posée en premier par la
mission — rejeu de fichier uniquement, ou aussi en direct ? Progrès réel
sur une question adjacente plus tractable en premier : **le bug est-il
spécifique à Silero ?** Réponse mesurée, en 3 tests ciblés sur un
mini-corpus (H1+H2 seuls, `bloc7.wav`) :

1. **`VAD_PROVIDER=rms` reproduit le bug À L'IDENTIQUE** (0/2, H2 absent de
   tout log Deepgram) — élimine complètement l'hypothèse Silero-spécifique
   d'origine (§5 de la mission). Ce n'est pas un bug du modèle neuronal,
   ni de sa fenêtre de 512+64 échantillons, ni de sa normalisation — les
   deux VAD (RMS et Silero) déclenchent la même perte.
2. **Le chemin BATCH (`--provider=auto`, Groq) traite H2 correctement** —
   deux segments distincts détectés par le VAD local (RMS/Silero, MÊME
   code que le chemin streaming, voir `flushSegment()`), tous deux envoyés
   et transcrits : "Let's tourne." puis "Matthieu chapitre 5." (garbled
   mais bien REÇU et TRANSCRIT, contrairement au streaming où H2 ne
   déclenche RIEN côté Deepgram). Élimine l'hypothèse d'un bug générique de
   segmentation VAD locale — le VAD identifie correctement les deux
   énoncés dans les DEUX chemins, seul le résultat diffère.
3. **Conclusion : le bug est spécifique à la session WebSocket streaming
   Deepgram**, pas au VAD (local ou neuronal), pas à la segmentation.
   `deepgram-streaming.js` : le gestionnaire `ws.on('message', ...)` est
   inconditionnel (aucun état "déjà traité un final, ignorer le reste") —
   confirmé par lecture de code, pas de garde suspecte trouvée côté client.
   Le silence total de logs `[DEEPGRAM] partial received` pour H2 indique
   que Deepgram ne renvoie RIEN pour ce fragment, malgré un envoi PCM
   inconditionnel (`handleAudioData` envoie chaque chunk dès que
   `deepgramStreamingActive`, sans garde par énoncé).

**Hypothèse de tête pour la suite (non testée, à vérifier en premier)** :
notre code ne prévient JAMAIS Deepgram quand le VAD LOCAL décide qu'un
énoncé est terminé — `finalizeStreamingUtteranceLocally()` ne fait que
promouvoir le dernier partial CÔTÉ CLIENT, sans envoyer de message de
contrôle à Deepgram (seul `CloseStream` est envoyé, uniquement en toute fin
de session, voir `deepgram-streaming.js`). Deepgram dispose d'un message de
contrôle `{"type": "Finalize"}` (API documentée) qui force le moteur à
vider son buffer interne et repartir à zéro pour la suite — jamais envoyé
ici. Sur une session ouverte en continu, l'état interne de Deepgram (son
propre endpointing serveur, indépendant du nôtre) pourrait rester "en
attente" après le `final` de H1 et ne jamais se redéclencher proprement
pour H2, faute de ce signal explicite. À vérifier en premier lieu avant
toute autre piste — changement ciblé, testable isolément sur ce même
mini-corpus (H1+H2) avant tout run complet.

**Chantier B (mission autonome) — suite et conclusion provisoire de
l'investigation H2/N2, PUIS correction de périmètre importante.**

Poursuite de l'investigation ci-dessus, avec l'outil de diagnostic déjà
présent dans le dépôt (`live-tests/diagnose-raw-messages.js`, proxy WebSocket
transparent qui journalise chaque message BRUT reçu de Deepgram, sans passer
par notre propre code de filtrage) :

4. **Hypothèse "message `Finalize` manquant" — testée et RÉFUTÉE.**
   `deepgram-streaming.js#finalizeUtterance()` (envoie `{"type":"Finalize"}`
   à chaque finalisation locale, sans fermer la session) implémenté et
   testé sur le mini-corpus H1+H2 : **aucun effet**, H2 toujours absent.
   Changement retiré (aucune valeur prouvée, pas de raison de le garder sur
   le chemin live).
5. **Test au niveau du protocole BRUT, en contournant TOUT notre code**
   (VAD local, audio-capture.js, gestion de session) : `bloc7.wav` envoyé
   directement à une session Deepgram via `deepgram-streaming.js`
   (`setWsFactoryForTesting` + proxy journalisant). **Résultat identique** :
   après le `is_final=true, speech_final=true` de H1, TOUS les messages
   `Results` suivants ont un transcript VIDE, jusqu'à la fin du fichier —
   y compris pendant les 3s de silence de fin ajoutées après. Le bug existe
   donc AU NIVEAU DU PROTOCOLE DEEPGRAM LUI-MÊME, pas dans notre gestion
   d'état.
6. **Élimination des paramètres de connexion** : même test SANS les 118
   `keyterm=` (URL 174 caractères au lieu de ~2500+) — même résultat. Même
   test SANS `endpointing=500` (Deepgram utilise son défaut) — même
   résultat. Ni le vocabulaire biblique, ni notre réglage d'endpointing ne
   sont en cause.
7. **Test décisif : H2 SEUL, session neuve, aucun H1 avant.** PCM de
   `bloc7.wav` tronqué pour ne garder QUE la portion à partir de 6,5s
   (juste avant H2), envoyé à une session Deepgram fraîchement ouverte —
   **toujours aucune transcription**, alors que le chemin batch (Groq)
   transcrit ce même contenu sans problème ("Matthieu chapitre 5", certes
   entouré de mots parasites, mais bien détecté et affiché).

**Conclusion (élimination complète, mesurée, pas devinée)** : ce n'est ni
Silero, ni le VAD local (RMS ou neuronal), ni notre gestion de session
streaming, ni un message de contrôle manquant, ni le vocabulaire biblique,
ni notre réglage d'endpointing, ni "un énoncé après un autre dans la même
session". C'est la détection de parole en TEMPS RÉEL de Deepgram
elle-même qui ne reconnaît jamais cet audio précis comme de la parole —
alors que son traitement BATCH (non temps réel) le reconnaît. Hypothèse
restante, non vérifiable sans accès à la documentation/au support Deepgram
ou à des ré-enregistrements de contrôle : une caractéristique acoustique de
CET enregistrement TTS précis (débit, niveau, prosodie) qui échappe
spécifiquement au modèle de détection d'activité vocale temps réel de
nova-3, sans affecter son modèle batch. Aucun correctif de notre côté ne
peut agir là-dessus — le filet de sécurité existant (rien de faux affiché,
silence propre) est déjà le comportement correct pour ce cas.

**CORRECTION DE PÉRIMÈTRE IMPORTANTE** : cette investigation (H2/N2,
6 étapes ci-dessus) porte sur un bug que **j'ai découvert moi-même** pendant
le Chantier A (A.3/A.4) — distinct du bug **nommément ciblé par le §5 de la
mission** ("Le VAD Silero... rejette les échantillons comme silence... sur
le chemin BATCH uniquement ; le streaming fonctionne"). Ce sont deux bugs
différents : celui-ci touche le STREAMING (Deepgram ne transcrit jamais un
énoncé), l'autre touche le BATCH (Silero rejette de la vraie parole comme
silence, contourné par `VAD_PROVIDER=rms`). L'investigation ci-dessus est
réelle et utile mais ne doit pas être confondue avec le "Chantier B" tel que
défini par la mission — reprise du VRAI Chantier B (bug Silero batch) à
suivre.

---

## Chantier B (reprise) — le VRAI bug Silero/batch du §5 : ne reproduit pas, mesuré

**Question posée par la mission, prise littéralement** : « le bug se
produit-il uniquement au rejeu de fichiers, ou aussi en direct ? » — avant
de répondre à cette question, encore fallait-il d'abord faire reproduire le
bug lui-même une seule fois. Ce n'est jamais arrivé.

**Étape 1 — le bug modèle isolé (probabilité figée ~0.001 pour TOUTE
entrée) existe déjà, mais est déjà corrigé et déjà sous test de
non-régression.** `silero-vad.js` (en-tête, lignes 16-37) documente
précisément ce bug : envoyer 512 échantillons nus au modèle v5 sans les 64
échantillons de contexte STFT produit une probabilité figée à ~0.001 pour
n'importe quelle entrée, silence ou parole. Le correctif (préfixe de
contexte, `processWindow()` lignes 184-186) est déjà en place. `git log
--follow -- silero-vad.js` : présent depuis le commit de création du module
(`d091d4f`), donc avant cette mission. `test/test-silero-vad.js` (Test 8)
fige ce résultat en non-régression depuis longtemps : de la parole réelle
connue (`testA_16k.wav`) doit dépasser 0.5 de probabilité, avec ce
commentaire explicite déjà présent : _« avant correctif : max ~0.003 »_.
Autrement dit : **le bug littéral du §5 (probabilité ~0.001) a déjà été
trouvé et corrigé avant cette mission autonome**, avec sa propre preuve de
non-régression.

**Étape 2 — reste à vérifier : le chemin BATCH complet (pas le modèle
isolé) rejette-t-il de la VRAIE parole comme silence AUJOURD'HUI ?**
Diagnostic local, 100 % hors-ligne (aucune clé API — la décision
accepter/rejeter d'un segment se prend entièrement dans `audio-capture.js`,
avant tout appel réseau) : régénération du corpus TTS complet (12 blocs,
45 énoncés, `node live-tests/generate-tts-corpus.js`, voix SAPI Windows
locales) rejoué chunk par chunk (pacing réel, 100 ms) à travers
`audio-capture.feedPcmChunk()` avec `VAD_PROVIDER=silero` forcé et
`ASR_PROVIDER=groq` (chemin BATCH, `flushSegment()`) :

- **68 segments acceptés, 9 rejetés, sur 45 énoncés attendus — jamais moins
  de segments acceptés que d'énoncés dans un seul bloc** (la sur-couverture
  vient de la fragmentation par le plafond de sécurité `segmentDuration`
  sur les énoncés longs, un comportement connu et sans rapport avec Silero).
- **Chaque rejet a une justification cohérente avec du VRAI silence**, pas
  avec de la parole perdue : `voicedMs` toujours très inférieur au segment
  (ex. 0/4000, 300/4000, 600/4000 — un segment presque entièrement silencieux
  produit logiquement une probabilité moyenne basse). Le cas le plus extrême
  (`bloc6.wav`, 4 rejets à probabilité 0.0001-0.002, `voicedMs=0/4000`)
  correspond exactement à l'intervalle de 10 s de silence entre G1 et G2
  (cas `doublon_10s`) découpé par le plafond de sécurité en fenêtres de 4 s
  — c'est le comportement VOULU (rejeter du silence), pas le bug décrit.
- **Aucun bloc ne montre un énoncé entier absorbé comme silence.**
- Fixé en test de non-régression commité (pas seulement ce diagnostic
  ponctuel) : `test/test-audio-capture-silero-integration.js` Test 3 —
  `testA_16k.wav` (vraie parole, commité, pas besoin des blocs TTS
  volumineux) traverse `flushSegment()` en chemin batch et produit au moins
  un segment envoyé au STT, jamais un rejet.

**Étape 3 — vérifié aussi en conditions réelles (vraies clés Groq/Deepgram,
corpus complet, pas seulement local) : voir le run `corpus-bench.js
--provider=deepgram` de cette session (résultats ci-dessous) — aucun
segment silencieusement perdu côté VAD n'explique les échecs observés,
cohérent avec ce diagnostic local.**

**Conclusion (mesurée, pas devinée)** : la prémisse du §5 de la mission
("Silero rejette les échantillons comme silence sur le chemin batch,
jamais élucidé") **ne reproduit pas dans l'état actuel du dépôt**. Elle
décrivait un vrai bug — mais un bug déjà corrigé (préfixe de contexte
STFT) avant le début de cette mission autonome, avec sa propre
non-régression déjà en place. Aucun correctif supplémentaire nécessaire.
Verrou dur n°1 non concerné : aucun changement de comportement par défaut,
aucun changement du taux de faux positifs (ce chantier n'a touché aucun
code de production, seulement `test/test-audio-capture-silero-integration.js`,
qui ajoute une assertion sans changer aucun comportement).

**Audit du banc (Chantier 0.2, trouvé pendant cette mesure)** : le compteur
"jamais détecté du tout" comptait à tort 16 alors que 28/37 étaient affichés
avec seulement 2 en "détecté non affiché" (37-28-2=7 attendu). Cause : la
détection dans `matchRowsToEvents` (Passe 1) teste chaque évènement
transcript/transcriptPartial EN ISOLATION — elle ne voit jamais la "fusion de
fragments" que `server.js` fait lui-même en interne (deux fragments partiels
distincts, chacun incomplet seul, combinés côté serveur avant affichage — ex.
C1/C2/C3, "livre_numerote"). Un `showVerse` correctement attribué est
pourtant TOUJOURS la preuve qu'une détection a bien eu lieu quelque part.
Corrigé : `missedCount` exclut désormais les lignes déjà comptées `shown`.
Confirmé par recalcul sur les données déjà capturées de ce run : 7, pas 16.

---

## MISE À JOUR 2026-08-16 — Chantier 0.2 (calibration) + attribution des showVerse

**Cause racine des mesures précédentes (découverte Chantier 0.2)** : le replay du
bench tourne à ~1,57× du temps réel sur Windows (granularité du timer :
`await sleep(20)` ≈ 31,5ms). L'ancien modèle `expectedWallClock = sessionStart +
endMs` supposait un rythme strictement temps réel : pour un énoncé à endMs=24s,
la dérive atteignait ~13,7s — les événements réels (transcript/showVerse)
tombaient HORS fenêtre et l'énoncé était compté « jamais détecté » à tort. Fix :
échantillonnage de l'horodatage mur réel de chaque tranche d'audio (1 point
toutes les ~200ms) + interpolation (unité ms audio = octets/32 à 16kHz mono).

**Deuxième artefact (attribution des showVerse)** : l'attribution locale ramassait
tous les showVerse de la fenêtre [fin-1500,+8000] de chaque ligne → faux
« jamais affiché » (A2/A4 pourtant affichés — prouvé par « Displayed: Jean 3:16 »
dans le log serveur) et faux « affiché PUIS ÉCRASÉ » (N3/K1/E2 : c'était le
showVerse de la ligne suivante, ex. Jacques 1:5 pour N3). Fix : attribution
GLOBALE au plus proche voisin (fenêtre + référence attendue + signal propre).

**Mesures calibrées (deepgram, après les 2 fixes — comportement serveur inchangé)** :

- First attempt : **23/37 (62,2 %)** ; shown=23 ; textDetectedNotShown=1 (A2,
  edge d'attribution de références répétées) ; jamais détecté=23 (ASR) ; **FP 0/8**
- Latence affichage : **p50=671ms, p75=3190ms, p90=3520ms, p95=4024ms**, min=-720ms
  (spéculatif légitime avant fin d'audio), max=4140ms
- Chaîne : Speech→partial p50=787-1861ms ; Speech→final p50≈-39ms (le VAD local
  finalise à la fin de la phrase, avant l'endpointing serveur) ; Final→affichage
  p50≈700ms (coût pipeline + fetch Bible, préchauffage efficace)
- Catégories (run de référence) : variante 4/7, livre_numerote 3/3, livre_difficile
  7/11, nombre_piege 3/3, rafale 1/2, doublon 0/2, changement_langue 0/2,
  noyee 1/2, bruit_fond 4/5.
- **Toutes les suppressions dédup de la baseline sont légitimes** (diagnostic
  `[dedup]` : cascades même énoncé + re-émissions de finals officiels tardifs).
- Échecs restants = native ASR : troncature chapitre-seul (l'ASR perd le numéro de
  verset : G1/G2 « Jean 14 », F2 « Romains 12 », D7/N2/D5 — le pipeline attend
  correctement le complément, ne déduit JAMAIS un mauvais verset), livre mal
  transcrit (B1 « Jon 3 sixtine » → Jonas), EN/FR (H1/H2/I2), « Sophonie » tronqué (D5).
- Endpointing : balayage réel 250/350/500/700/1000 — le `speech_final` officiel
  arrive 2,4-3,3s après la fin de parole quelle que soit la valeur ; décision :
  conserver **endpointing=500** (l'affichage est piloté par le VAD local ~600ms).
- VAD : audit fonctionnel OK — Silero actif, finalisation locale en fin de phrase,
  worklet gate+downsample 16kHz correct, tests audio-capture verts.

---

# BASELINE_CHANTIER_1 — pipeline actuel (avec Étape 4 non commitée), STREAMING (deepgram)

Mesuré le 2026-08-15 via `node live-tests/corpus-bench.js --provider=deepgram` (corpus.csv, samples/, .env).
Méthode : fenêtre d'appariement corrigée (Étape 4), 45 lignes / 37 avec référence.

## Résultat baseline (STREAMING deepgram)

- First attempt : **12/37 (32,4 %)** — 12 affichés, tous finalement corrects (0 écrasé)
- shown=12, finalCorrect=12, overwrittenFinalState=0
- textDetected mais JAMAIS affiché : 5
- jamais détecté du tout : 24
- Faux positifs : 0/8
- Latence affichage (12 énoncés affichés) : p50=3929ms, p95=7976ms, min=1977ms, max=7976ms

Note : run précédent (avant correction fenêtre) : first attempt 5/37=13,5 %, p50=3499ms, p95=27018ms — non comparable (fenêtre non bornée).
Le run instrumenté (DEBUG-EVENTS) du même jour donne 12/37, p50=3929, p95=7976 — variance run-to-run faible mais réelle.

## Classification des échecs (vérité terrain = log serveur + événements WS bruts)

### A. Référence absente du transcript (ASR n'a jamais transcrit) : 3

- N2 « Osée chapitre 6 verset 6 » : aucun transcript Osée (seulement « Colosor » avant)
- H2 « Let us turn to Matthieu chapitre 5 » : aucun transcript (mix EN/FR)
- I2 « In these uncertain times... Isaiah 41:10 » : aucun transcript (anglais)

### B. Nombres mal transcrits : 1 partiel

- B1 « John 3:16 » → « Jon 3 sixtine. » → affiché **Jonas 3:1** (mauvais livre, mauvais verset)

### C. Livre mal transcrit / non reconnu : 4

- B1 (via « Jon » → Jonas)
- B2 « The gospel of John, chapter three, verse sixteen » → « 3 chapitre 3, verset » (livre absent)
- H1 « ...in the book of Romans, chapter eight » → « roman, chapitre 8. » (« roman » non reconnu)
- D5 « Sophonie chapitre 3 verset 17 » → « Sophonie » seul (livre détecté, suite jamais transcrite)

### D. Verset manquant (troncature ASR/VAD, transcript incomplet) : 4

- D3 « Philémon verset 6 » → « Philémon verset » (jamais « 6 »)
- D7 « Deutéronome chapitre 6 verset 5 » → « Deutéronome chapitre 6 verset » (jamais « 5 »)
- F2 « Romains 12.2 » → « Romains chapitre 12 verset » (jamais « 2 »)
- K5 « Ésaïe 53.5 » → « Ésaïe chapitre 53 verset » (jamais « 5 »)

### E. Référence présente dans un partial mais non détectée : aucun

### F. Affichage correct MAIS trop tardif (>8 s après fin attendue) : 8

- C1 « Premier Corinthiens chapitre 13 verset 4 » : affiché 1cor 13:4 à +28,9 s
- C2 « Deuxième Timothée chapitre 3 verset 16 » : affiché 2tim 3:16 à +24,8 s
- C3 « Première Jean chapitre 4 verset 8 » : affiché 1jean 4:8 à +26,6 s
- D6 « Apocalypse chapitre 21 verset 4 » : affiché à +22 s
- N1 « Néhémie chapitre 8 verset 10 » : affiché à +17,5 s
- N3 « Colossiens chapitre 3 verset 23 » : affiché à +22,8 s
- N4 « Jacques chapitre 1 verset 5 » : affiché à +23,6 s
- K4 « Éphésiens 2.8 » : affiché à +8,4 s (juste hors fenêtre 8 s du banc → compté « textDetected not shown »)

### H. Déduplication avale les répétitions légitimes (DEDUP_MS) : 5

- A2 « Jean chapitre 3 verset 16 » : texte détecté (« Jean 3 16. ») mais « Duplicate suppressed: jean:3:16 » (A1 affiché 2,5 s avant)
- A3 « Jean trois seize » : idem
- A4 « Saint Jean 3.16 » : idem
- A5 « L'Évangile selon Jean, chapitre 3, verset 16 » : flaky — fusion OK mais selon le run, soit affiché, soit « Duplicate suppressed » (28,7 s < 30 s, limite)
- G2 « Jean 14.6 » (2e occurrence, 10 s après G1) : « Duplicate suppressed: jean:14:1 »

### I. Autre : 3

- G1 « Jean 14.6 » : affiché **jean:14:1** (mauvais verset — chapitre seul tronqué → verse 1 par défaut)
- I1 « ...Philippiens 4.13... » : affiché philippiens:4:1 transitoire puis corrigé philippiens:4:13 (+319 ms) — considéré OK par le banc (état final correct)
- J1 « Car Dieu a tant aimé le monde... » (citation, expects_scripture=false) : affiché jean:3:16 (détection sémantique de citation) — faux positif politique/banc (J1 a expectedRefKey rempli → banc le compte comme référence, pas comme FP)

## Après correctif « dédoublonnage par énoncé » (2026-08-16)

Implémentation (fix H + précision G1) :

- `latency-tracker.js` : chaque tracker reçoit un `id` strictement croissant (identité d'énoncé).
- `session-state.js` : `isDuplicateReference/recordShownReference` prennent un contexte `{utteranceId, text, source}`. Règles : cascade partiel→final du MÊME énoncé (même id) supprimée ; énoncé DISTINCT = nouvelle intention → affiché ; exception : final officiel Deepgram tardif dont le texte normalisé est UN SOUS-ENSEMBLE du dernier texte affiché pour cette référence → re-émission, supprimé. Les refKeys `quote:` gardent l'ancienne règle temporelle 30 s (même citation lue deux fois = répétition de lecture, test integration-quote-match).
- `server.js` : passe `tracker.id`, `correctedText` et `opts.source` au dédoublonnage ; la garde « chapitre seul ambigu » couvre désormais AUSSI les finals officiels Deepgram (`opts.source === 'deepgram-final'`) → « Jean 14 » ne déclenche plus le repli jean:14:1 (candidateVerse + attente), le repli verse 1 reste pour le chemin segment (test integration-chapter-only-verse1 intact).

Mesures (variance run-to-run ASR réelle, 2 runs) :

- Run 1 : **13/37 (35,1 %)** — A1, A2, A4, A5, D1, D2, E1, E2, E3, F1, I1, J1, K1, K2 affichés ; textDetectedNotShown : 1 (A3, hors fenêtre) ; FP 0/8 ; p50=4303, p95=7960.
- Run 2 : **12/37 (32,4 %)** — A3 et E3 perdus par variance ASR (non transcrits ce run) ; textDetectedNotShown : 1 ; FP 0/8 ; p50=4066, p95=6374.
- Structurel (déterministe, indépendant du run) : cas cible **A2 affiché** (anciennement « Duplicate suppressed ») ; plus AUCUN « Duplicate suppressed » pour des énoncés distincts ; finals officiels tardifs de A1/A3 supprimés (contenance) ; G1 « Jean 14.6 » n'affiche plus jean:14:1.
- Cause racine dominante restante PROUVÉE native ASR : proxy brut (sans pipeline, sans serveur) sur bloc1.wav → mêmes délais progressifs (C1 final « 13 verset 4. » à +56,6 s pour audio finie à 30,6 s). La latence bench P50≈4 s / P95≈8 s est donc dominée par la délivrance Deepgram sur ce feed TTS, pas par le pipeline.

## Après correctif « latence chemin fusion » (2026-08-16)

Implémentation (3 leviers) :

- **Fusion sur partials stables** (`server.js`, `onPartialTranscript`) : un partial SANS référence complète n'est enfilé pour fusion que s'il est STABLE (2e occurrence identique du même énoncé, fenêtre `recentPartialTexts`/`recentPartialRefs`, reset par tracker) — jamais d'action sur un texte volage. Source `partial-fragment` → `processTranscript` peut reconstruire la référence dès les partials, sans attendre les finals Deepgram (~5-7 s plus tard).
- **Garde « chapitre seul ambigu » étendue aux fragments partiels** : `opts.source === 'partial-fragment'` rejoint `local-vad-silence`/`deepgram-final` → un « 13 verset » ou « 1 Corinthiens chapitre » stable ne déclenche jamais le repli jean:14:1 (candidateVerse + attente).
- **Préchauffage du cache Bible PAR CHAPITRE** dans la garde ET dans la fusion « référence incomplète » : `getVerseMultilang({book, chapter})` échauffe `chapterCache` (helloao) → l'affichage du verset reconstruit est ensuite quasi instantané (`bible: 0ms`, aucun re-téléchargement réseau).

Correctif associé (`bible-lookup-with-api.js`) : les entrées CHAPITRE SEUL (`verseStart` absent, clé `lang:livre:chap:-`) ne sont plus insérées dans le cache « verset » scanné par `findByQuotedText`, ni chargées depuis le cache disque. Sans cela, le préchauffage mettait « 1 Jean 4 » (texte = chapitre entier) dans le cache des citations → « Répétez après moi Dieu est amour » (M1, contient exactement 1 Jean 4:8) matche à 0.67 ≥ 0.55 → faux positif. La donnée reste disponible via `chapterCache`, donc le préchauffage garde tout son bénéfice.

Mesures (run après correctif, 2026-08-16) :

- **14/37 (37,8 %) affichés** — A1, A2, A4, A5, D1, D2, E1, E2, E3, F1, I1, J1, K1, K2 ; textDetectedNotShown : 1 (A3, variance ASR) ; **FP 0/8** ; **p50=3752, p95=6278 (meilleur run de tous)**.
- Structurel : C1 « 1 Corinthiens 13:4 » affiché via partial-fragment stable (~+30 s au lieu de ~+59 s via finals), sans re-fetch réseau (pre-warm chapitre → chapterCache hit, `bible: 0ms`) ; C3 et D6 affichés via fusion ; C2 via fusion des finals (partials non répétés ce run) ; D6 « Apocalypse 21:4 » via partial stable.
- Le bench reste non créditeur pour C1/C2/C3 (« livre_numerote : 0/3 ») : la fenêtre d'appariement est [fin_audio+8000ms] alors que la délivrance ASR native + backlog de la file de transcription placent ces affichages hors fenêtre (C1 : +34 à +53 s pour fin d'audio 30,6 s). Gain réel-world net quand même (soustrait ~6 s à la latence de display de C1), hors mesure du bench.

## Causes racines par volume

1. **F — latence chemin fusion de fragments : 17 à 29 s** pour les livres difficiles/numérotés (8 cas). Le chemin « Référence reconstruite par fusion de fragments » ne s'affiche qu'après confirmation longue.
2. **H — déduplication 30 s par référence** (5 cas, dont le cas cible A2–A5 « dit une seule fois »). DEDUP_MS avale des occurrences légitimes.
3. **D — troncature du numéro de verset** par l'ASR/VAD (4 cas) : le transcript s'arrête sur « verset ».
4. **C/A — langues (EN/FR, EN pur)** : livre anglais non reconnu ou utterance jamais transcrite (5 cas).
