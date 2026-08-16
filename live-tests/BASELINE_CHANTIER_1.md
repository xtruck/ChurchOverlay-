# BASELINE_CHANTIER_1 — pipeline actuel (avec Étape 4 non commitée), STREAMING (deepgram)

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
