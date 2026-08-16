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

*(chronologique, plus récent en bas de chaque section)*

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
| Mode | Score | FP | notes |
|------|-------|----|-------|
| fr | 31/39 (79,5 %) | 0/8 | +2 sur baseline 29/37 (items O1/O2 A.3 passent) |
| multi | 33/39 (84,6 %) | 0/8 | +2 sur baseline 30/37 (items O1/O2 A.3 passent) |

Échecs fr : A2 (artefact banc), B2 (ASR EN en mode FR), D3 (Philémon — ASR),
D5 (Sophonie — endpointing), N2 (Osée — ASR), H1/H2 (langue mixte — A.2),
I2 (noyée — ASR EN en FR).

Échecs multi : A3 (Jean trois seize — ASR), B2 (EN ASR), D4 (Aggée — ASR),
E2 (Nombres — ASR), H2 (langue mixte — A.2), K3 (Actes — ASR).

**Preuve de correctif A.3** (log bench) : `"Jean 14, le verset 6."` →
`[server] Appel direct (référence explicite, avant correction IA) : jean 14, le verset 6`
→ `[server] Displayed: Jean 14:6` (et non jean 14:1 FAUX). Régression : aucune.
