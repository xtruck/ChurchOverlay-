/**
 * ============================================================================
 * transcription-corrector.js — AI Post-Processor for Biblical STT
 * ============================================================================
 * Fixes common Speech-to-Text errors on biblical names, places, and terms.
 * Works in two modes:
 *   1. FAST: Dictionary-based replacement (local, instant)
 *   2. SMART: Groq LLM correction for ambiguous cases
 *
 * BULLETPROOF: Handles missing/invalid groq wrapper gracefully.
 * ============================================================================
 */

'use strict';

// -----------------------------------------------------------------------
// Dictionary of common STT errors → correct biblical terms
// -----------------------------------------------------------------------
'use strict';

const { sanitizeForPrompt } = require('./prompt-sanitizer');
const { extractResponseText } = require('./llm-utils');
// AJOUT (Axe 3, phase 2 — hydratation dynamique) : réutilise TEL QUEL le
// moteur de correspondance floue déjà écrit pour les noms de livres
// bibliques (voir son en-tête) — générique par conception (une liste
// d'alias `{book, name}`, aucune connaissance des noms de livres en dur),
// donc directement réutilisable pour un dictionnaire dynamique construit à
// partir du conducteur/recueil de chants. Voir hydrateDynamicDictionary()
// plus bas.
const { correctBookNameFuzzy } = require('./levenshtein');

const CORRECTIONS = {
  'jean le baptiseur': 'Jean-Baptiste',
  'jean baptiseur': 'Jean-Baptiste',
  'jean baptist': 'Jean-Baptiste',
  'saint jean': 'Saint Jean',
  'saint luc': 'Saint Luc',
  'saint marc': 'Saint Marc',
  'saint matthieu': 'Saint Matthieu',
  'saint paul': 'Saint Paul',
  'saint pierre': 'Saint Pierre',
  'saint jacques': 'Saint Jacques',
  'saint andre': 'Saint André',
  'saint thomas': 'Saint Thomas',
  genese: 'Genèse',
  exode: 'Exode',
  levitique: 'Lévitique',
  nombres: 'Nombres',
  deuteronome: 'Deutéronome',
  josue: 'Josué',
  juges: 'Juges',
  ruth: 'Ruth',
  esdras: 'Esdras',
  nehemie: 'Néhémie',
  esther: 'Esther',
  job: 'Job',
  psaumes: 'Psaumes',
  psaume: 'Psaume',
  proverbes: 'Proverbes',
  ecclesiaste: 'Ecclésiaste',
  cantique: 'Cantique',
  cantiques: 'Cantique',
  esaie: 'Ésaïe',
  jeremie: 'Jérémie',
  lamentations: 'Lamentations',
  ezechiel: 'Ézéchiel',
  daniel: 'Daniel',
  osee: 'Osée',
  joel: 'Joël',
  amos: 'Amos',
  abdias: 'Abdias',
  jonas: 'Jonas',
  michee: 'Michée',
  nahum: 'Nahum',
  habacuc: 'Habacuc',
  sophonie: 'Sophonie',
  aggee: 'Aggée',
  zacharie: 'Zacharie',
  malachie: 'Malachie',
  matthieu: 'Matthieu',
  mathieu: 'Matthieu',
  marc: 'Marc',
  luc: 'Luc',
  jean: 'Jean',
  actes: 'Actes',
  romains: 'Romains',
  corinthiens: 'Corinthiens',
  galates: 'Galates',
  ephesiens: 'Éphésiens',
  philippiens: 'Philippiens',
  philipiens: 'Philippiens',
  colossiens: 'Colossiens',
  thessaloniciens: 'Thessaloniciens',
  timothee: 'Timothée',
  tite: 'Tite',
  philemon: 'Philémon',
  hebreux: 'Hébreux',
  jacques: 'Jacques',
  pierre: 'Pierre',
  jude: 'Jude',
  apocalypse: 'Apocalypse',
  moise: 'Moïse',
  abraham: 'Abraham',
  isaac: 'Isaac',
  jacob: 'Jacob',
  joseph: 'Joseph',
  david: 'David',
  salomon: 'Salomon',
  elie: 'Élie',
  elisee: 'Élisée',
  elisée: 'Élisée',
  samuel: 'Samuel',
  saul: 'Saül',
  jonathan: 'Jonathan',
  goliath: 'Goliath',
  bethsheba: 'Bethsabée',
  bethsabee: 'Bethsabée',
  marie: 'Marie',
  'marie madeleine': 'Marie Madeleine',
  lazare: 'Lazare',
  zachee: 'Zachée',
  barnabas: 'Barnabé',
  barnabe: 'Barnabé',
  silas: 'Silas',
  apollos: 'Apollos',
  judas: 'Judas',
  thomas: 'Thomas',
  philippe: 'Philippe',
  andre: 'André',
  barthelemy: 'Barthélemy',
  matthias: 'Matthias',
  simon: 'Simon',
  jesus: 'Jésus',
  christ: 'Christ',
  emmanuel: 'Emmanuel',
  messie: 'Messie',
  jerusalem: 'Jérusalem',
  nazareth: 'Nazareth',
  bethleem: 'Bethléem',
  galilee: 'Galilée',
  judee: 'Judée',
  samarie: 'Samarie',
  damas: 'Damas',
  antioche: 'Antioche',
  corinthe: 'Corinthe',
  ephese: 'Ephèse',
  philippi: 'Philippi',
  colosses: 'Colosses',
  thessalonique: 'Thessalonique',
  rome: 'Rome',
  egypte: 'Égypte',
  babylone: 'Babylone',
  ninive: 'Ninive',
  sodome: 'Sodome',
  gomorrhe: 'Gomorrhe',
  canaan: 'Canaan',
  sinai: 'Sinaï',
  temple: 'Temple',
  synagogue: 'Synagogue',
  'mont des oliviers': 'Mont des Oliviers',
  golgotha: 'Golgotha',
  calvaire: 'Calvaire',
  'jardin de gethsemane': 'Jardin de Gethsémané',
  gethsemane: 'Gethsémané',
  'mer de galilee': 'Mer de Galilée',
  'lac de tiberiade': 'Lac de Tibériade',
  jourdain: 'Jourdain',
  jordan: 'Jourdain',
  peche: 'Péché',
  peches: 'Péchés',
  redemption: 'Rédemption',
  racheter: 'Racheter',
  justification: 'Justification',
  sanctification: 'Sanctification',
  regeneration: 'Régénération',
  conversion: 'Conversion',
  repentance: 'Repentance',
  foi: 'Foi',
  grace: 'Grâce',
  salut: 'Salut',
  delivrance: 'Délivrance',
  guerison: 'Guérison',
  miracle: 'Miracle',
  benediction: 'Bénédiction',
  alliance: 'Alliance',
  covenant: 'Alliance',
  sacrifice: 'Sacrifice',
  expiation: 'Expiation',
  propitiation: 'Propitiation',
  resurrection: 'Résurrection',
  ascension: 'Ascension',
  pentecote: 'Pentecôte',
  paraclet: 'Paraclet',
  consolateur: 'Consolateur',
  'esprit saint': 'Esprit Saint',
  'saint esprit': 'Saint-Esprit',
  'pere eternel': 'Père Éternel',
  'fils unique': 'Fils Unique',
  'parole de dieu': 'Parole de Dieu',
  'parole vivante': 'Parole Vivante',
  evangile: 'Évangile',
  'bonne nouvelle': 'Bonne Nouvelle',
  'nouveau testament': 'Nouveau Testament',
  'ancien testament': 'Ancien Testament',
  'loi de moise': 'Loi de Moïse',
  'dix commandements': 'Dix Commandements',
  'sermon sur la montagne': 'Sermon sur la Montagne',
  beatitudes: 'Béatitudes',
  'fruits de l esprit': "Fruits de l'Esprit",
  'don du spirit': "Don de l'Esprit",
  'armure de dieu': 'Armure de Dieu',
  "fruits de l'esprit": "Fruits de l'Esprit",
};

// -----------------------------------------------------------------------
// FAST mode: Dictionary-based replacement
// -----------------------------------------------------------------------
// CORRECTIF (audit performance) : `correctFast` tourne pour CHAQUE fragment
// transcrit, à l'intérieur du transcriptQueue sérialisé (voir server.js) —
// donc sur le chemin critique de latence de tout le pipeline, y compris les
// centaines de fragments d'un culte qui ne contiennent aucune des ~180
// phrases du dictionnaire. Reconstruire `Object.keys(CORRECTIONS).sort(...)`
// ET recompiler un `new RegExp(...)` par phrase à CHAQUE appel était donc du
// travail pur perdu (le dictionnaire est statique, jamais modifié à
// l'exécution) — précalculé une seule fois au chargement du module.
const FAST_CORRECTION_ENTRIES = Object.keys(CORRECTIONS)
  .sort((a, b) => b.length - a.length)
  .map((phrase) => ({
    correction: CORRECTIONS[phrase],
    regex: new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
  }));

function correctFast(text) {
  let result = text;
  for (const { regex, correction } of FAST_CORRECTION_ENTRIES) {
    result = result.replace(regex, (match) => {
      if (match === match.toUpperCase()) return correction.toUpperCase();
      if (match[0] === match[0].toUpperCase()) return correction;
      return correction.toLowerCase();
    });
  }
  return result;
}

// -----------------------------------------------------------------------
// DYNAMIC mode (Axe 3, phase 2) : dictionnaire construit à l'exécution à
// partir du conducteur (feuille de route) et du recueil de chants actifs —
// contrairement à CORRECTIONS ci-dessus (statique, biblique, figé dans le
// code), ce dictionnaire change à chaque culte, voire en cours de culte
// (voir hydrateDynamicDictionary()). Corrige un nom propre d'intervenant
// ("Jean-Pierre") ou un mot-clé rare de chant que Whisper/Groq déforme —
// aucune chance qu'un dictionnaire statique générique les connaisse à
// l'avance.
//
// CHOIX D'ARCHITECTURE — recherche EXACTE (correctFast, ci-dessus) vs
// recherche FLOUE (Levenshtein, ici) : un nom d'intervenant ou un mot de
// chant n'est JAMAIS mal orthographié de façon prévisible comme les ~180
// entrées de CORRECTIONS (qui capturent des erreurs de transcription
// CONNUES et RÉCURRENTES) — "Jean-Pierre" peut ressortir de l'ASR sous
// N'IMPORTE QUELLE forme proche ("Jean Piere", "Jan-Pierre", "Jean Pier").
// Seule une distance d'édition (Levenshtein) absorbe cette variabilité,
// d'où la réutilisation de correctBookNameFuzzy() (déjà écrit pour
// exactement ce problème sur les noms de livres bibliques, voir
// levenshtein.js) plutôt qu'un simple Object de correspondances exactes.
// -----------------------------------------------------------------------

// Seuil minimal de longueur pour qu'un terme dynamique soit éligible —
// même raisonnement et même valeur que MIN_FUZZY_ALIAS_LENGTH dans
// levenshtein.js : sur un terme court, une tolérance Levenshtein capte
// n'importe quel mot français courant de longueur voisine (faux positifs).
const DYNAMIC_TERM_MIN_LENGTH = 4;
// Mots issus des PAROLES DE CHANT spécifiquement demandent un seuil plus
// haut que les noms propres du conducteur : une phrase de chant contient
// énormément de mots français ordinaires ("toujours", "encore"...) qui ne
// sont ni rares ni utiles comme cible de correction — voir extractFromSongs().
//
// CORRECTIF (trouvé en testant ce chantier) : à 5, "coule" (un verbe de
// paroles tout à fait banal) corrigeait à tort "culte" (mot du quotidien
// d'une église, sans rapport) par simple proximité Levenshtein — un faux
// positif bien réel, pas hypothétique. 7 exclut ce genre de mot courant de
// longueur moyenne tout en gardant les termes réellement distinctifs
// ("Rédempteur", "magnifique"...), qui dépassent presque toujours ce seuil.
const DYNAMIC_SONG_WORD_MIN_LENGTH = 7;
// Filet de sécurité mémoire/perf — un conducteur/recueil de chants légitime
// n'approche jamais cette taille ; correctDynamicFuzzy() tourne sur CHAQUE
// segment transcrit (chemin critique de latence, même raisonnement que le
// commentaire de FAST_CORRECTION_ENTRIES plus haut), donc la taille de ce
// dictionnaire a un coût direct, contrairement à CORRECTIONS qui est figé.
const DYNAMIC_TERM_MAX_ENTRIES = 300;
// Mots français courants à exclure même s'ils dépassent le seuil de
// longueur ci-dessus — liste volontairement courte (le seuil de longueur
// fait déjà le plus gros du travail), complète juste les cas fréquents
// dans un cantique qui passeraient sinon le filtre.
const DYNAMIC_TERM_STOPWORDS = new Set([
  'notre',
  'votre',
  'leurs',
  'toujours',
  'encore',
  'aussi',
  'jamais',
  'quand',
  'comme',
  'alors',
  'ainsi',
  'parce',
  'donc',
  'meme',
  'apres',
  'avant',
  'entre',
  'depuis',
  'pendant',
  'chaque',
  'toutes',
  'tous',
  'cette',
  'celui',
  'celle',
  'quelque',
  'seulement',
]);

let dynamicAliasEntries = []; // {book: 'dynamic', name: <normalisé>}[], triés par longueur décroissante — même forme que correctBookNameFuzzy() attend
let dynamicDisplayByNormalized = new Map(); // normalisé -> forme d'affichage à substituer (casse d'origine du conducteur/recueil)

/**
 * Même normalisation que detector.js#normalize (NFD, diacritiques retirés,
 * minuscules, apostrophes -> espace, espaces multiples réduits) — dupliquée
 * ici volontairement plutôt qu'importée de detector.js : ce module reste
 * sans dépendance vers les gros modules bibliques (BOOKS, bible-lookup...),
 * cohérent avec son en-tête ("BULLETPROOF : gère un wrapper groq manquant")
 * et testable isolément, comme aujourd'hui.
 * @param {string} value
 * @returns {string}
 */
function normalizeDynamicTerm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '') // marques diacritiques combinantes (accents) — équivalent Unicode-propre de /[̀-ͯ]/ utilisé ailleurs dans ce projet (ex. detector.js#normalize)
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Enregistre un terme candidat dans le dictionnaire dynamique EN
 * CONSTRUCTION (`registry`, une Map normalisé -> affichage) — filtré par
 * longueur/stop-mots, dédupliqué (la première forme d'affichage rencontrée
 * gagne), plafonné à DYNAMIC_TERM_MAX_ENTRIES.
 * @param {string} rawTerm - forme d'affichage brute (casse d'origine)
 * @param {Map<string,string>} registry
 * @param {number} minLength
 */
function addDynamicTerm(rawTerm, registry, minLength = DYNAMIC_TERM_MIN_LENGTH) {
  const display = String(rawTerm || '').trim();
  if (!display || registry.size >= DYNAMIC_TERM_MAX_ENTRIES) return;
  const normalized = normalizeDynamicTerm(display);
  if (normalized.length < minLength) return;
  if (DYNAMIC_TERM_STOPWORDS.has(normalized)) return;
  if (!registry.has(normalized)) registry.set(normalized, display);

  // CORRECTIF (trouvé en testant "Jean-Pierre" -> "Jean Piere") : un nom
  // composé garde son trait d'union comme UN SEUL token normalisé
  // ("jean-pierre") — correctBookNameFuzzy() ne compare alors QUE des
  // fenêtres d'UN mot du transcript contre lui, jamais deux. Or l'erreur
  // ASR la plus courante sur un nom composé n'est pas une lettre déformée
  // mais le trait d'union qui disparaît purement et simplement ("Jean
  // Piere", deux mots séparés) — une fenêtre à un seul mot ne peut alors
  // jamais s'en approcher (distance d'édition bien au-dessus du seuil).
  // Enregistre donc AUSSI la variante espacée ("jean pierre", deux tokens)
  // vers le MÊME affichage canonique : correctBookNameFuzzy() essaiera
  // alors une fenêtre à deux mots également, qui absorbe cette erreur.
  if (normalized.includes('-')) {
    const spaced = normalized.replace(/-/g, ' ');
    if (spaced.length >= minLength && !registry.has(spaced)) {
      registry.set(spaced, display);
    }
  }
}

/**
 * Regroupe les mots CAPITALISÉS CONSÉCUTIFS d'un libellé en séquences —
 * approxime un "nom propre" (ex. "Intro par Jean-Pierre Dupont ce matin"
 * -> ["Jean-Pierre Dupont"]) sans dépendre d'un champ structuré "orateur"
 * qui n'existe pas dans le modèle de données de rundown-store.js (un
 * repère n'a qu'un `label` libre — voir son en-tête). Meilleur signal
 * disponible avec les données réellement présentes, pas une supposition
 * sur une structure qui n'existe pas.
 * @param {string} label
 * @returns {string[]}
 */
function extractCapitalizedSequences(label) {
  if (!label) return [];
  const tokens = String(label).split(/\s+/).filter(Boolean);
  const sequences = [];
  let current = [];
  for (const raw of tokens) {
    // Ponctuation en bord de mot retirée ("Dupont," -> "Dupont"), le tiret
    // interne d'un nom composé ("Jean-Pierre") préservé.
    const cleaned = raw.replace(/^[^\p{L}-]+|[^\p{L}-]+$/gu, '');
    if (cleaned && /^[\p{Lu}]/u.test(cleaned)) {
      current.push(cleaned);
    } else {
      if (current.length > 0) sequences.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) sequences.push(current.join(' '));
  return sequences;
}

/**
 * Extrait les noms propres candidats des repères du conducteur (voir
 * extractCapitalizedSequences) — la séquence complète ET chaque mot pris
 * individuellement (robustesse : un ASR qui ne déforme qu'UNE partie d'un
 * nom composé doit quand même être rattrapé).
 * @param {Array<Object>} cues - voir rundown-store.js#listCues
 * @param {Map<string,string>} registry
 */
function extractFromCues(cues, registry) {
  for (const cue of Array.isArray(cues) ? cues : []) {
    if (!cue || typeof cue.label !== 'string') continue;
    for (const phrase of extractCapitalizedSequences(cue.label)) {
      addDynamicTerm(phrase, registry);
      const words = phrase.split(/\s+/);
      if (words.length > 1) {
        for (const word of words) addDynamicTerm(word, registry);
      }
    }
  }
}

/**
 * Extrait les termes candidats des chants : titre et phrases déclencheuses
 * (déjà des chaînes CURATÉES par l'opérateur — voir song-library.js#addSong
 * — ajoutées sans filtre de longueur, elles sont par nature déjà
 * pertinentes), puis les mots des paroles elles-mêmes (non curatés, filtre
 * de longueur plus strict — voir DYNAMIC_SONG_WORD_MIN_LENGTH).
 * @param {Array<Object>} songs - voir song-library.js#getSong (chant COMPLET, avec sections)
 * @param {Map<string,string>} registry
 */
function extractFromSongs(songs, registry) {
  for (const song of Array.isArray(songs) ? songs : []) {
    if (!song) continue;
    addDynamicTerm(song.title, registry, 1);
    for (const phrase of Array.isArray(song.triggerPhrases) ? song.triggerPhrases : []) {
      addDynamicTerm(phrase, registry, 1);
    }
    const lyrics = (Array.isArray(song.sections) ? song.sections : [])
      .map((s) => s && s.text)
      .filter(Boolean)
      .join(' ');
    const words = lyrics.match(/\p{L}+(?:[-’']\p{L}+)*/gu) || [];
    for (const word of words) {
      addDynamicTerm(word, registry, DYNAMIC_SONG_WORD_MIN_LENGTH);
    }
  }
}

/**
 * Reconstruit ENTIÈREMENT le dictionnaire dynamique à partir de l'état
 * ACTUEL du conducteur et du recueil de chants — jamais un ajout cumulatif
 * (un repère supprimé ne doit pas laisser son nom propre traîner
 * indéfiniment). Voir server.js#refreshDynamicCorrections pour l'appelant
 * (initialisation + chaque mutation du conducteur/recueil de chants).
 * @param {Array<Object>} [cues] - rundownStore.listCues()
 * @param {Array<Object>} [songs] - chants COMPLETS (avec sections), pas listSongs() seul (métadonnées uniquement)
 * @returns {{termCount: number}}
 */
function hydrateDynamicDictionary(cues, songs) {
  const registry = new Map();
  extractFromCues(cues, registry);
  extractFromSongs(songs, registry);

  const entries = [...registry.entries()];
  dynamicAliasEntries = entries
    .map(([normalized]) => ({ book: 'dynamic', name: normalized }))
    .sort((a, b) => b.name.length - a.name.length);
  dynamicDisplayByNormalized = new Map(entries);

  return { termCount: dynamicAliasEntries.length };
}

function clearDynamicDictionary() {
  dynamicAliasEntries = [];
  dynamicDisplayByNormalized = new Map();
}

function getDynamicDictionarySize() {
  return dynamicAliasEntries.length;
}

/**
 * Retrouve l'indice de départ de `needleWords` (séquence de mots déjà
 * normalisés) dans `haystackWords` (idem) — needleWords provient TOUJOURS
 * d'une fenêtre RÉELLEMENT extraite de haystackWords par
 * correctBookNameFuzzy() (voir correctDynamicFuzzy() plus bas), la
 * recherche aboutit donc toujours ; le -1 est un filet de sécurité pur,
 * jamais atteint en pratique.
 * @param {string[]} haystackWords
 * @param {string[]} needleWords
 * @returns {number}
 */
function findWordWindow(haystackWords, needleWords) {
  for (let i = 0; i + needleWords.length <= haystackWords.length; i++) {
    let match = true;
    for (let j = 0; j < needleWords.length; j++) {
      if (haystackWords[i + j] !== needleWords[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Applique à `canonicalDisplay` le même motif de casse que correctFast()
 * (voir plus haut) : TOUT MAJUSCULE si le texte original l'était, sinon la
 * forme d'affichage canonique telle quelle (déjà correctement casée —
 * "Jean-Pierre") si le premier caractère original était capitalisé, sinon
 * tout minuscule.
 * @param {string} matchedOriginal
 * @param {string} canonicalDisplay
 * @returns {string}
 */
function applyCasingPattern(matchedOriginal, canonicalDisplay) {
  if (!matchedOriginal) return canonicalDisplay;
  if (matchedOriginal === matchedOriginal.toUpperCase()) return canonicalDisplay.toUpperCase();
  if (matchedOriginal[0] === matchedOriginal[0].toUpperCase()) return canonicalDisplay;
  return canonicalDisplay.toLowerCase();
}

// Plusieurs termes dynamiques peuvent apparaître dans un même segment
// transcrit — filet de sécurité contre une boucle infinie (jamais atteint
// en pratique : le dictionnaire dynamique reste petit et chaque passe
// consomme au moins un terme).
const MAX_DYNAMIC_FUZZY_PASSES = 5;

/**
 * Passe EXACTE, essayée avant la passe floue (voir correctDynamicFuzzy) :
 * un terme dynamique retrouvé sous sa forme normalisée EXACTE dans le
 * transcript (de très loin le cas le plus fréquent — la plupart des
 * sorties ASR perdent seulement les accents/la casse, sans autre erreur)
 * doit être restauré sous sa forme d'affichage canonique.
 *
 * CORRECTIF (trouvé en écrivant les tests de ce chantier — "redempteur"
 * dans le transcript, "Rédempteur" dans les paroles hydratées) :
 * correctBookNameFuzzy() ignore DÉLIBÉRÉMENT une correspondance à distance
 * 0 ("déjà géré par la détection exacte", voir levenshtein.js) — un choix
 * juste pour les noms de LIVRES (matchAgainstAliases()/detectExact() dans
 * detector.js gèrent déjà ce cas séparément) mais FAUX pour ce dictionnaire
 * dynamique, qui n'a justement AUCUNE détection exacte ailleurs. Sans cette
 * passe, le cas le plus courant (accents manquants, aucune autre erreur)
 * n'était jamais corrigé du tout.
 * @param {string[]} words - texte déjà découpé en mots (forme ORIGINALE, pas normalisée)
 * @returns {{startIdx: number, length: number, replacement: string}|null}
 */
function findExactDynamicMatch(words) {
  const normalizedWords = words.map(normalizeDynamicTerm);
  // Alias les plus longs d'abord (dynamicAliasEntries déjà trié ainsi) :
  // une séquence complète ("jean pierre dupont") doit gagner sur un
  // sous-mot isolé qui matcherait aussi, exactement comme
  // FAST_CORRECTION_ENTRIES le fait déjà pour CORRECTIONS.
  for (const { name } of dynamicAliasEntries) {
    const nameWords = name.split(' ');
    for (let i = 0; i + nameWords.length <= normalizedWords.length; i++) {
      let isMatch = true;
      for (let j = 0; j < nameWords.length; j++) {
        if (normalizedWords[i + j] !== nameWords[j]) {
          isMatch = false;
          break;
        }
      }
      if (!isMatch) continue;
      const display = dynamicDisplayByNormalized.get(name) || name;
      const matchedOriginal = words.slice(i, i + nameWords.length).join(' ');
      const replacement = applyCasingPattern(matchedOriginal, display);
      // Rien à faire si le texte original produirait le MÊME résultat une
      // fois la casse appliquée (déjà correct, ou déjà dans la forme que
      // produirait applyCasingPattern) — évite de "corriger" indéfiniment
      // (dans la limite de MAX_DYNAMIC_FUZZY_PASSES) un texte qui ne change
      // en réalité pas.
      if (replacement === matchedOriginal) continue;
      return { startIdx: i, length: nameWords.length, replacement };
    }
  }
  return null;
}

/**
 * Corrige le dictionnaire dynamique sur un transcript : passe EXACTE
 * d'abord (voir findExactDynamicMatch), puis recherche par distance de
 * Levenshtein (voir CHOIX D'ARCHITECTURE plus haut) pour ce qui reste.
 * Appelée par TranscriptionCorrector#correct() APRÈS correctFast() (le
 * dictionnaire statique reste prioritaire pour ses ~180 erreurs connues),
 * AVANT correctSmart() (le LLM voit déjà le nom d'intervenant/mot de chant
 * correct, réduisant son travail et son coût). No-op immédiat (aucun coût)
 * si aucune hydratation n'a eu lieu — voir dynamicAliasEntries.
 * @param {string} text
 * @returns {string}
 */
function correctDynamicFuzzy(text) {
  if (!text || dynamicAliasEntries.length === 0) return text;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return text;

  let changed = false;
  for (let pass = 0; pass < MAX_DYNAMIC_FUZZY_PASSES; pass++) {
    const exactMatch = findExactDynamicMatch(words);
    if (exactMatch) {
      words.splice(exactMatch.startIdx, exactMatch.length, ...exactMatch.replacement.split(/\s+/));
      changed = true;
      continue;
    }

    const normalizedWords = words.map(normalizeDynamicTerm);
    const corrected = correctBookNameFuzzy(normalizedWords.join(' '), dynamicAliasEntries);
    if (!corrected) break;

    const needleWords = corrected.original.split(/\s+/);
    const startIdx = findWordWindow(normalizedWords, needleWords);
    if (startIdx === -1) break; // filet de sécurité, voir findWordWindow()

    const display = dynamicDisplayByNormalized.get(corrected.name) || corrected.name;
    const matchedOriginal = words.slice(startIdx, startIdx + needleWords.length).join(' ');
    const replacement = applyCasingPattern(matchedOriginal, display);

    words.splice(startIdx, needleWords.length, ...replacement.split(/\s+/));
    changed = true;
  }

  return changed ? words.join(' ') : text;
}

// -----------------------------------------------------------------------
// SMART mode: Groq LLM correction
// BULLETPROOF: Returns original text if groq is unavailable
// -----------------------------------------------------------------------
async function correctSmart(text, groqWrapper, onError) {
  // Defensive: check groq wrapper is valid
  if (!groqWrapper || typeof groqWrapper.chatCompletion !== 'function') {
    return text;
  }

  // CORRECTIF (meme classe de bug que looksBiblical() dans semantic-detector.js
  // et detectCommand()/detectMood()) : ce test tournait sur `text`, qui a deja
  // ete passe par correctFast() (ex. "jesus" -> "jesus" avec accent) avant
  // d'arriver ici, alors que ce regex ne contenait QUE des formes sans accent
  // pour "jesus" (et un melange incoherent accent/sans-accent pour le reste :
  // "apotre"/"prophete"/"moise" etc. etaient ecrits AVEC accent). Resultat :
  // le declencheur "jesus" le plus frequent ne matchait plus jamais des que
  // correctFast() avait deja corrige l'accent, desactivant silencieusement la
  // correction LLM pour la quasi-totalite des segments qui en avaient besoin.
  // On de-accentue le texte et on ne teste plus que des formes sans accent.
  const normalizedText = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const hasBiblicalTerm =
    /\b(?:jesus|christ|dieu|seigneur|bible|evangile|apotre|prophete|moise|david|paul|pierre|marie|esprit|temple|eglise|verset|chapitre|psaume|jean|luc|marc|matthieu|romains|corinthiens|galates|ephesiens|philippiens|colossiens|hebreux|jacques|apocalypse)\b/.test(
      normalizedText
    );
  if (!hasBiblicalTerm) return text;

  try {
    // CORRECTIF (audit sécurité — injection de prompt) : on sanitize une
    // COPIE pour le prompt uniquement (`safeText`) — `text` original reste
    // intact car il est retourné tel quel en cas d'échec/rejet plus bas
    // (fallback bulletproof : ne jamais perdre la transcription réelle).
    const safeText = sanitizeForPrompt(text);
    const prompt = `You are a biblical transcription corrector. Fix ONLY obvious biblical name/term errors in this French sermon transcript. Keep everything else identical.

Transcript: "${safeText}"

Rules:
1. Only fix clear STT errors on biblical names, places, or theological terms
2. Do NOT rephrase, summarize, or change the speaker's wording
3. Do NOT add content that wasn't transcribed
4. If unsure, leave the text unchanged
5. Output ONLY the corrected text, nothing else`;

    // CORRECTIF (2026-08-07) : llama-3.1-8b-instant décommissionné par Groq
    // le 16 août 2026 — voir groq-wrapper.js pour le détail de la migration
    // et l'impact sur les quotas gratuits (plafond partagé désormais bas).
    const response = await groqWrapper.chatCompletion(prompt, {
      model: 'openai/gpt-oss-20b',
      temperature: 0.05,
      max_tokens: Math.min(text.length + 50, 500),
    });

    const corrected = extractResponseText(response);
    const similarity = calculateSimilarity(text, corrected);
    if (similarity < 0.7) {
      console.log('[corrector] Smart correction rejected (too different):', similarity);
      return text;
    }

    if (corrected !== text) {
      console.log('[corrector] Smart correction applied');
    }
    return corrected;
  } catch (err) {
    console.warn('[corrector] Smart correction failed:', err.message);
    // AJOUT (A.2 — visibilité des échecs IA) : jusqu'ici uniquement dans la
    // console, invisible côté opérateur. `text` reste retourné inchangé
    // (comportement de repli identique à avant) ; onError() est un
    // observateur pur, jamais dans le chemin de retour.
    if (typeof onError === 'function') {
      try {
        onError(err.message);
      } catch (_) {
        /* observateur best-effort, ne doit jamais faire échouer la correction */
      }
    }
    return text;
  }
}

function calculateSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
  return intersection.size / Math.max(wordsA.size, wordsB.size);
}

// -----------------------------------------------------------------------
// Main API
// -----------------------------------------------------------------------
class TranscriptionCorrector {
  constructor(groqWrapper) {
    this.groq = groqWrapper;
    this.stats = {
      fastCorrections: 0,
      dynamicCorrections: 0,
      smartCorrections: 0,
      skipped: 0,
      errors: 0,
    };
    // AJOUT (A.2 — visibilité des échecs IA) : câblé par server.js (voir
    // ai-modules-loader.js) pour diffuser en WS plutôt que de rester dans
    // la seule console. `null` par défaut : aucun effet si personne ne
    // l'assigne (ex. dans les tests unitaires de ce module).
    this.onError = null;
  }

  async correct(text, mode = 'auto') {
    if (!text || text.length < 3) return text;

    // Always run FAST mode (local, instant)
    let result = correctFast(text);
    if (result !== text) {
      this.stats.fastCorrections++;
    }

    // AJOUT (Axe 3, phase 2 — hydratation dynamique) : toujours exécutée
    // elle aussi (locale, pas d'appel réseau — voir correctDynamicFuzzy()),
    // APRÈS le dictionnaire statique, AVANT le LLM (voir son commentaire
    // "CHOIX D'ARCHITECTURE" plus haut pour le pourquoi de cet ordre).
    const dynamicResult = correctDynamicFuzzy(result);
    if (dynamicResult !== result) {
      this.stats.dynamicCorrections++;
      result = dynamicResult;
    }

    // Run SMART mode only if groq is available and mode allows
    if (
      (mode === 'auto' || mode === 'smart') &&
      this.groq &&
      typeof this.groq.chatCompletion === 'function'
    ) {
      const smartResult = await correctSmart(result, this.groq, (message) => {
        this.stats.errors++;
        this.stats.lastError = { message, at: Date.now() };
        if (typeof this.onError === 'function') this.onError(message);
      });
      if (smartResult !== result) {
        this.stats.smartCorrections++;
        result = smartResult;
      }
    }

    if (result === text) {
      this.stats.skipped++;
    }

    return result;
  }

  getStats() {
    return { ...this.stats };
  }

  resetStats() {
    this.stats = {
      fastCorrections: 0,
      dynamicCorrections: 0,
      smartCorrections: 0,
      skipped: 0,
      errors: 0,
    };
  }

  // AJOUT (Axe 3, phase 2) : délégués d'instance vers l'état module (voir
  // dynamicAliasEntries plus haut) — le dictionnaire dynamique est
  // process-wide (un seul conducteur/recueil de chants actif à la fois,
  // même discipline que CORRECTIONS/correctFast déjà partagés entre toutes
  // les instances), pas un état propre à CHAQUE instance. Exposés ici en
  // plus des exports de module (voir plus bas) pour que server.js puisse
  // appeler `corrector.hydrateDynamicDictionary(...)` sur le handle qu'il a
  // déjà (voir ai-modules-loader.js), sans require() supplémentaire.
  hydrateDynamicDictionary(cues, songs) {
    return hydrateDynamicDictionary(cues, songs);
  }

  getDynamicDictionarySize() {
    return getDynamicDictionarySize();
  }
}

module.exports = {
  TranscriptionCorrector,
  CORRECTIONS,
  correctFast,
  // AJOUT (Axe 3, phase 2 — hydratation dynamique).
  hydrateDynamicDictionary,
  clearDynamicDictionary,
  getDynamicDictionarySize,
  correctDynamicFuzzy,
};
