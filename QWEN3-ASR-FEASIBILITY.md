# Qwen3-ASR — Étude de faisabilité (XTruck / ChurchOverlay)

Contexte : après la mise en place de Silero VAD (local, neuronal) et de
l'architecture de streaming Deepgram, cette étude évalue si Qwen3-ASR peut
tourner **localement**, sur l'environnement cible réel (desktop Windows,
Electron, `onnxruntime-node` déjà présent, `sherpa-onnx-node` testé ici),
avant tout code de production. Rien de ce qui suit n'est intégré au
pipeline (`asr-engine.js` garde `qwen-local` comme emplacement réservé,
inchangé).

**Aucune valeur ci-dessous n'est estimée ou copiée d'une documentation** —
chaque chiffre vient d'une exécution réelle, sur cette machine, avec le
vrai modèle téléchargé et de vrais fichiers audio (voix de synthèse
Windows SAPI en français — voir la section "Limites" pour ce que ça ne
prouve PAS).

## 1. Ce qui a été confondu à tort dans certaines recherches précédentes, clarifié ici

- **Qwen3-ASR** (Alibaba/Qwen team, 0.6B/1.7B, sorti 2026-01-29) — c'est
  celui-ci qui est évalué.
- **PAS** un modèle Qwen3 généraliste (LLM texte), **PAS** Whisper, **PAS**
  un autre moteur ASR de la famille Qwen. Vérifié via le nom exact des
  fichiers de modèle téléchargés (`sherpa-onnx-qwen3-asr-0.6B-int8-...`) et
  le nom du champ de configuration (`qwen3Asr` / `OfflineQwen3ASRModelConfig`,
  visible dans les logs de la vraie librairie au moment du chargement).

## 2. Options évaluées

| #   | Option                                                                                                                 | Support Qwen3-ASR réel                                                                                          | Verdict                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Inférence C pure (`antirez/qwen-asr`)                                                                                  | Oui, dédié à Qwen3-ASR                                                                                          | Nécessite un compilateur C/C++ pour être construit depuis les sources — **aucun** (MSVC/cl.exe, MinGW/gcc, cmake) n'a été trouvé sur cette machine (`where cl.exe/gcc.exe/cmake.exe` → rien). Aucun binaire Windows précompilé trouvé sur les Releases GitHub du projet au moment de la recherche. Écarté pour l'instant — pas construisible ici sans installer un toolchain de compilation. |
| 2   | Export ONNX communautaire (`andrewleech/qwen3-asr-*-onnx`, etc.) + script Python (librosa) pour le prétraitement audio | Oui, plusieurs exports existent                                                                                 | Nécessite Python + librosa au moment de l'inférence dans les pipelines communautaires vus (prétraitement audio fait côté Python) — réintroduit une dépendance Python que ce projet a déjà explicitement retirée (voir README.md, suppression de Whisper local en v0.3.0). Écarté comme option principale.                                                                                    |
| 3   | **sherpa-onnx** (k2-fsa), build **natif** (`sherpa-onnx-node`, addon N-API)                                            | **Oui — support Qwen3-ASR officiel et documenté**, exemple officiel `nodejs-examples/test-offline-qwen3-asr.js` | **RETENU — voir POC ci-dessous.**                                                                                                                                                                                                                                                                                                                                                            |
| 4   | sherpa-onnx, build **WASM** (`sherpa-onnx`, package npm sans suffixe)                                                  | Oui en théorie (même exemple officiel)                                                                          | **Testé, a échoué** ici : `RuntimeError: unreachable` au chargement du modèle 0.6B (705 Mo) — très probablement la limite de mémoire linéaire WASM par défaut d'Emscripten, jamais dimensionnée pour un modèle de cette taille. Écarté.                                                                                                                                                      |
| 5   | Petit worker Python local (packagé avec PyInstaller)                                                                   | Oui (transformers/vLLM officiel)                                                                                | Recherché : PyTorch CPU seul pèse déjà plusieurs centaines de Mo à quelques Go une fois empaqueté (retours d'expérience PyInstaller/PyTorch trouvés en recherche), sans compter les poids du modèle. Réintroduit Python dans l'installeur — écarté comme option principale tant que l'option 3 fonctionne.                                                                                   |
| 6   | Runtime alternatif générique (ONNX Runtime GenAI, llama.cpp-style)                                                     | Pas de support Qwen3-ASR trouvé spécifiquement                                                                  | Non retenu — rien d'aussi mûr que sherpa-onnx pour CE modèle précis.                                                                                                                                                                                                                                                                                                                         |

## 3. POC réalisé — sherpa-onnx (build natif), modèle 0.6B int8

**Isolé du pipeline de production** (`poc-qwen3-asr/`, `package.json`
séparé, jamais importé par `main.js`/`server.js`, exclu du build
electron-builder). Étapes réellement exécutées :

1. `npm view sherpa-onnx-node` → package réel, publié 2026-07-07 (maintenu
   activement), licence Apache-2.0, `optionalDependencies` incluant
   `sherpa-onnx-win-x64` (binaire natif Windows x64 prêt à l'emploi, ~23 Mo
   décompressé).
2. `npm install sherpa-onnx-node` puis `require()` → **chargé avec succès**
   sur cette machine Windows, sans compilation, sans script post-install
   requis.
3. Téléchargement du modèle réel : `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`
   depuis les Releases GitHub officielles de k2-fsa/sherpa-onnx (URL
   confirmée par une requête HTTP réelle avant téléchargement, pas
   supposée) — **878,7 Mo** compressés.
4. Extraction → **705 Mo** sur disque (`conv_frontend.onnx` 44 Mo,
   `encoder.int8.onnx` 182 Mo, `decoder.int8.onnx` 494 Mo, + tokenizer).
5. Génération de deux échantillons audio français **réels** (voix de
   synthèse Windows SAPI, voix "Hortense" — PAS une voix humaine, voir
   limites) : les deux phrases exactes demandées, ré-échantillonnées à
   16 kHz mono PCM16 pour correspondre au format déjà utilisé par
   `audio-capture.js`.
6. Exécution du script officiel (adapté depuis l'exemple
   `test-offline-qwen3-asr.js` du dépôt sherpa-onnx) contre ces deux
   fichiers, avec mesure réelle du temps de chargement, de la latence de
   décodage, de la RAM (`process.memoryUsage().rss`) et du CPU
   (`process.cpuUsage()`).

### Résultats réels (numThreads=2, CPU de cette machine, aucune estimation)

| Mesure                                                                              | Valeur mesurée                                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| RAM avant chargement du modèle                                                      | 35 Mo                                                                                                    |
| **Temps de chargement du modèle**                                                   | **6296–6847 ms** (2 exécutions)                                                                          |
| RAM après chargement                                                                | 1047–1068 Mo                                                                                             |
| **Décodage — "Nous allons lire Jean chapitre trois verset seize."** (3,72s d'audio) | **2132–2186 ms**, CPU user ≈4234ms/2 threads                                                             |
| Texte obtenu                                                                        | `"Nous allons lire Jean chapitre trois verset seize."` — **exact**                                       |
| **Décodage — "Premier Corinthiens chapitre treize verset quatre."** (4,01s d'audio) | **2242–2319 ms**, CPU user ≈4656ms/2 threads                                                             |
| Texte obtenu                                                                        | `"Premier Corinthe un chapitre treize verset quatre."` — **"Corinthiens" mal transcrit** ("Corinthe un") |
| RAM après les deux décodages                                                        | 1224–1249 Mo                                                                                             |

**Facteur temps réel du décodage seul** : ≈0,55–0,58× (décoder ~4s d'audio
prend ~2,2s) — CPU-bound mais plus rapide que la durée de l'audio, pas
instantané.

### Ce que ça N'EST PAS : pas de streaming au sens Deepgram

Contrairement à Deepgram WebSocket (résultats `partial` en continu pendant
que la phrase se construit), **Qwen3-ASR via sherpa-onnx utilise
`OfflineRecognizer`** — l'exemple officiel n'a pas de variante
`OnlineRecognizer` pour ce modèle. Cohérent avec l'architecture (un
transformeur encodeur-décodeur de type LLM, pas une architecture CTC/
transducer nativement incrémentale comme zipformer/paraformer, que
sherpa-onnx sait streamer). Concrètement, l'intégration réaliste serait :

```
VAD (Silero, déjà en place) détecte fin de phrase
        ↓
segment audio complet (comme le chemin Groq actuel)
        ↓
Qwen3-ASR décode le segment entier (~0,55-0,58× la durée de l'audio)
        ↓
UN SEUL résultat (pas de partial) — pas de "asrFirstPartial" possible
```

Donc : un remplacement local du chemin **Groq batch actuel**, pas du
chemin streaming Deepgram construit à la phase précédente.

## 4. Limites — ce qui n'a PAS été vérifié

- **Voix de synthèse, pas une voix humaine réelle.** Les deux échantillons
  ont été générés par le moteur SAPI de Windows (voix "Hortense"), pas
  enregistrés depuis un vrai microphone en conditions de culte (écho,
  bruit de fond, accent, débit de parole variable). Le résultat presque
  parfait ("Corinthiens" mal transcrit une fois) est encourageant mais
  **ne prouve pas** la robustesse en conditions réelles.
- **Un seul cœur/une seule machine testée.** Pas de comparaison avec
  `numThreads=1` (charge CPU plus faible mais latence probablement plus
  haute), ni avec un poste moins puissant qu'un ordinateur de développement.
- **Build WASM non fonctionnel ici** — pourrait être un problème de
  configuration mémoire corrigible (recompiler avec plus de mémoire
  linéaire allouée), pas nécessairement une impossibilité définitive ; pas
  creusé plus loin une fois le chemin natif confirmé viable.
- **1.7B non testé** — seul le 0.6B a un modèle sherpa-onnx publié au
  moment de cette étude (le 1.7B est une demande de fonctionnalité encore
  ouverte sur le dépôt sherpa-onnx).
- **Aucun test de montée en charge** (plusieurs décodages consécutifs sur
  une session de plusieurs heures, fuite mémoire éventuelle).

## 5. Décision

### OPTION A — Recommandée si vous voulez avancer maintenant

**sherpa-onnx, build natif (`sherpa-onnx-node`), modèle
`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`, comme repli OFFLINE
supplémentaire pour le chemin Groq batch — PAS comme remplacement du
streaming Deepgram.**

Pourquoi : c'est la seule option qui a réellement fonctionné dans ce test,
sans Python, sans compilation, avec un binaire Windows x64 prêt à l'emploi
et un paquet activement maintenu (dernière publication : il y a un mois).
Elle apporte une vraie capacité **offline** (aucun appel réseau), ce que ni
Groq ni Deepgram ne peuvent offrir.

Compromis à accepter consciemment :

- **+705 Mo** de modèle à distribuer (téléchargement séparé au premier
  lancement recommandé, pas dans l'installeur de base — voir stratégie de
  packaging ci-dessous) — un ordre de grandeur au-dessus de tout ce que ce
  projet a ajouté jusqu'ici (Silero VAD ne pesait que 2,3 Mo).
  **Ceci reverse partiellement la décision v0.3.0 du projet de garder
  l'installeur léger sans dépendance locale de transcription lourde** —
  décision consciente à prendre, pas une simple continuité technique.
- **~1,2 Go de RAM** en plus pendant que le modèle est chargé (à ajouter à
  l'empreinte déjà mesurée d'Electron + Silero VAD).
- **~2,2s de latence de décodage** par phrase — plus lent qu'un
  "premier mot" Deepgram streaming, mais fonctionne sans Internet.
- **Pas de streaming incrémental** — un remplacement de Groq, pas de
  Deepgram.

### OPTION B — Possible avec compromis significatifs

Télécharger le modèle Qwen3-ASR **1.7B** dès qu'un export sherpa-onnx sera
publié (meilleure qualité de transcription, demande déjà ouverte sur le
dépôt), au prix d'un modèle encore plus gros et d'une latence de décodage
plus longue — non testable maintenant, aucun export disponible.

### OPTION C — Non recommandée pour l'instant

Worker Python local (PyInstaller + transformers) ou export ONNX
communautaire nécessitant Python à l'exécution : réintroduit une
dépendance Python que ce projet a explicitement retirée, pour un gain
non démontré par rapport à l'Option A qui fonctionne déjà sans Python.

## 6. Si vous choisissez d'avancer (Option A) — stratégie recommandée, NON implémentée

1. **Dépendances exactes** : `sherpa-onnx-node` (npm, ~23 Mo pour le
   binaire `sherpa-onnx-win-x64`) — beaucoup plus léger que
   `onnxruntime-node` déjà présent (déjà réduit à ~62 Mo pour Windows
   seul dans `package.json`).
2. **Modèle** : téléchargé à la demande depuis l'application (pas inclus
   dans l'installeur `.exe` de base) — écrit dans `userData` (comme les
   clés API, voir `features-store.js`), avec une barre de progression et
   une vérification de checksum avant utilisation. Évite d'alourdir
   l'installeur de base pour les utilisateurs qui n'activent jamais ce
   mode.
3. **Taille d'installeur attendue** : +~23 Mo (le runtime seul, comme
   `onnxruntime-node`) si le modèle est téléchargé séparément ; +~730 Mo si
   le modèle était inclus dans l'installeur (déconseillé).
4. **RAM attendue** : +~1,2 Go pendant que ce provider est actif (mesuré).
5. **CPU attendu** : pic de plusieurs centaines de % (multi-cœur) pendant
   quelques secondes par phrase décodée, pas une charge de fond continue.
6. **Streaming** : non — décodage par segment complet (VAD Silero existant
   → segment → décodage), UN SEUL résultat par segment.
7. **Offline** : oui, complètement, une fois le modèle téléchargé.
8. **Point d'intégration le plus sûr** : `asr-engine.js`, provider
   `'qwen-local'` déjà réservé — remplacerait la branche qui lève
   actuellement une erreur explicite, en réutilisant EXACTEMENT le même
   flux que `transcribeSegment()` (segment WAV déjà écrit par
   `audio-capture.js`) : aucun changement nécessaire à `audio-capture.js`
   ni `server.js` pour cette intégration minimale (contrairement au
   streaming Deepgram, qui a demandé une nouvelle architecture PCM
   continue).
9. **Risques** : taille de téléchargement pour des connexions d'église
   parfois limitées ; RAM cumulée si Silero VAD + Qwen3-ASR + Electron
   tournent en même temps sur un poste modeste ; robustesse non vérifiée
   sur voix humaine réelle/bruit de fond.

## 7. Prochaines étapes recommandées (si vous donnez le feu vert)

1. Tester avec de vrais enregistrements humains (idéalement un extrait
   réel de culte) avant toute intégration en production.
2. Mesurer sur un poste représentatif d'un ordinateur d'église (pas un
   poste de développement).
3. Si validé : implémenter le provider `qwen-local` dans `asr-engine.js`
   (chemin le plus simple, voir §6.8), avec téléchargement à la demande du
   modèle et repli automatique sur Groq si le modèle n'est pas encore
   téléchargé — même philosophie de repli que Silero VAD et Deepgram
   streaming.

---

_Ce document reflète des mesures réelles effectuées le 2026-08-10 sur
l'environnement de développement de ce projet. Le POC (`poc-qwen3-asr/`)
reste dans le dépôt (code seulement, modèle exclu via `.gitignore`) pour
reproductibilité._
