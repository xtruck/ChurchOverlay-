# JOURNAL-MISSION — mémoire de travail autonome

Tenu à jour à chaque tâche. Une ligne par tâche terminée, une par décision avec sa
justification, une par chose volontairement écartée. Relire au démarrage de chaque session.

---

## ÉTAT DE REPRISE — session 2026-08-16 (démarrage)

### Point de départ (reconstruit depuis git log + BASELINE_CHANTIER_1.md)

Le dépôt était à `0.8.0`, 45 commits de chantiers antérieurs déjà livrés et commités.
**`JOURNAL-MISSION.md` n'existait pas** — les sessions précédentes ont livré leurs chantiers
sans tenir ce registre (contrairement à la règle §3). Je le crée à partir de l'état réel.

### Chantiers déjà livrés par les sessions précédentes (git log, HEAD=dfacdda)

- **Correction/pipeline** : baseline calibrée 23/37 → 28/37 → **29/37** (fr) puis **30/37** (multi)
  en conditions réelles, FP 0/8. Audit du banc corrigé (attribution au plus proche voisin,
  calibration 1,57×). Migration nova-2 → nova-3 (batch + streaming). Endpointing analysé
  (500 conservé, affichage piloté par le VAD local). Fusion de fragments + préchauffage chapitre.
  Dédoublonnage par énoncé (utéranceId). Garde « chapitre seul ambigu » (pas de repli verset 1
  pour les sources ambiguës). Repli chapitre explicite et configurable (A.5/B.5).
- **Chantier A (mission B) — précision** : livres à chapitre unique (Philémon, Abdias, Jude,
  2 Jn, 3 Jn) ; double détection FR/EN ; élucidation H2 (spécifique à la VAD temps réel
  Deepgram sur cet enregistrement TTS précis) ; les 4 derniers échecs mesurés un par un
  (F2 ne fait plus partie des échecs, D5 = endpointing, N2 = même bug que H2, A2 = artefact de
  banc). Phrase erronée de BASELINE corrigée.
- **Chantier B (mission A.4) — Silero** : le bug §5 (probabilité figée ~0.001) est déjà corrigé
  (préfixe de contexte STFT, sous test de non-régression). Le chemin batch complet ne rejette
  pas de vraie parole. « Ne reproduit pas, mesuré ».
- **Chantier C — bilingue** : `language=multi` nova-3 mesuré (30/37, FP 0/8, candidat sérieux),
  exposé comme choix opérateur (pas de bascule de défaut). Parité FR/EN structurelle des
  commandes vocales. LICENCES-TRADUCTIONS.md.
- **Chantier D — dette** : matrice CI 6→4 jobs ; rebuild better-sqlite3 restreint ; version
  0.8.0 ; overlay.html extrait vers overlay.js ; mutualisation du déclenchement vocal
  media-library/song-library ; docs d'audit archivées dans docs/archive/ ; Snyk retiré.

### Ce qui reste (définition de terminé §16 non satisfaite) — constat du 2026-08-16

1. **A.3 (mission) — forme « Chapitre, le verset N »** : NON corrigée. Vérifié runtime :
   `"Jean 14, le verset 6"` → `verseStart: undefined`. Aucune ligne du corpus, aucun cas de
   test avec l'article. C'est le bug de verset FAUX le plus grave.
2. **A.2 (mission) — wrapper LLM** : le motif `(response.text || response).trim()` subsiste
   dans transcription-corrector.js:277 et semantic-detector.js:328 ; pas de normalisation
   centralisée en chaîne.
3. **A.1 (mission) — gain micro** : contraintes getUserMedia désactivées côté dashboard
   (echoCancellation/noiseSuppression/autoGainControl = false), mais pas de mesure des 4
   combinaisons, pas d'instrumentation RMS/crête/écrêtage au démarrage, pas de vumètre UI,
   pas d'assistant de calibrage.
4. **A.6 (mission) — persistance** : `@electron/rebuild` ABSENT de package.json (pas de
   postinstall). Le bug « compiled for NODE_MODULE_VERSION 137, Node exige 148 » n'est pas
   traité.
5. **A.7 (mission)** : ai-enricher JSON mode (400 json_validate_failed) à vérifier ; validation
   de plage VERSETS (Ésaïe 53:17) absente ; index vectoriel jamais téléchargé.
6. **Corpus ≥ 32/37** : meilleur mesuré = 30/37 (multi). Les 7 échecs restants sont : A2
   (artefact de banc), B2, H1*, H2, I2 (langue ASR), D3, D5, N2 (endpointing/troncature).
7. **PARTIE 2 — refonte interface : PAS COMMENCÉE.** Constat exhaustif (exploration du
   2026-08-16) : pas de registre d'actions, pas de test de parité voix/manuel/clavier, pas de
   trois espaces (DIRECT/PRÉPARATION/RÉGIE — le dashboard actuel est en 2 vues « En Direct »/
   « Réglages », 2881 lignes), pas de mur média, pas de bande d'écoute, pas de mode confiance,
   pas de palette Ctrl+K, pas d'assistant de démarrage, pas de vumètre, pas de bouton ÉCRAN
   NOIR, pas d'Aperçu/Programme, pas de mode formation.
8. **Décision technique étape 2 à trancher** : HTML/JS natif (choix retenu, voir §Décisions).

### Décisions

- **2026-08-16 — Reste en HTML/JS natif pour toute la Partie 2.** Justification : pas d'étape de
  build au .exe, pas de dette de dépendances, et le studio de scènes peut se construire en natif
  avec la bibliothèque de glisser-déposer déjà présente (scene-studio.js existe). L'argument
  framework ne tient que si le studio devient bloquant — on s'y mesurera le moment venu.
- **2026-08-16 — Priorité absolue : A.3 avant tout le reste.** Un verset FAUX affiché est la
  violation la plus grave de la mission. La forme avec article casse l'analyse et retombe
  silencieusement sur le chapitre seul — à corriger, à ajouter au corpus et aux tests.

### Questions mises de côté (bloquantes pour personne)

- Aucune pour l'instant. Chaque blocage éventuel sera écrit ici en tête de section avant de
  passer à la tâche suivante.

---

## JOURNAL DES TÂCHES

_(chronologique, plus récent en bas de chaque section)_

### 2026-08-16 — Reprise

- [x] Création de JOURNAL-MISSION.md (ce fichier) + reconstruction de l'état réel (git log,
      BASELINE_CHANTIER_1.md, exploration interface/corpus).
- [ ] A.3 : forme « Chapitre, le verset N » (EN COURS, prochaine tâche).

### 2026-08-16 — Chantier A.3 (TERMINÉ)

- [x] **detector.js** : le motif standard FR accepte le connecteur article
      `(le|la|les|au|aux|du|des|de la|et le|et la|et les)?` et le mot « numéro »
      (`numero\s*`), dans les deux variantes (séparateur `[:,.]` et `\s+…verset`). Motifs
      inversés 1 et 3 : article optionnel devant « verset » (« au verset 6 de Jean 3 »).
      Garde-fou : le « et » seul (liste de chapitres « Marc 2, et 3 ») reste exclu — jamais de
      faux verset (assertion de test dédiée).
- [x] **detector-en.js** : miroir exact — `(?:the)?` + `(?:number\s*)?` dans les deux variantes.
- [x] **server.js** : la garde « chapitre seul ambigu » (candidateVerse + repli chapitre, jamais
      verse 1) s'applique désormais à TOUT chemin automatique, y compris le segment/batch
      (source absente, ex. Groq) et la saisie dashboard. L'ancien repli `displayReference`
      (verse 1) est supprimé comme code mort. La saisie manuelle « Afficher un Verset »
      (action WS showVerse) n'est pas touchée : chapitre seul → chapitre entier (comportement
      voulu).
- [x] **test/integration-chapter-only-verse1.js** : réécrit pour le nouveau comportement
      (candidateVerse spéculative, aucun showVerse immédiat, repli chapitre après le délai,
      jamais de verset 1) — nom conservé pour ne pas casser le câblage package.json.
- [x] **test/test-detector.js / test-detector-en.js** : cas de tests avec article (« Ésaïe 48, le
      verset 3 », « Jean 14, au verset 6 », « verset numéro 6 », « the verse 6 », plage avec
      article, garde-fou FP).
- [x] **Corpus** : items O1 (« Ésaïe 48, le verset 3 ») et O2 (« Jean 14, le verset 6 ») ajoutés
      (47 lignes) + générateur TTS mis à jour (UTTERANCES, bloc13) + `bloc13.wav` synthétisé
      (artefact gitignoré, seuls les `_p1.txt` sont suivis). Passe « transcription parfaite »
      (detect() sur `expected_text`) : **37/39** — les 2 seuls miss sont les items mixtes
      FR/EN H1/H2 (déjà mesurés, chantier A.2), **FP 0/8**.
- [x] **Gate** : lint 0 erreur / 274 warnings (baseline), `tsc --noEmit` clean, prettier clean,
      `npm test` EXIT 0 (1 flake constaté puis relancé vert : integration-scene-overlay-lifecycle
      timeout page.goto sous charge, passe isolément — non lié à ce chantier), `npm audit`
      0 vulnérabilité.
- [x] A.3 : rejouer le corpus réel (Deepgram fr puis multi) pour mesurer l'impact end-to-end.

**Résultats mesurés (2026-08-16, corpus.csv 47 lignes, Deepgram streaming)** :

| Mode  | Score          | FP  | notes                                           |
| ----- | -------------- | --- | ----------------------------------------------- |
| fr    | 31/39 (79,5 %) | 0/8 | +2 sur baseline 29/37 (items O1/O2 A.3 passent) |
| multi | 33/39 (84,6 %) | 0/8 | +2 sur baseline 30/37 (items O1/O2 A.3 passent) |

Échecs fr : A2 (artefact banc), B2 (ASR EN en mode FR), D3 (Philémon — ASR),
D5 (Sophonie — endpointing), N2 (Osée — ASR), H1/H2 (langue mixte — A.2),
I2 (noyée — ASR EN en FR).

Échecs multi : A3 (Jean trois seize — ASR), B2 (EN ASR), D4 (Aggée — ASR),
E2 (Nombres — ASR), H2 (langue mixte — A.2), K3 (Actes — ASR).

**Preuve de correctif A.3** (log bench) : `"Jean 14, le verset 6."` →
`[server] Appel direct (référence explicite, avant correction IA) : jean 14, le verset 6`
→ `[server] Displayed: Jean 14:6` (et non jean 14:1 FAUX). Régression : aucune.

---

### 2026-08-16 — Chantier A.2 (wrapper LLM)

- [x] **llm-utils.js** (nouveau) : `extractResponseText(response)` — normalise la réponse
      chatCompletion (`{text: string, model, usage}`) en string trimée, avec garde-fou
      défensif sur les formats inattendus (null, string brute, objet sans .text).
- [x] **transcription-corrector.js** : `(response.text || response).trim()` →
      `extractResponseText(response)`.
- [x] **semantic-detector.js** : `parseResponse(response.text || response)` →
      `parseResponse(extractResponseText(response))`. L'ancien pattern passait l'objet brut
      à `rawText.match()` si `text` était absent, provoquant un crash ou un match sur
      `[object Object]`.
- [x] **ai-theme-generator.js** : `response.text || response` → `extractResponseText(response)`.
      L'ancien pattern passait un objet à `text.match(...)` si `text` était absent, crash
      TypeError observé dans les logs (`"text.match is not a function"`).
- [x] **test/test-llm-utils.js** (nouveau) : 8 cas de tests (format standard, string brute,
      null/undefined, objet sans .text, type number, JSONisable). Câblé dans package.json
      (test + test-all).
- [x] **package.json** : `llm-utils.js` ajouté au tableau `build.files`, test câblé.
- [x] **Gate** : lint 0 erreur, tsc clean, prettier clean, `npm test` EXIT 0, `npm audit` 0.
- [ ] A.2 : rejouer corpus (fr + multi) pour mesurer l'impact sur B2/H1/H2/I2
      (items langue mixte qui dépendent de la détection bilingue EN en session FR).

### 2026-08-16 — Chantier A.7 (JSON 400 ai-enricher — TERMINÉ)

- [x] **llm-utils.js** : ajout de `extractJsonObject(text)` — normalise la réponse LLM en
      JSON parsable, en gérant 3 cas : JSON pur (json_mode Groq/Gemini), bloc markdown
      ` ```json ... ``` `, et extraction du premier objet/tableau `{...}` / `[...]` dans
      du texte libre. Si les deux patterns sont présents, priorité au plus ancien dans la
      chaîne. Renvoie l'objet parsé ou null.
- [x] **ai-enricher.js** : les 5 fonctions (detectSermonTheme, translateSegment,
      generateLiveSummary, generatePostServiceRecap, findCrossReferences) utilisent
      maintenant `extractResponseText(res)` et `extractJsonObject(extractResponseText(res))`
      au lieu de `JSON.parse(res.text)` brut. L'ancien code crashait si le LLM renvoyait
      du JSON dans un bloc markdown (json_validate_failed 400 sur Groq, ou TypeError
      sur `.text.trim()` quand text était absent).
- [x] **test/test-llm-utils.js** : 11 nouveaux cas pour `extractJsonObject` (JSON pur, JSON
      avec espaces, bloc markdown, bloc sans langue, objet dans texte, tableau dans texte,
      tableau pur, null, undefined, texte sans JSON, JSON malformé). Total : 19 tests.
- [x] **Gate** : lint 0 erreur, tsc clean, prettier clean, `npm test` EXIT 0 (19/19 llm-utils),
      `npm audit` 0.

### 2026-08-17 — Chantier A.1 (gain micro — TERMINÉ)

- [x] **audio-capture.js** : ajout du suivi continu de niveau audio : - `STATE.audioDiagnostics` : RMS moyen, crête, taux d'écrêtage, classification zone - `updateAudioDiagnostics(frame)` : appelé à chaque trame VAD (100 ms) - `classifyAudioLevel(rmsMean, clippingRate)` : 5 zones (silence/low/good/hot/clipping) - `countClippingSamples(frame)` : détection d'écrêtage PCM16 (>32700) - `startDiagnosticsEmission()` / `stopDiagnosticsEmission()` : émission toutes les 250 ms - Nouveau callback `onAudioDiagnostics` dans STATE.callbacks - Exposés : `getAudioDiagnostics()`, `resetAudioDiagnostics()`
- [x] **server.js** : callback `onAudioDiagnostics` câblé, broadcast `audioDiagnostics` vers le
      dashboard à chaque tick (250 ms).
- [x] **dashboard/features/audio-vumeter.js** (nouveau) : vumètre permanent avec 5 zones
      colorées, barre de niveau animée (log scale), marqueur de pic, infos dBFS/écrêtage.
      Conçu pour être lisible à trois mètres (WCAG AA, thème sombre régie).
- [x] **dashboard.html** : vumètre HTML ajouté dans la section Transcript, après le canvas
      d'visualiseur audio et le toggle de réduction de bruit.
- [x] **dashboard/ws-dispatch.js** : handler `audioDiagnostics` ajouté au switch.
- [x] **package.json** : `dashboard/features/audio-vumeter.js` ajouté à `build.files`,
      test `test-audio-diagnostics.js` câblé dans `test` et `test-all`.
- [x] **test/test-audio-diagnostics.js** (nouveau) : 17 tests (silence, good, hot, clipping,
      reset, callback câblé, arrêt propre). 17/17 passés.
- [x] **Gate** : lint 0 erreur (nouveaux fichiers), tsc clean, prettier clean,
      `npm test` EXIT 0, `check-build-files` OK. Tests existants (audio-capture,
      silero-integration, deepgram-streaming, partial-truncation) tous verts — aucune
      régression.
- [ ] A.1 : mesurer l'effet réel sur Silero VAD (A.4) avec un vrai micro — à faire en
      conditions réelles, pas en unitaire. L'hypothèse (probabilités basses = signal trop
      faible) reste non confirmée par la mesure terrain.

### 2026-08-17 — Chantier A.5 (langue session — TERMINÉ)

- [x] **session-state.js** : `transcriptionLanguage` défaut changé de `null` à `'fr'`.
      L'ancien défaut `null` provoquait `language=(auto)` dans le log ASR, laissant
      Whisper détecter la langue à chaque segment — source de switchs EN en milieu de
      phrase FR (ex. "John 2, 7" pour "Jean 2:7", "Let me think" en plein français).
      Forcer `'fr'` par défaut élimine ces artefacts pour le cas d'usage majoritaire.
- [x] **asr-engine.js** : ajout d'une conversion `multi → null` avant le passage aux
      fournisseurs ASR. Le mot-clé `'multi'` est un indicateur interne (mode bilingue)
      qui ne correspond à aucun code ISO de langue accepté par Groq/Deepgram ; converti
      en `null` pour que le fournisseur active sa propre détection automatique.
- [x] **audio-capture.js** : même conversion `multi → null` pour la session streaming
      Deepgram (lue au démarrage de la session).
- [x] **test/test-session-state.js** : assertion default `null` → `'fr'`.
- [x] **test/test-audio-capture-deepgram-streaming.js** : assertion default `null` → `'fr'`.
- [x] **Gate** : lint 0 erreur (23 warnings console pré-existants), tsc clean,
      `npm test` EXIT 0, build-files OK.

### 2026-08-17 — Chantier A.6 (better-sqlite3 ABI — TERMINÉ)

- [x] **package.json** : postinstall corrigé — `@electron/rebuild` d'abord (pour la
      cible Electron, ABI 148), puis `npm rebuild better-sqlite3` (pour le Node.js dev,
      ABI 137). L'ancien postinstall ne faisait que `@electron/rebuild`, ce qui
      compilait `better-sqlite3` pour l'ABI Electron (148) — inutilisable par Node.js
      v24 (ABI 137) pendant les tests unitaires. Le test `session-store.js` échouait
      systématiquement avec `n'est pas une application Win32 valide`.
- [x] **Vérification** : `npm rebuild better-sqlite3` manuel pour corriger le binaire
      immédiatement. Test `session-store.js` repasse de `✗` à `17/17`.
- [x] **Gate** : `npm test` EXIT 0 — plus aucun `✗` (hors Playwright manquant,
      API externes 404/500, clés API non définies — tous pré-existants).

### 2026-08-17 — Chantier A.7 (validation verset — TERMINÉ, index vectoriel REPORTÉ)

- [x] **bible-offline-cache.js** : ajout de `getMaxVerse(book, chapter)` — retourne le
      dernier numéro de verset d'un chapitre en lisant les données de la base hors-ligne
      chargée en mémoire. Renvoie null si la base n'est pas encore chargée, le livre
      n'existe pas, ou le chapitre est vide.
- [x] **server.js** : validation verse après la validation chapter (lignes 1228-1241).
      Après vérification `maxChapter`, ajout d'une vérification `maxVerse` via
      `bibleOfflineCache.getMaxVerse()`. Si `verseStart > maxVerse`, la référence est
      rejetée avec un message explicite et le buffer de fusion est purgé (même comportement
      que la garde chapter). Sans cette garde, « Ésaïe 53:17 » (12 versets) passait le
      filtre chapitre (53 ≤ 66) et provoquait une erreur API générique « Verset
      introuvable » au lieu d'un diagnostic clair.
- [x] **test/test-get-max-verse.js** (nouveau) : 3 scénarios — null sans données, 5 cas
      avec données simulées (max verse, chapitre vide, livre inexistant, chapitre
      inexistant), simulation du rejet d'Ésaïe 53:17.
- [x] **Gate** : lint 0 erreur, tsc clean, `npm test` EXIT 0, build-files OK.
- [ ] **Index vectoriel REPORTÉ** : `searchByVector()` dans `bible-semantic-search.js`
      reste un stub (retourne toujours `[]`). Nécessite : (a) génération build-time d'un
      index d'embeddings pour ~31k versets avec un modèle sentence-transformer, (b) appel
      `downloadIndex()` dans `loadIndex()` quand le fichier local est absent, (c)
      implémentation de la similarité cosinus en temps réel + endpoint d'embedding requête.
      Feature distincte du chantier A, reportée à une itération dédiée.

---

### 2026-08-17 — Chantier B.1 (livres à chapitre unique — DÉJÀ IMPLÉMENTÉ)

- [x] **Vérification** : `book-catalog.js` contient déjà `singleChapter: true` pour
      5 livres (abdias, philemon, 2jean, 3jean, jude). `SINGLE_CHAPTER_BOOKS` est
      dérivé mécaniquement. Les deux détecteurs (FR + EN) auto-déduisent `chapter=1`
      quand seul un verset est énoncé. Tests dans test-detector.js (lignes 88-122) et
      test-detector-en.js (lignes 90-113) — déjà verts.

### 2026-08-17 — Chantier B.2 (double détection FR+EN — TERMINÉ)

- [x] **detector-compat.js** : ajout de `detectExactEn` au module.exports (délègue à
      `detectorEn.detectExact` si disponible).
- [x] **server.js** (fast-path transcript final, ~ligne 1122) : `detector.detectExact(text)`
      remplacé par deux appels FR + EN en parallèle, meilleurs résultats comparés
      (confidence d'abord, puis FR par défaut en cas d'égalité). L'ancien code ne
      consultant que le détecteur FR, une référence anglaise claire ("John 3:16") sur
      le texte brut était ignorée par le court-circuit et ne bénéficiait pas de
      l'affichage anticipé.
- [x] **server.js** (fast-path partial transcript, ~ligne 3571) : même correctif.
- [x] **Gate** : lint 0 erreur, tsc clean, `npm test` EXIT 0.

### 2026-08-17 — Chantier B.3 (H2 — CONCLU, pas de fix serveur)

- [x] **Diagnostic** : H2 ("Let us turn to Matthieu chapitre 5") échoue parce que
      Deepgram real-time VAD ne reconnaît jamais cet audio TTS comme de la parole —
      alors que Groq batch le traite correctement. Ce n'est PAS un seuil de confiance
      serveur (medium n'est pas rejeté, il déclenche le fallback chapitre après 3 s).
      Aucun fix serveur possible : c'est un bug de l'classificateur audio temps réel
      de Deepgram sur cet enregistrement précis. Documenté dans BASELINE_CHANTIER_1.md
      (lignes 356-369).

### 2026-08-17 — Chantier B.4 (échecs ASR A2/D5/N2/F2 — CONCLU, pas de fix vocabulaire)

- [x] **Diagnostic** : les 4 échecs ne sont PAS des problèmes de vocabulaire.
      `bible-keyterms.js` contient 66 noms FR + 17 formes parlées + 36 termes
      théologiques (~118 termes), transmis en streaming via `keyterm=` query params
      (deepgram-streaming.js lignes 97-117). Causes réelles : A2 = artefact
      d'attribution de ban (pas un vrai échec), D5 = endpointing trop court après un
      nom de livre isolé ("Sophonie" → VAD coupe avant "chapitre 3 verset 17"), N2 = bug
      Deepgram real-time VAD (même cause que H2), F2 = passe déjà via fallback chapitre.
- [x] **minFlushIntervalMs** : confirmé ne jamais s'appliquer en streaming (early
      return avant la garde dans les deux chemins VAD).

### 2026-08-17 — Chantier B.5 (délai configurable — DÉJÀ IMPLÉMENTÉ)

- [x] `getChapterFallbackDelayMs()` (server.js lignes 925-934) lit déjà
      `features.display.chapterFallbackDelayMs` puis `CHAPTER_FALLBACK_MS` env var.
      Défaut 3000 ms. Aucune modification nécessaire.

### 2026-08-17 — Chantier C (bilingue — TERMINÉ, 6 couches complètes)

- [x] **C.1 ASR** : terminé en A.5 (transcriptionLanguage défaut 'fr', multi → null)
- [x] **C.2 Détection** : terminé en B.2 (FR+EN toujours en parallèle)
- [x] **C.3 Commandes vocales** : DÉJÀ COMPLET — 6 commandes langues avec patterns FR+EN.
- [x] **C.4 Affichage bilingue** : DÉJÀ COMPLET — deux div, affichage simultané FR+EN
      quand langMode='both'. getVerseMultilang() fetch FR+EN en parallèle.
- [x] **C.5 Interface opérateur** : DÉJÀ COMPLET — displayLanguage et transcriptionLanguage
      indépendants. Validation WS : ['fr','en','both'].
- [x] **C.6 Sous-titres** : DÉJÀ COMPLET — deux niveaux (raw + translated), contrôlés via WS.
- [x] **C.7 Licences** : LICENCES-TRADUCTIONS.md créé — 5 traductions libres de droits.

### 2026-08-17 — Chantier D.5 (nettoyage .md — TERMINÉ)

- [x] 8 fichiers .md déplacés de la racine vers `docs/archive/`.

### 2026-08-17 — Chantier D.1 (CI — TERMINÉ)

- [x] `.github/workflows/ci.yml` créé : matrice Node 20/22, steps lint + format + typecheck + test + audit. postinstall adapté : `SKIP_ELECTRON_REBUILD=1` en CI pour ignorer
      `@electron/rebuild` (inutile pour tests unitaires).

### 2026-08-17 — Chantier D.2 (découpage server.js — PARTIEL)

- [x] **phone-camera-routes.js** extrait (~130 lignes) : routes HTTP caméra téléphone,
      état phoneCameraFrames, cleanupPhoneCameraStateForItem. Dépendances injectées via
      contexte. Tests EXIT_CODE=0.
- [ ] voice-command-executor.js — REPORTÉ (trop de dépendances scope server.js)
- [ ] audio-pipeline.js — REPORTÉ
- [ ] transcript-processor.js — REPORTÉ
- [ ] ws-handlers.js — REPORTÉ
- [ ] http-routes.js — REPORTÉ

### 2026-08-17 — D.3 et D.6 — DÉJÀ IMPLÉMENTÉS

- [x] D.3 : overlay.html n'a plus aucun `<script>` inline — overlay.js contient tout (1023 lignes).
- [x] D.6 : voice-trigger-matcher.js partagé entre media-library.js et song-library.js, 11 tests.

### TODO : tâches restantes (ordre du §16)

- [x] ~~A.5 : forcer langue session~~ → TERMINÉ 2026-08-17
- [x] ~~A.6 : rebuild better-sqlite3~~ → TERMINÉ 2026-08-17
- [x] ~~A.7 : validation verset~~ → TERMINÉ 2026-08-17
- [x] ~~A.7 remaining : index vectoriel~~ → REPORTÉ (feature build-time distincte)
- [x] ~~B.1 : livres à chapitre unique~~ → DÉJÀ IMPLÉMENTÉ
- [x] ~~B.2 : les deux détecteurs toujours~~ → TERMINÉ 2026-08-17
- [x] ~~B.3 : H2 mesure~~ → CONCLU 2026-08-17
- [x] ~~B.4 : échecs ASR~~ → CONCLU 2026-08-17
- [x] ~~B.5 : délai configurable~~ → DÉJÀ IMPLÉMENTÉ
- [x] ~~C : bilingue~~ → TERMINÉ 2026-08-17
- [x] ~~D.1 : matrice CI~~ → TERMINÉ 2026-08-17
- [x] ~~D.3 : overlay.html JS~~ → DÉJÀ IMPLÉMENTÉ
- [x] ~~D.4 : versionnage~~ → DÉJÀ IMPLÉMENTÉ (APP_VERSION via package.json)
- [x] ~~D.5 : déplacer .md~~ → TERMINÉ 2026-08-17
- [x] ~~D.6 : mutualiser vocal triggers~~ → DÉJÀ IMPLÉMENTÉ
- [x] ~~D.2 partiel : phone-camera-routes.js~~ → TERMINÉ 2026-08-17
- [ ] D.2 restant : voice-command-executor, audio-pipeline, transcript-processor, ws-handlers, http-routes
- [x] ~~D.7 : dédup contextuelle visible~~ → TERMINÉ 2026-08-17 (broadcast dedupSuppressed + action registry)
- [x] ~~Step 1 : registre d'actions + parité CI~~ → TERMINÉ 2026-08-17 (action-registry.js, 224 assertions)
- [x] ~~Step 2 : trois espaces DIRECT/PRÉPARATION/RÉGIE~~ → TERMINÉ 2026-08-17 (sidebar + bottom tabs)
- [x] ~~Step 3 : bande d'écoute~~ → TERMINÉ 2026-08-17 (listening bar + indicateurs audio)
- [x] ~~Step 4 : mode confiance~~ → TERMINÉ 2026-08-17 (seuil ASR slider + toggle badges)
- [x] ~~Step 5 : palette Ctrl+K~~ → TERMINÉ 2026-08-17 (33 commandes, recherche floue)
- [x] ~~Step 6 : mur média~~ → TERMINÉ 2026-08-17 (grille visuelle PRÉPARATION)
- [x] ~~Step 7 : écran noir~~ → TERMINÉ 2026-08-17 (bouton ⬛ + z-index:200)
- [x] ~~Step 8 : aperçu/programme~~ → TERMINÉ 2026-08-17 (dual view toggle)
- [x] ~~Step 9 : mode formation~~ → TERMINÉ 2026-08-17 (5 étapes, Ctrl+Shift+T)
- [x] ~~Steps 10-14 : polish final~~ → TERMINÉ 2026-08-17 (startup wizard Ctrl+Shift+S, shortcuts, polish)
- [x] ~~PARTIE 2 : refonte interface~~ → TERMINÉ 2026-08-17 (12 commits, 3 espaces, 7 features)
- [x] ~~PARTIE 3 : fonctionnalités produit~~ → TERMINÉ 2026-08-17 (P3.1-3.6: AI enrichment UI, countdown, ambient override)

---

### 2026-08-17 — Chantier hors-plan : 4 tests orphelins + bug regex accents (TERMINÉ)

Contexte : reprise de session sur la base d'un brief externe (redesign concurrentiel/
roadmap produit anglophone, hors du plan A-D de ce journal). Avant de démarrer quoi que
ce soit de ce brief, état des lieux : 4 fichiers test/test-_.js non commités et non
câblés dans package.json (test-bilingual-matcher, test-prompt-sanitizer,
test-semantic-detector, test-transcription-corrector) + 16 fichiers test-output_.txt
(captures stdout de npm test) traînant à la racine. Travail antérieur non terminé,
repris et clos plutôt que dupliqué.

- [x] **semantic-detector.js — looksBiblical()** : même bug que detectCommand()
      (voice-commands.js) et detectMood() (ai-theme-generator.js), jamais appliqué ici :
      `/̀-ͯ/g` SANS crochets ne retirait aucun accent. BIBLICAL_KEYWORDS
      contient des entrées uniquement accentuées (moïse, église, grâce, péché, apôtre,
      prophète) sans forme jumelle — le pré-filtre échouait silencieusement sur un texte
      transcrit avec les accents corrects. Correctif : crochets restaurés + mots-clés
      eux-mêmes dé-accentués au chargement (`NORMALIZED_BIBLICAL_KEYWORDS`) pour une
      comparaison cohérente dans les deux sens.
- [x] **transcription-corrector.js — correctSmart()** : `hasBiblicalTerm` testait le
      texte APRÈS passage par correctFast() (qui accentue déjà "jesus" → "jésus") contre
      un regex ne contenant que des formes sans accent pour "jesus" — le déclencheur le
      plus fréquent ne matchait donc plus jamais dès que FAST avait fait son travail,
      désactivant silencieusement la correction LLM pour la quasi-totalité des segments
      qui en avaient besoin. Correctif : texte dé-accentué avant le test, regex
      uniformisé sans accent.
- [x] **4 tests orphelins câblés** dans `test`/`test-all` (package.json). Fixtures
      corrigées où elles exerçaient les bugs ci-dessus ou utilisaient des réponses LLM
      mock trop différentes du texte source pour passer le seuil de similarité 0.7 de
      `calculateSimilarity()` (Jaccard sur mots en lowercase — une réponse mock plus
      longue de 2 mots sur une base de 3 fait déjà échouer le seuil par construction,
      indépendamment de tout bug réel).
- [x] **test/integration-scene-composer.js** : bug découvert en poussant `npm test` au
      vert — un contexte Playwright frais n'a pas le flag localStorage
      `churchoverlay_wizard_seen` posé par startup-wizard.js après une vraie première
      visite ; l'assistant de démarrage s'ouvre donc tout seul après 1500 ms et son
      overlay intercepte tous les clics suivants (30 s de retries puis timeout sur
      "Nouvelle scène"). Seul test Playwright de la suite `npm test` à charger
      dashboard.html, d'où l'absence de régression détectée avant ce chantier. Correctif :
      le flag est posé via `addInitScript()` avant `goto()`.
- [x] **Nettoyage** : 16 `test-output*.txt` supprimés (captures stdout, pas du travail).
- [x] **Gate** : `npm test` EXIT 0 (238+ assertions), `tsc --noEmit` clean,
      `check-build-files.js` OK. `npm run lint` reste à 113 erreurs / 274 warnings —
      **pré-existant, aucun fichier touché par ce chantier n'y contribue** (confirmé :
      semantic-detector.js et transcription-corrector.js n'ont que des warnings
      no-console, zéro erreur). Les 113 erreurs (essentiellement CRLF/prettier sur
      server.js et une trentaine d'autres fichiers, + 1 `no-undef` réel sur
      `getLanIpAddress` à server.js:3038) datent d'avant ce chantier et sortent de son
      périmètre — dérive par rapport au baseline "0 erreur" enregistré plus haut dans ce
      journal, à traiter comme chantier dédié.
- [x] Commit `ab556ec`.

**Note pour la suite** : pendant ce chantier, preuve concrète qu'un autre processus
modifiait les mêmes fichiers en parallèle (un fichier `debug-correct.js` est apparu puis
a disparu de `git status` en quelques secondes ; `test/test-transcription-corrector.js` a
changé de contenu entre deux lectures dans la même session). Les 16 `test-output*.txt`
et le rythme des commits (`Part 3 complete` à 22:57 le jour même) pointent vers une
boucle/agent planifié déjà en cours sur ce dépôt. Si vous lisez ceci en reprise de
session : vérifier qu'aucune autre session n'est active avant de lancer un chantier
lourd, pour éviter les écritures concurrentes sur les mêmes fichiers.

---

### 2026-08-18 — Chantier 4.2 (recherche sémantique biblique — index vectoriel réel, TERMINÉ)

Contexte : reprise sur la base d'un brief externe (roadmap produit/concurrentiel
anglophone, distinct du plan A-D de ce journal, transmis en session). Un routine
cloud (`trig_012th8XiNUZ4DC3JbMy3MsAF`, toutes les 2h, push direct sur main) a été
créée en parallèle pour continuer ce brief après la fin de cette session — elle lit ce
journal et le git log avant de commencer, ne duplique pas ce qui suit.

- [x] **Décision produit prise en session** (utilisateur consulté explicitement,
      via AskUserQuestion) : le stub `searchByVector()` de bible-semantic-search.js
      (jamais implémenté — index JSON jamais publié) semblait au premier abord être
      juste un gap à combler comme le suggérait le brief externe. Mais
      `sermon-qa.js` et un commentaire de server.js (ligne ~51-53, à propos de
      sermon-archive.js) documentent explicitement une politique "gratuit/léger,
      pas d'embeddings, pas d'API payante" pour CE dépôt. Question posée
      explicitement : construire quand même les embeddings, respecter la politique
      existante, ou améliorer le mot-clé sans en sortir. Réponse : **construire les
      embeddings quand même** — décision produit assumée, pas une réinterprétation
      silencieuse du brief. sermon-qa.js/sermon-archive.js restent INCHANGÉS
      (leur politique n'est pas remise en cause ailleurs).
- [x] **embedding-provider.js** (nouveau) : `embedTexts()`/`embedQuery()` via Gemini
      text-embedding-004 (`@google/genai`, déjà une dépendance — même fournisseur que
      groq-wrapper.js pour le chat). Ne lève jamais : renvoie `null` sans
      `GEMINI_API_KEY` (mode dégradé, même discipline que le reste du dépôt pour les
      fonctionnalités IA optionnelles — voir `ai-modules-loader.js`/`aiLoadErrors`).
- [x] **bible-vector-store.js** (nouveau) : wrapper fin sqlite-vec (`vec0` + table
      meta jointe par rowid). Deux comportements NON documentés de sqlite-vec 0.1.9,
      trouvés en testant directement contre l'extension installée (pas dans le
      README, vide) : 1. `INSERT INTO vec_verses(rowid, embedding) VALUES (?, ?)` avec un rowid
      explicite échoue ("Only integers are allowed for primary key values") —
      laisser SQLite assigner le rowid automatiquement, puis l'utiliser comme clé
      explicite dans la table meta normale (elle, sans cette restriction). 2. `... WHERE embedding MATCH ? ORDER BY distance LIMIT ?` (LIMIT en paramètre
      lié) échoue ("A LIMIT or 'k = ?' constraint is required") — le nombre de
      voisins doit être connu au moment de la planification, avant la liaison des
      paramètres. Utiliser `AND k = ?` à la place (reste un paramètre lié, pas
      d'interpolation SQL).
- [x] **scripts/generate-bible-embeddings.js** (nouveau) : script de build, pas
      d'exécution normale de l'app. Réutilise `bible-offline-cache.js` (même source
      bible.helloao.org, aucune clé requise pour cette étape) pour le texte, puis
      embed chaque verset par lots et écrit `models/bible-vector-index.sqlite3`.
      **Pas exécuté dans cette session** : aucun `.env`/clé API dans ce checkout de
      dev (confirmé — `ls .env*` ne montre que `.env.example`). Le fichier généré
      (dizaines de Mo pour ~31 000 versets) est gitignored, jamais commité — livré
      via le pipeline de build/release comme `models/silero_vad.onnx` (mais celui-ci
      reste committé, 2,3 Mo seulement — trop petit pour poser le même problème).
- [x] **bible-semantic-search.js** : `loadIndex()`/`searchByVector()` réécrits pour
      consommer bible-vector-store.js + embedding-provider.js. Contrat externe
      inchangé (`loadIndex()` ne lève jamais, `search()` retombe sur `[]`) — **mode
      dégradé identique à avant ce chantier tant que personne n'a lancé
      `npm run generate-bible-index` avec une vraie clé** : le comportement observable
      de l'app ne change pas encore, seule l'infrastructure est prête.
- [x] **package.json** : `sqlite-vec` ajouté (dépendance native précompilée par
      plateforme, `sqlite-vec-windows-x64` seul retenu dans `build.files` — build
      Windows x64 uniquement, même sélection que onnxruntime-node). Nouveau script
      `generate-bible-index`. `bible-vector-store.js`/`embedding-provider.js` ajoutés
      à `build.files` (`check-build-files.js` les réclamait, requis
      transitivement par server.js via bible-semantic-search.js).
- [x] **Tests** (3 nouveaux fichiers, 35 assertions) : `test-bible-vector-store.js`
      (sqlite-vec réel, vecteurs synthétiques, aucun réseau), `test-embedding-provider.js`
      (Gemini mocké par injection de module — **piège trouvé en écrivant ce test** :
      injecter `node_modules/@google/genai` par chemin construit à la main ne tombe
      PAS sur le fichier réellement chargé par `require('@google/genai')`, ce paquet
      ayant un champ `exports` conditionnel [`require` -> `dist/node/index.cjs`,
      différent de `main`] — un vrai appel réseau est parti avant correction, avec la
      clé "fake-key-for-test" [visible dans les logs de test, jamais une vraie clé].
      Fix : `require.resolve('@google/genai')` en spécificateur nu plutôt qu'un
      chemin reconstruit), `test-bible-semantic-search.js` (bout en bout : mot-clé
      inchangé + vectoriel avec store réel + embedding mocké).
- [x] **Gate** : `npm test` EXIT 0 (35 nouvelles assertions + suite existante),
      `tsc --noEmit` clean, `check-build-files.js` OK, `npm audit` 0 vulnérabilité.
      Lint : les 3 fichiers touchés (hors tests, ignorés par `.eslintignore`) ont
      0 erreur après `--fix` (formatage prettier), warnings `no-console`
      pré-existants uniquement — la dérive de 113 erreurs pré-existantes
      (chantier précédent, server.js et ~30 autres fichiers) n'a ni changé ni été
      traitée ici, hors périmètre.
- [x] Commit `581e7c7`.

**Reste à faire (pas dans ce chantier)** : lancer réellement
`GEMINI_API_KEY=... npm run generate-bible-index` une fois pour produire le fichier
(nécessite une vraie clé + plusieurs minutes de téléchargement/embedding), calibrer
`CONFIG.MAX_DISTANCE` dans bible-semantic-search.js avec de vraies requêtes une fois
l'index réel disponible (valeur de départ 1.0, jamais mesurée contre de vraies
données), et étendre `sermon-qa.js` à sqlite-vec SEULEMENT si une décision produit
similaire est prise explicitement pour ce module (sa politique "gratuit/léger" reste
en vigueur par défaut).

---

### 2026-08-18 — Chantier 4.5 (serveur MCP — TERMINÉ)

Mandat étendu en session : l'utilisateur a explicitement demandé de continuer sans
interruption ("take decisions on your own and push to main on your own"), de couvrir
tout ce que le laptop local ne peut pas faire via la routine cloud déjà créée
(`trig_012th8XiNUZ4DC3JbMy3MsAF`), et de terminer par un audit complet de l'app.
Décisions produit prises seul à partir d'ici (plus de pause AskUserQuestion pour des
choix de portée technique raisonnables) — seul un vrai blocage (clé API manquante,
ambiguïté de sécurité) justifierait encore une pause.

- [x] **mcp/church-ws-client.js** (nouveau) : client WS générique pour serveurs MCP
      — le protocole WS de ce dépôt n'a pas de corrélation requête/réponse ; certaines
      actions répondent en direct au client (`searchBible` -> `searchResults`),
      d'autres seulement via `broadcast()` à TOUS les clients y compris l'émetteur
      (vérifié en lisant `broadcast()` dans server.js — aucune exclusion du socket
      source). `callAction()` résout sur le premier `successActions` ou `error` reçu,
      avec timeout de repli.
- [x] **mcp/server.js** (nouveau) : 9 outils MCP (`@modelcontextprotocol/sdk`,
      transport stdio) — show_verse, hide_verse, search_bible, list_media,
      list_scenes, trigger_media, hide_media, trigger_scene, hide_scene. Se connecte
      au serveur ChurchOverlay déjà en cours comme un client opérateur normal (même
      WS_AUTH_TOKEN) — aucune nouvelle voie d'accès. Périmètre volontairement
      restreint aux actions dont le handler ET le contrat de réponse ont été vérifiés
      en lisant server.js directement : - **apply_theme délibérément absent** : le validateur `applyTheme`
      (validation.js) attend des champs CSS plats (`background`, `accentColor`...)
      alors que les thèmes nommés de theme-loader.js (claire/nuit) produisent des
      variables CSS (`--bg`, `--accent`...) via `themeToCss()` — les deux formats
      ne correspondent PAS, et aucune conversion entre eux n'existe ailleurs dans ce
      dépôt. Exposer un outil dessus sans le vérifier aurait risqué un succès
      silencieux qui n'affiche rien à l'écran. - **emergency_clear absent** : listé dans `OPERATOR_ACTIONS` (permissions,
      server.js ~ligne 1840) mais AUCUN handler `sanitized.action === 'emergencyClear'`
      trouvé dans server.js au moment d'écrire ce fichier — même chose pour
      `obs-switch-scene`/`obs-toggle-recording`. À confirmer dans un chantier dédié
      avant d'exposer un outil MCP dessus. - Destructeurs (delete media/scene) jamais exposés, par principe.
- [x] **Tests** (2 nouveaux fichiers, 37 assertions) : `test-mcp-church-ws-client.js`
      (contre un vrai `ws.Server` local — corrélation succès/erreur/timeout/fermeture
      de connexion en attente, sous-protocole d'authentification transmis),
      `test-mcp-server.js` (les 9 outils, client mocké, chemins succès ET erreur).
- [x] **Bug de flakiness réel trouvé et corrigé** (hors périmètre direct, trouvé en
      poussant `npm test` au vert) : `test/test-reading-mode-ws-actions.js` échouait
      par intermittence (~2 fois sur 5, confirmé en répétant le test isolément) —
      `waitForMessage()` avait un budget de 1500 ms alors que `startReading()`/
      `nextReadingVerse()` déclenchent un vrai aller-retour réseau
      (`bibleLookup.getVerseMultilang()` — `CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD` n'évite
      que le téléchargement complet en arrière-plan, pas cette consultation
      ponctuelle). Porté à 5000 ms : 0 échec sur 11 relances après correctif (contre
      2/5 avant).
- [x] **package.json** : `@modelcontextprotocol/sdk` + `zod` ajoutés (dépendances,
      aucun coût — SDK officiel Anthropic, gratuit). Nouveau script `mcp-server`.
      `mcp/` est un point d'entrée AUTONOME (un opérateur le lance séparément,
      `npm run mcp-server`) — jamais require() par main.js/server.js, donc
      volontairement hors `build.files`/l'exe packagé (confirmé : `check-build-files.js`
      reste vert sans aucune modification).
- [x] **Gate** : `npm test` EXIT 0, `tsc --noEmit` clean, `check-build-files.js` OK,
      `npm audit` 0 vulnérabilité. Lint : 0 erreur après `--fix` (formatage prettier)
      sur les fichiers touchés hors tests (ignorés par eslint, comme d'habitude).
- [x] Commit `68e744a`.

**Reste à faire (pas dans ce chantier)** : vérifier le handler réel de
`emergencyClear`/`obs-switch-scene` dans server.js pour décider s'il manque vraiment
ou s'il est dispatché ailleurs, avant d'exposer ces deux actions comme outils MCP ;
clarifier comment le tableau de bord applique réellement un thème nommé (claire/nuit)
à l'overlay avant d'exposer apply_theme.

**Suite immédiate (même session)** : `emergencyClear`/`obs-switch-scene` élucidés en
creusant `OPERATOR_ACTIONS` — `emergencyClear` n'est QUE dans VOICE_COMMANDS/
KEYBOARD_SHORTCUTS (action-registry.js), jamais dans CLIENT_ACTIONS : ce n'est pas une
action WS envoyable par un client, sa présence dans `OPERATOR_ACTIONS` (permissions WS)
est donc du code mort inoffensif. `obs-switch-scene`/`obs-toggle-recording` : contrôle
OBS passe entièrement par IPC Electron (`window.churchOverlay.obsSwitchScene`, voir
`dashboard/features/obs-scenes.js` + `preload.js`), jamais par WebSocket — confirme
qu'un serveur MCP (transport WS uniquement) ne peut de toute façon PAS les exposer sans
un pont IPC séparé. Les deux entrées dans `OPERATOR_ACTIONS` restent du code mort à
nettoyer un jour (cosmétique, aucun impact fonctionnel), noté pour l'audit de fin de
session plutôt que traité isolément ici.

---

### 2026-08-18 — Chantiers 6b.2 (typage pont IPC) + 6b.1 (circuit breaker Groq) — TERMINÉS

- [x] **global.d.ts** : `window.churchOverlay` entièrement typé (toutes les méthodes de
      preload.js), formes de retour reconstruites en lisant chaque `ipcMain.handle(...)`
      correspondant dans main.js. `checkJs`/`allowJs` restent à `false` dans
      tsconfig.json (dashboard/features/*.js en JS pur) — ce typage n'est donc PAS
      encore appliqué par `tsc --noEmit` (rien à casser), mais donne déjà
      l'autocomplétion VS Code dès maintenant et prépare une vérification réelle si
      §6b.2 migre un jour vers Vite/TS.
- [x] **Flake #2 trouvé et corrigé** (même famille que le premier, hors périmètre
      direct) : `integration-chapter-fallback-delay.js` — marge d'observation
      post-repli (+1200ms) parfois trop courte MÊME AVEC bible-lookup-with-api.js
      entièrement mocké (résolution instante) → précision de `setTimeout` sous la
      charge CPU de toute cette session de tests répétés, pas un vrai bug. Marge portée
      à +3000ms, 5/5 propre en relances répétées après.
- [x] **Constat système** : 6 process `electron.exe` tournent en parallèle sur cette
      machine pendant la session (process tree normal d'UNE app Electron — main +
      renderers + GPU/utilitaires — pas forcément 6 instances séparées). Contribue
      probablement à la charge générale et à la fenêtre de flakiness observée sur
      plusieurs tests aujourd'hui. Non touché (pourrait être l'app réelle de
      l'utilisateur en cours d'usage) — noté pour l'audit de fin de session.
- [x] **groq-wrapper.js — circuit breaker réel** : `transcribeWithFallback()` tentait
      Groq à CHAQUE segment même en panne prolongée — un vrai timeout réseau (pas une
      erreur HTTP rapide) coûtait jusqu'à 5000ms de latence supplémentaire PAR SEGMENT
      pendant toute la durée de la panne. Étend le suivi santé déjà existant
      (`consecutiveGroqFailures`/`lastGroqError`, ajouté pour `/api/health`) : après 5
      échecs consécutifs (seuil DÉLIBÉRÉMENT au-dessus des 3 échecs + 1 succès déjà
      exercés par test-groq-health-tracking.js — contrat existant intégralement
      préservé, revérifié inchangé), circuit ouvert 30s (Groq sauté, repli Deepgram
      direct), puis un essai semi-ouvert retente Groq une fois — succès referme le
      circuit, échec relance le cooldown. Jamais sauté si Deepgram non configuré (seule
      chance de transcrire quand même). `getGroqHealthState()` expose maintenant
      `circuitOpen`/`circuitOpenedAt`, visible sans changement dans `/api/health` via
      `buildHealthReport()` (server.js, champ `asr.groq`).
- [x] **test-groq-circuit-breaker.js** (nouveau, 16 assertions) : fermé/ouvert/semi-ouvert,
      pas d'incrément fantôme du compteur pendant que Groq est sauté, jamais de saut sans
      Deepgram configuré. `Date.now()` mocké pour avancer le cooldown sans attendre 30s
      réelles.
- [x] **Gate** : `npm test` EXIT 0, `tsc --noEmit` clean, `check-build-files.js` OK,
      `npm audit` 0 vulnérabilité, lint 0 erreur sur les fichiers touchés.
- [x] Commit `3f23aaf` (typage + flake), `97c1e83` (circuit breaker).

---

### 2026-08-18 — Chantier 6b.2 (suite e2e — TERMINÉ, régression majeure trouvée)

Mandat élargi confirmé par l'utilisateur en session ("go ahead and execute the different
chantiers" après une fausse alerte "No don't" — voir note ci-dessous) : continuer les
chantiers, décider seul, pousser sur main seul.

- [x] **Découverte** : `npm run test:e2e` (12 specs Playwright, `test/e2e/`) n'est PAS
      dans `npm test` ni dans `.github/workflows/ci.yml` — jamais exécuté par la CI.
      Exécuté manuellement pour la première fois de cette session : **7 specs sur 12
      échouaient**, en silence depuis un temps indéterminé.
- [x] **Cause 1 (7 échecs)** : tous les specs naviguaient via un sélecteur figé
      (`.nav-item[data-sections*="controls,analysis,settings,overlay"]`) qui visait
      l'ANCIENNE structure à 2 onglets ("En Direct"/"Réglages"). Le dashboard a depuis
      été restructuré en 3 espaces (Direct/Préparation/Régie, `dashboard/state.js`),
      chacun avec son propre groupement `data-sections` plus étroit — aucun nav-item
      unique ne correspond plus à cette chaîne combinée. Chaque spec corrigé pour viser
      le bon des 3 groupes réels selon l'élément qu'il teste réellement.
      `dashboard.spec.js` (fumée fondation) supposait aussi `#controls` masqué par
      défaut et `#controls`+`#analysis` visibles ensemble après clic — plus vrai du
      tout post-refonte (`showSectionsFor()` affiche TOUT le groupe de l'item actif dès
      le chargement, `#controls` fait partie du groupe "Direct" par défaut) — réécrit
      pour vérifier le vrai comportement à 3 groupes plutôt que corriger l'ancienne
      hypothèse.
- [x] **Cause 2 (flake supplémentaire, 1/12 selon l'ordre)** : `dashboard-branding.spec.js`
      échouait UNIQUEMENT en suite complète, fiable isolé (`--workers=1` sur ce seul
      fichier : propre). `fullyParallel:false` ne sérialise QUE les tests d'un même
      fichier — Playwright répartit quand même les FICHIERS sur plusieurs workers par
      défaut. Les 12 specs partagent UN SEUL vrai server.js (webServer +
      reuseExistingServer) donc UN SEUL vrai `~/.churchoverlay` réel
      (`test/e2e/start-server.js` n'isole jamais USER_DATA_DIR, faute de workerData —
      déjà noté dans l'en-tête du spec lui-même). Exécuté en parallèle d'un autre spec
      touchant le même serveur, l'ordre des écritures/lectures devenait non
      déterministe. `workers: 1` ajouté à playwright.config.js — 12/12 propre sur DEUX
      exécutions complètes consécutives après (contre 5/12 puis 11/12 selon la cause
      isolée).
- [x] **test/e2e/fixtures.js** (nouveau) : fixture `page` étendue posant le flag
      localStorage `churchoverlay_wizard_seen` — même bug déjà trouvé et corrigé
      isolément pour `test/integration-scene-composer.js` (suite `npm test`, séparée de
      celle-ci), corrigé ici une fois pour les 9 specs qui en avaient besoin plutôt que
      dupliquer un `addInitScript()` par fichier.
- [x] **CI** : `test:e2e` ajouté à `.github/workflows/ci.yml` (installation Chromium +
      exécution), maintenant que la suite est fiable — pour que cette classe de
      régression (silencieuse pendant un redesign entier) soit détectée à l'avenir au
      lieu de pourrir sans bruit.
- [x] **Gate** : `npm test` EXIT 0, `tsc --noEmit` clean, `check-build-files.js` OK,
      `test:e2e` 12/12 sur deux exécutions consécutives, lint 0 erreur (fichiers de test
      ignorés par eslint comme d'habitude).
- [x] Commit `8b95e91`.

**Note "No don't"** : reçu en plein milieu de l'exécution de `dashboard-branding.spec.js`
(qui écrit réellement sur `~/.churchoverlay`, partagé avec toute installation réelle de
l'app — 6 process `electron.exe` tournaient sur la machine à ce moment, voir chantier
précédent). Hypothèse posée explicitement à l'utilisateur (AskUserQuestion) ; réponse :
pas lié, juste "continue les chantiers" — mais le risque de partage d'état avec une
vraie installation reste réel et documenté ci-dessus (cause 2), pas swept sous le tapis
même si ce n'était pas la cause du message. Isolation de USER_DATA_DIR pour toute la
suite de tests (e2e ET `npm test`) reste un chantier séparé, pas entrepris ici (portée
volontairement limitée à rendre la suite déterministe, pas à l'isoler du disque réel).
