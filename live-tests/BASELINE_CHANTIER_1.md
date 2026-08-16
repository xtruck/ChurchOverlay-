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

## Causes racines par volume

1. **F — latence chemin fusion de fragments : 17 à 29 s** pour les livres difficiles/numérotés (8 cas). Le chemin « Référence reconstruite par fusion de fragments » ne s'affiche qu'après confirmation longue.
2. **H — déduplication 30 s par référence** (5 cas, dont le cas cible A2–A5 « dit une seule fois »). DEDUP_MS avale des occurrences légitimes.
3. **D — troncature du numéro de verset** par l'ASR/VAD (4 cas) : le transcript s'arrête sur « verset ».
4. **C/A — langues (EN/FR, EN pur)** : livre anglais non reconnu ou utterance jamais transcrite (5 cas).
