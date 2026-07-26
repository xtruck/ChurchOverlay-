/**
 * ============================================================================
 *  bible-lookup-with-api.js — Récupération du texte des versets bibliques
 * ----------------------------------------------------------------------------
 *  CORRECTIF (audit) :
 *    Les deux anciens fournisseurs ("genuinegospel.com" et le dump JSON
 *    "aruljohn/bible-api" via jsdelivr) répondent tous les deux 404 — ils
 *    n'existent plus / n'ont jamais existé à ces URLs. Résultat : TOUTE
 *    recherche de verset échouait, en silence, avec un message générique
 *    "Could not fetch verse from any provider". C'était le bug le plus
 *    critique de l'appli : la fonctionnalité principale (afficher le texte
 *    du verset) ne marchait jamais, même avec une bonne connexion internet.
 *
 *  NOUVEAU FOURNISSEUR (vérifié fonctionnel au moment de l'audit) :
 *    https://bible.helloao.org — API JSON gratuite, sans clé, sans limite
 *    de débit annoncée, qui sert notamment la traduction française
 *    "Louis Segond 1910" (id = fra_lsg). Un chapitre entier est réutilisé
 *    (mis en cache) pour toute demande de verset dans ce chapitre, donc une
 *    lecture suivie ne fait qu'un seul appel réseau par chapitre.
 *
 *  DEUXIÈME FOURNISSEUR (ajouté pour redondance, en secours de helloao) :
 *    https://api.getbible.net/v2/ls1910/{livre}/{chapitre}.json — API JSON
 *    gratuite, sans clé, servant elle aussi la Segond 1910 en français
 *    (traduction "ls1910"), mais hébergée par une infrastructure totalement
 *    indépendante de bible.helloao.org. Si l'un des deux tombe, l'autre
 *    prend le relais automatiquement (BIBLE_PROVIDERS essaie chaque
 *    fournisseur dans l'ordre). Le texte ls1910 embarque des numéros de
 *    concordance Strong ; extractGetbibleVerseText() les retire au mieux
 *    (chiffres collés directement à un mot, sans espace). Si un résidu
 *    numérique s'affiche un jour à l'écran via ce fournisseur, c'est ce
 *    nettoyage qu'il faut affiner.
 *
 *  Si ces fournisseurs tombent à leur tour, il suffit d'ajouter un nouvel
 *  objet dans BIBLE_PROVIDERS (voir la forme attendue de
 *  fetchChapter/parseVerse) — le code essaie chaque fournisseur dans l'ordre
 *  jusqu'à ce qu'un réponde.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Cache du verset final déjà assemblé (clé -> { reference, text, provider })
const cache = new Map();
// Cache des chapitres bruts déjà téléchargés, pour éviter de re-télécharger
// tout un chapitre à chaque verset demandé dedans.
// clé: `${providerName}:${bookCode}:${chapter}` -> données JSON du chapitre
const chapterCache = new Map();

// -----------------------------------------------------------------------
// AJOUT (audit — inspiré de Rhema) : cache de versets PERSISTANT SUR DISQUE.
// -----------------------------------------------------------------------
// Rhema embarque une base SQLite complète de 10 traductions pour ne
// dépendre d'aucune API pendant un culte. Ce n'est pas l'architecture de
// ChurchOverlay (qui reste volontairement léger et cloud-first pour la
// transcription elle-même) — mais on peut récupérer une bonne partie du
// bénéfice concret sans base complète : chaque verset RÉELLEMENT consulté
// est écrit sur disque, et reste disponible aux services suivants (ou dans
// la même soirée si la connexion coupe un instant) même après redémarrage
// de l'app, sans attendre une nouvelle réponse réseau. Ce n'est PAS du
// hors-ligne complet (un verset jamais consulté avant reste indisponible
// sans réseau), mais ça couvre le cas réel le plus fréquent : les versets
// récurrents d'un culte à l'autre.
let diskCachePath = null;
let diskCacheDirty = false;
let diskCacheSaveTimer = null;

function setCacheDir(dir) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`[bible-lookup] Impossible de créer le dossier de cache (${dir}) : ${err.message}`);
    return;
  }
  diskCachePath = path.join(dir, 'verse-cache.json');
  loadDiskCache();
}

function loadDiskCache() {
  if (!diskCachePath) return;
  try {
    const raw = fs.readFileSync(diskCachePath, 'utf8');
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      for (const [key, value] of entries) cache.set(key, value);
      console.log(`[bible-lookup] Cache disque chargé : ${entries.length} verset(s).`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[bible-lookup] Cache disque illisible, ignoré (${err.message}).`);
    }
  }
}

// Écriture différée (debounce 2s) : évite une écriture disque à CHAQUE
// verset pendant une lecture suivie rapide (plusieurs versets/minute).
function scheduleDiskCacheSave() {
  diskCacheDirty = true;
  if (diskCacheSaveTimer) return;
  diskCacheSaveTimer = setTimeout(() => {
    diskCacheSaveTimer = null;
    if (!diskCacheDirty || !diskCachePath) return;
    diskCacheDirty = false;
    try {
      // On plafonne à 500 versets sur disque (largement suffisant pour des
      // années de cultes) pour ne pas laisser grossir le fichier sans fin.
      const entries = Array.from(cache.entries()).slice(-500);
      fs.writeFileSync(diskCachePath, JSON.stringify(entries), 'utf8');
    } catch (err) {
      console.warn(`[bible-lookup] Échec écriture cache disque : ${err.message}`);
    }
  }, 2000);
}

// Codes de livre au format USFM à 3 lettres utilisés par bible.helloao.org.
// Ce sont EXACTEMENT les mêmes codes que ceux renvoyés par
// GET https://bible.helloao.org/api/fra_lsg/books.json
const HELLOAO_BOOK_CODES = {
  genese: 'GEN', exode: 'EXO', levitique: 'LEV', nombres: 'NUM',
  deuteronome: 'DEU', josue: 'JOS', juges: 'JDG', ruth: 'RUT',
  '1samuel': '1SA', '2samuel': '2SA', '1rois': '1KI', '2rois': '2KI',
  '1chroniques': '1CH', '2chroniques': '2CH', esdras: 'EZR', nehemie: 'NEH',
  esther: 'EST', job: 'JOB', psaumes: 'PSA', proverbes: 'PRO',
  ecclesiaste: 'ECC', cantique: 'SNG', esaie: 'ISA', jeremie: 'JER',
  lamentations: 'LAM', ezechiel: 'EZK', daniel: 'DAN', osee: 'HOS',
  joel: 'JOL', amos: 'AMO', abdias: 'OBA', jonas: 'JON', michee: 'MIC',
  nahum: 'NAM', habacuc: 'HAB', sophonie: 'ZEP', aggee: 'HAG',
  zacharie: 'ZEC', malachie: 'MAL', matthieu: 'MAT', marc: 'MRK',
  luc: 'LUK', jean: 'JHN', actes: 'ACT', romains: 'ROM',
  '1corinthiens': '1CO', '2corinthiens': '2CO', galates: 'GAL',
  ephesiens: 'EPH', philippiens: 'PHP', colossiens: 'COL',
  '1thessaloniciens': '1TH', '2thessaloniciens': '2TH',
  '1timothee': '1TI', '2timothee': '2TI', tite: 'TIT', philemon: 'PHM',
  hebreux: 'HEB', jacques: 'JAS', '1pierre': '1PE', '2pierre': '2PE',
  '1jean': '1JN', '2jean': '2JN', '3jean': '3JN', jude: 'JUD',
  apocalypse: 'REV',
};

// Numérotation des livres (1-66, ordre protestant standard) utilisée par
// l'API getBible v2 pour la traduction ls1910 — vérifiée le 24/07/2026 via
// https://api.getbible.net/v2/ls1910/books.json. Mêmes clés que
// HELLOAO_BOOK_CODES ci-dessus pour rester interchangeable.
const GETBIBLE_BOOK_NUMBERS = {
  genese: 1, exode: 2, levitique: 3, nombres: 4, deuteronome: 5, josue: 6,
  juges: 7, ruth: 8, '1samuel': 9, '2samuel': 10, '1rois': 11, '2rois': 12,
  '1chroniques': 13, '2chroniques': 14, esdras: 15, nehemie: 16, esther: 17,
  job: 18, psaumes: 19, proverbes: 20, ecclesiaste: 21, cantique: 22,
  esaie: 23, jeremie: 24, lamentations: 25, ezechiel: 26, daniel: 27,
  osee: 28, joel: 29, amos: 30, abdias: 31, jonas: 32, michee: 33,
  nahum: 34, habacuc: 35, sophonie: 36, aggee: 37, zacharie: 38,
  malachie: 39, matthieu: 40, marc: 41, luc: 42, jean: 43, actes: 44,
  romains: 45, '1corinthiens': 46, '2corinthiens': 47, galates: 48,
  ephesiens: 49, philippiens: 50, colossiens: 51, '1thessaloniciens': 52,
  '2thessaloniciens': 53, '1timothee': 54, '2timothee': 55, tite: 56,
  philemon: 57, hebreux: 58, jacques: 59, '1pierre': 60, '2pierre': 61,
  '1jean': 62, '2jean': 63, '3jean': 64, jude: 65, apocalypse: 66,
};

const DISPLAY_NAMES = {
  genese: 'Genèse', exode: 'Exode', levitique: 'Lévitique', nombres: 'Nombres',
  deuteronome: 'Deutéronome', josue: 'Josué', juges: 'Juges', ruth: 'Ruth',
  '1samuel': '1 Samuel', '2samuel': '2 Samuel', '1rois': '1 Rois', '2rois': '2 Rois',
  '1chroniques': '1 Chroniques', '2chroniques': '2 Chroniques', esdras: 'Esdras',
  nehemie: 'Néhémie', esther: 'Esther', job: 'Job', psaumes: 'Psaumes',
  proverbes: 'Proverbes', ecclesiaste: 'Ecclésiaste', cantique: 'Cantique des cantiques',
  esaie: 'Ésaïe', jeremie: 'Jérémie', lamentations: 'Lamentations', ezechiel: 'Ézéchiel',
  daniel: 'Daniel', osee: 'Osée', joel: 'Joël', amos: 'Amos', abdias: 'Abdias',
  jonas: 'Jonas', michee: 'Michée', nahum: 'Nahum', habacuc: 'Habacuc',
  sophonie: 'Sophonie', aggee: 'Aggée', zacharie: 'Zacharie', malachie: 'Malachie',
  matthieu: 'Matthieu', marc: 'Marc', luc: 'Luc', jean: 'Jean', actes: 'Actes',
  romains: 'Romains', '1corinthiens': '1 Corinthiens', '2corinthiens': '2 Corinthiens',
  galates: 'Galates', ephesiens: 'Éphésiens', philippiens: 'Philippiens',
  colossiens: 'Colossiens', '1thessaloniciens': '1 Thessaloniciens',
  '2thessaloniciens': '2 Thessaloniciens', '1timothee': '1 Timothée',
  '2timothee': '2 Timothée', tite: 'Tite', philemon: 'Philémon', hebreux: 'Hébreux',
  jacques: 'Jacques', '1pierre': '1 Pierre', '2pierre': '2 Pierre', '1jean': '1 Jean',
  '2jean': '2 Jean', '3jean': '3 Jean', jude: 'Jude', apocalypse: 'Apocalypse',
};

// Noms anglais officiels (utilisés pour l'affichage en mode 'en' seul).
const DISPLAY_NAMES_EN = {
  genese: 'Genesis', exode: 'Exodus', levitique: 'Leviticus', nombres: 'Numbers',
  deuteronome: 'Deuteronomy', josue: 'Joshua', juges: 'Judges', ruth: 'Ruth',
  '1samuel': '1 Samuel', '2samuel': '2 Samuel', '1rois': '1 Kings', '2rois': '2 Kings',
  '1chroniques': '1 Chronicles', '2chroniques': '2 Chronicles', esdras: 'Ezra',
  nehemie: 'Nehemiah', esther: 'Esther', job: 'Job', psaumes: 'Psalms',
  proverbes: 'Proverbs', ecclesiaste: 'Ecclesiastes', cantiques: 'Song of Solomon',
  esaie: 'Isaiah', jeremie: 'Jeremiah', lamentations: 'Lamentations',
  ezechiel: 'Ezekiel', daniel: 'Daniel', osee: 'Hosea', joel: 'Joel', amos: 'Amos',
  abdias: 'Obadiah', jonas: 'Jonah', michee: 'Micah', nahum: 'Nahum',
  habacuc: 'Habakkuk', sophonie: 'Zephaniah', aggee: 'Haggai', zacharie: 'Zechariah',
  malachie: 'Malachi', matthieu: 'Matthew', marc: 'Mark', luc: 'Luke', jean: 'John',
  actes: 'Acts', romains: 'Romans', '1corinthiens': '1 Corinthians',
  '2corinthiens': '2 Corinthians', galates: 'Galatians', ephesiens: 'Ephesians',
  philippiens: 'Philippians', colossiens: 'Colossians',
  '1thessaloniciens': '1 Thessalonians', '2thessaloniciens': '2 Thessalonians',
  '1timothee': '1 Timothy', '2timothee': '2 Timothy', tite: 'Titus',
  philemon: 'Philemon', hebreux: 'Hebrews', jacques: 'James',
  '1pierre': '1 Peter', '2pierre': '2 Peter', '1jean': '1 John', '2jean': '2 John',
  '3jean': '3 John', jude: 'Jude', apocalypse: 'Revelation',
};

function label({ book, chapter, verseStart, verseEnd }, lang = 'fr') {
  const dict = lang === 'en' ? DISPLAY_NAMES_EN : DISPLAY_NAMES;
  const name = dict[book] || DISPLAY_NAMES[book] || book;
  return !verseStart
    ? `${name} ${chapter}`
    : `${name} ${chapter}:${verseStart}${verseEnd && verseEnd !== verseStart ? `-${verseEnd}` : ''}`;
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'ChurchOverlay/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Fournisseur : bible.helloao.org --------------------------------------

// Traductions disponibles, par langue. Chaque entrée référence l'ID
// spécifique à CHAQUE fournisseur séparément (helloaoId / getbibleId) car
// un même "choix logique" (ex: Darby) peut être servi par un fournisseur et
// pas l'autre — fetchFromProvider() essaie chaque fournisseur dans l'ordre
// et celui qui n'a pas cette traduction échoue proprement (id absent),
// laissant le fournisseur suivant prendre le relais.
//  - lsg   = Louis Segond 1910 (FR, domaine public) — helloao ET getbible
//  - darby = Darby (FR, domaine public, révision 2024) — getbible SEULEMENT
//    (absente de helloao ; AJOUT (audit — inspiré de Rhema, changement de
//    traduction à la voix) : avant, une seule traduction française
//    existait, ce qui rendait un changement de traduction sans objet — deux
//    choix réels suffisent pour que la fonctionnalité ait un sens.)
//  - kjv/web/asv (EN, domaine public) — helloao seulement
// NB: NIV, ESV, Segond 21, Semeur NE SONT PAS distribuables via API
// publique (licence), on propose donc uniquement des traductions libres de
// droits, françaises comme anglaises.
const AVAILABLE_TRANSLATIONS = {
  fr: {
    lsg: { helloaoId: 'fra_lsg', getbibleId: 'ls1910', label: 'Louis Segond 1910' },
    darby: { helloaoId: null, getbibleId: 'darby', label: 'Darby' },
  },
  en: {
    kjv: { helloaoId: 'eng_kjv', getbibleId: null, label: 'King James Version' },
    web: { helloaoId: 'eng_web', getbibleId: null, label: 'World English Bible (moderne)' },
    asv: { helloaoId: 'eng_asv', getbibleId: null, label: 'American Standard Version' },
  },
};

// Sélection courante (mutable via setTranslation) — stocke le CODE logique
// (ex: 'lsg', 'darby'), pas un id spécifique à un fournisseur.
const currentTranslation = { fr: 'lsg', en: 'kjv' };

function getTranslationMeta(lang) {
  const dict = AVAILABLE_TRANSLATIONS[lang] || AVAILABLE_TRANSLATIONS.fr;
  const code = currentTranslation[lang] || Object.keys(dict)[0];
  return dict[code] || Object.values(dict)[0];
}

// Conservée pour compatibilité (server.js l'utilise pour les diagnostics) :
// renvoie l'id helloao de la traduction courante, si ce fournisseur la sert.
function getTranslationId(lang) {
  const meta = getTranslationMeta(lang);
  return meta ? meta.helloaoId : null;
}

function setTranslation(lang, code) {
  const dict = AVAILABLE_TRANSLATIONS[lang];
  if (!dict) throw new Error(`Langue inconnue: ${lang}`);
  if (!dict[code]) throw new Error(`Traduction inconnue pour ${lang}: ${code}`);
  currentTranslation[lang] = code;
  // On invalide le cache pour éviter que d'anciens versets d'une autre
  // traduction persistent après un changement.
  cache.clear();
  chapterCache.clear();
  // AJOUT (audit — cache persistant) : sans ça, le fichier disque garderait
  // les versets de l'ANCIENNE traduction et les re-servirait après un
  // redémarrage, malgré le changement — silencieusement incohérent.
  if (diskCachePath) {
    scheduleDiskCacheSave();
  }
  return code;
}

function listTranslations() {
  const out = {};
  for (const lang of Object.keys(AVAILABLE_TRANSLATIONS)) {
    const activeCode = currentTranslation[lang];
    out[lang] = Object.entries(AVAILABLE_TRANSLATIONS[lang]).map(([code, meta]) => ({
      code, label: meta.label, active: code === activeCode,
    }));
  }
  return out;
}

async function helloaoFetchChapter(reference, lang = 'fr') {
  const bookCode = HELLOAO_BOOK_CODES[reference.book];
  if (!bookCode) {
    throw new Error(`Livre inconnu pour helloao: ${reference.book}`);
  }
  const translation = getTranslationId(lang);
  // AJOUT (audit — traductions multiples) : certaines traductions (ex.
  // Darby) ne sont servies QUE par getbible, pas par helloao. On échoue
  // clairement ici plutôt que d'interroger helloao avec un id manquant
  // (undefined dans l'URL) — fetchFromProvider() passe alors proprement au
  // fournisseur suivant, exactement comme pour toute autre panne réseau.
  if (!translation) {
    throw new Error(`Traduction non disponible sur helloao pour ${lang}`);
  }
  const cacheKey = `helloao:${translation}:${bookCode}:${reference.chapter}`;
  if (chapterCache.has(cacheKey)) {
    return chapterCache.get(cacheKey);
  }

  const url = `https://bible.helloao.org/api/${translation}/${bookCode}/${reference.chapter}.json`;
  console.log(`[bible-lookup] Téléchargement du chapitre ${reference.book} ${reference.chapter} (${translation}) via helloao...`);
  const data = await fetchJson(url);

  chapterCache.set(cacheKey, data);
  if (chapterCache.size > 50) {
    chapterCache.delete(chapterCache.keys().next().value);
  }
  return data;
}

function extractVerseText(content, contentItem) {
  // Chaque item de "content" est soit une chaîne, soit un objet
  // { text, wordsOfJesus } (ex: paroles de Jésus mises en évidence).
  return contentItem
    .map((part) => (typeof part === 'string' ? part : part.text || ''))
    .join(' ')
    // Retire les marqueurs de paragraphe (¶) présents en KJV en début de verset.
    .replace(/¶\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function helloaoParseVerse(chapterData, reference) {
  const content = chapterData?.chapter?.content;
  if (!Array.isArray(content)) return null;

  const verses = content.filter((item) => item.type === 'verse');

  if (!reference.verseStart) {
    // Pas de verset précis demandé : renvoyer tout le chapitre.
    const text = verses.map((v) => extractVerseText(v.content, v.content)).join(' ');
    return text.trim() || null;
  }

  const start = reference.verseStart;
  const end = reference.verseEnd || reference.verseStart;
  const selected = verses.filter((v) => v.number >= start && v.number <= end);
  if (selected.length === 0) return null;

  return selected
    .map((v) => `${selected.length > 1 ? v.number + ' ' : ''}${extractVerseText(v.content, v.content)}`)
    .join(' ')
    .trim();
}

// --- Fournisseur : api.getbible.net (ls1910) ------------------------------

async function getbibleFetchChapter(reference) {
  const bookNr = GETBIBLE_BOOK_NUMBERS[reference.book];
  if (!bookNr) {
    throw new Error(`Livre inconnu pour getbible: ${reference.book}`);
  }
  // AJOUT (audit — traductions multiples) : avant, l'URL pointait
  // toujours vers 'ls1910' en dur, quelle que soit la traduction
  // sélectionnée — changer pour Darby (setTranslation('fr','darby'))
  // n'aurait donc rien changé pour ce fournisseur. On lit maintenant le
  // getbibleId de la traduction courante (voir AVAILABLE_TRANSLATIONS).
  const meta = getTranslationMeta('fr');
  const translationSlug = (meta && meta.getbibleId) || 'ls1910';
  const cacheKey = `getbible:${translationSlug}:${bookNr}:${reference.chapter}`;
  if (chapterCache.has(cacheKey)) {
    return chapterCache.get(cacheKey);
  }

  const url = `https://api.getbible.net/v2/${translationSlug}/${bookNr}/${reference.chapter}.json`;
  console.log(`[bible-lookup] Téléchargement du chapitre ${reference.book} ${reference.chapter} (${translationSlug}) via getbible...`);
  const data = await fetchJson(url);

  chapterCache.set(cacheKey, data);
  if (chapterCache.size > 50) {
    chapterCache.delete(chapterCache.keys().next().value);
  }
  return data;
}

// Retire au mieux les numéros de concordance Strong embarqués dans le texte
// ls1910 (chiffres collés directement après un mot, sans espace — ex.
// "Dieu2316" -> "Dieu"). Voir la note en tête de fichier si un résidu
// persiste à l'écran.
function stripStrongNumbers(text) {
  return text.replace(/(\p{L})\d{1,5}(?=[\s,.;:!?»)]|$)/gu, '$1');
}

function getbibleParseVerse(chapterData, reference) {
  const verses = chapterData?.verses;
  if (!Array.isArray(verses)) return null;

  let selected;
  if (!reference.verseStart) {
    selected = verses;
  } else {
    const start = reference.verseStart;
    const end = reference.verseEnd || reference.verseStart;
    selected = verses.filter((v) => v.verse >= start && v.verse <= end);
  }
  if (selected.length === 0) return null;

  return selected
    .map((v) => `${selected.length > 1 ? v.verse + ' ' : ''}${stripStrongNumbers(String(v.text || '')).trim()}`)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BIBLE_PROVIDERS = [
  {
    name: 'helloao-lsg',
    supportsLang: (lang) => lang === 'fr' || lang === 'en',
    fetchChapter: helloaoFetchChapter,
    parseVerse: helloaoParseVerse,
  },
  {
    name: 'getbible-ls1910',
    supportsLang: (lang) => lang === 'fr',
    fetchChapter: getbibleFetchChapter,
    parseVerse: getbibleParseVerse,
  },
];

async function fetchFromProvider(provider, reference, lang) {
  try {
    if (provider.supportsLang && !provider.supportsLang(lang)) return null;
    console.log(`[bible-lookup] Tentative via ${provider.name} (${lang})...`);
    const chapterData = await provider.fetchChapter(reference, lang);
    const text = provider.parseVerse(chapterData, reference);
    if (!text) {
      throw new Error('Verset introuvable dans la réponse');
    }
    console.log(`[bible-lookup] ✓ Verset obtenu via ${provider.name} (${lang})`);
    return text;
  } catch (error) {
    console.warn(`[bible-lookup] ✗ ${provider.name} (${lang}) a échoué: ${error.message}`);
    return null;
  }
}

// -----------------------------------------------------------------------
// AJOUT (audit — inspiré de Rhema, détection par citation).
// -----------------------------------------------------------------------
// Rhema détecte un verset même quand il est lu SANS que sa référence soit
// prononcée, en le comparant à sa base SQLite complète (recherche
// sémantique par embeddings). ChurchOverlay reste volontairement sans base
// de données complète — mais on peut retrouver une bonne partie du
// bénéfice en comparant le texte transcrit aux versets DÉJÀ mis en cache
// (via une référence explicite ou une citation précédente). Couverture
// nécessairement partielle (un verset jamais vu avant reste invisible à ce
// mécanisme), mais couvre le cas réel le plus fréquent : les versets
// récurrents d'un culte à l'autre, désormais aussi reconnaissables sans
// citer leur référence.
function normalizeForMatch(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantWordSet(text) {
  // Mots de 3 lettres et plus seulement : élimine les articles/prépositions
  // très fréquents (de, la, un, et...) qui gonfleraient artificiellement le
  // score de similarité entre deux textes sans rapport.
  return new Set(normalizeForMatch(text).split(' ').filter((w) => w.length > 2));
}

// Similarité = proportion des mots du texte le plus court retrouvée dans
// l'autre — plus tolérante qu'un Jaccard classique face à une citation
// partielle ou à une transcription vocale imparfaite (mots ratés/déformés).
function wordOverlapSimilarity(a, b) {
  const setA = significantWordSet(a);
  const setB = significantWordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let overlap = 0;
  for (const w of smaller) if (larger.has(w)) overlap++;
  return overlap / smaller.size;
}

const QUOTE_MATCH_THRESHOLD = 0.55;
const QUOTE_MATCH_MIN_WORDS = 5; // segments trop courts = trop de faux positifs

/**
 * Cherche, parmi les versets déjà en cache (mémoire + disque), celui dont le
 * texte ressemble le plus au segment transcrit fourni — SANS référence
 * explicite prononcée.
 * @param {string} spokenText - segment de transcription à comparer
 * @returns {{ reference: string, text: string, provider: string, lang: string, score: number }|null}
 */
function findByQuotedText(spokenText) {
  if (significantWordSet(spokenText).size < QUOTE_MATCH_MIN_WORDS) return null;

  let best = null;
  let bestScore = 0;
  for (const entry of cache.values()) {
    if (!entry || !entry.text) continue;
    const score = wordOverlapSimilarity(spokenText, entry.text);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best || bestScore < QUOTE_MATCH_THRESHOLD) return null;
  return { ...best, score: bestScore };
}

async function getVerse(reference, lang = 'fr') {
  const cacheKey = `${lang}:${reference.book}:${reference.chapter}:${reference.verseStart || ''}-${reference.verseEnd || ''}`;
  // AJOUT (audit — cache persistant, inspiré de Rhema) : ce Map est aussi
  // rempli au démarrage depuis le disque (voir loadDiskCache()/setCacheDir())
  // — donc un verset déjà consulté lors d'un culte précédent répond ici
  // instantanément, MÊME SANS RÉSEAU, sans code supplémentaire : c'est le
  // même chemin que le cache mémoire classique de cette session.
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!HELLOAO_BOOK_CODES[reference.book]) {
    throw new Error(`Livre biblique inconnu: ${reference.book}`);
  }

  let text = null;
  let provider = null;

  for (const p of BIBLE_PROVIDERS) {
    text = await fetchFromProvider(p, reference, lang);
    if (text) {
      provider = p.name;
      break;
    }
  }

  if (!text) {
    throw new Error('Could not fetch verse from any provider. Check your internet connection.');
  }

  const result = {
    reference: label(reference, lang),
    text: text.trim(),
    provider,
    lang,
  };

  cache.set(cacheKey, result);
  if (cache.size > 200) {
    cache.delete(cache.keys().next().value);
  }
  scheduleDiskCacheSave(); // AJOUT (audit) : persiste pour les cultes/redémarrages suivants

  return result;
}

/**
 * Récupère le texte d'un verset dans une ou plusieurs langues.
 * @param {Object} reference - référence biblique détectée
 * @param {string} langMode - 'fr', 'en', ou 'both'
 * @returns {Object} { reference, text_fr?, text_en?, text (langue primaire), langMode, provider }
 */
async function getVerseMultilang(reference, langMode = 'fr') {
  if (langMode === 'both') {
    const [frRes, enRes] = await Promise.allSettled([
      getVerse(reference, 'fr'),
      getVerse(reference, 'en'),
    ]);
    const frOk = frRes.status === 'fulfilled' ? frRes.value : null;
    const enOk = enRes.status === 'fulfilled' ? enRes.value : null;
    if (!frOk && !enOk) {
      throw new Error('Verset introuvable en FR et en EN.');
    }
    // Réf bilingue : "Jean 3:16 · John 3:16" (identique si nom commun)
    const refFr = label(reference, 'fr');
    const refEn = label(reference, 'en');
    const bilingualRef = refFr === refEn ? refFr : `${refFr} · ${refEn}`;
    return {
      reference: bilingualRef,
      text_fr: frOk ? frOk.text : null,
      text_en: enOk ? enOk.text : null,
      text: frOk ? frOk.text : enOk.text,
      langMode: 'both',
      provider: frOk ? frOk.provider : enOk.provider,
    };
  }
  const single = await getVerse(reference, langMode);
  return {
    reference: single.reference,
    text: single.text,
    text_fr: langMode === 'fr' ? single.text : null,
    text_en: langMode === 'en' ? single.text : null,
    langMode,
    provider: single.provider,
  };
}

module.exports = {
  getVerse,
  getVerseMultilang,
  buildReferenceLabel: label,
  getProviders: () => BIBLE_PROVIDERS.map((p) => p.name),
  resetFailedProviders: () => {}, // Conservé pour compatibilité avec server.js
  getCacheSize: () => cache.size,
  clearCache: () => { cache.clear(); chapterCache.clear(); },
  setTranslation,
  listTranslations,
  getTranslationId,
  setCacheDir, // AJOUT (audit) : cache de versets persistant sur disque
  findByQuotedText, // AJOUT (audit) : détection par citation, inspirée de Rhema
};

// Mode test : `node bible-lookup-with-api.js` (documenté dans SETUP.md).
// Interroge les vrais fournisseurs en ligne pour vérifier que la recherche
// de versets fonctionne réellement (utile après un changement de réseau,
// ou pour vérifier l'état des APIs avant un culte).
if (require.main === module) {
  console.log('=== Test bible-lookup-with-api.js (fournisseurs en ligne) ===\n');

  const tests = [
    { book: 'jean', chapter: 3, verseStart: 16 },
    { book: 'psaumes', chapter: 23, verseStart: 1 },
    { book: 'romains', chapter: 8, verseStart: 28 },
    { book: '1corinthiens', chapter: 13, verseStart: 4, verseEnd: 7 },
    { book: 'apocalypse', chapter: 21, verseStart: 4 },
  ];

  (async () => {
    let success = 0;
    let failed = 0;

    for (const test of tests) {
      try {
        const result = await getVerse(test);
        console.log(`✅ ${result.reference} [${result.provider}]: "${result.text.substring(0, 80)}..."`);
        success++;
      } catch (error) {
        console.log(`❌ ${label(test)}: ${error.message}`);
        failed++;
      }
    }

    console.log(`\n=== ${success} succès, ${failed} échecs ===`);
    process.exit(failed > 0 ? 1 : 0);
  })();
}
