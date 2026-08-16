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
const { levenshteinDistance } = require('./levenshtein');

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
    console.warn(
      `[bible-lookup] Impossible de créer le dossier de cache (${dir}) : ${err.message}`
    );
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
      let kept = 0;
      for (const [key, value] of entries) {
        // CORRECTIF (Chantier 1 — latence fusion) : les entrées CHAPITRE SEUL
        // (clé "lang:livre:chap:-", cf. getVerse) sont exclues du cache verset
        // scanné par findByQuotedText — on les écarte aussi au chargement pour
        // purger celles persistées par d'anciennes sessions.
        const tail = key.slice(key.lastIndexOf(':') + 1);
        if (tail === '-' || tail === '') continue;
        cache.set(key, value);
        kept++;
      }
      console.log(`[bible-lookup] Cache disque chargé : ${kept} verset(s).`);
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
  genese: 'GEN',
  exode: 'EXO',
  levitique: 'LEV',
  nombres: 'NUM',
  deuteronome: 'DEU',
  josue: 'JOS',
  juges: 'JDG',
  ruth: 'RUT',
  '1samuel': '1SA',
  '2samuel': '2SA',
  '1rois': '1KI',
  '2rois': '2KI',
  '1chroniques': '1CH',
  '2chroniques': '2CH',
  esdras: 'EZR',
  nehemie: 'NEH',
  esther: 'EST',
  job: 'JOB',
  psaumes: 'PSA',
  proverbes: 'PRO',
  ecclesiaste: 'ECC',
  cantique: 'SNG',
  esaie: 'ISA',
  jeremie: 'JER',
  lamentations: 'LAM',
  ezechiel: 'EZK',
  daniel: 'DAN',
  osee: 'HOS',
  joel: 'JOL',
  amos: 'AMO',
  abdias: 'OBA',
  jonas: 'JON',
  michee: 'MIC',
  nahum: 'NAM',
  habacuc: 'HAB',
  sophonie: 'ZEP',
  aggee: 'HAG',
  zacharie: 'ZEC',
  malachie: 'MAL',
  matthieu: 'MAT',
  marc: 'MRK',
  luc: 'LUK',
  jean: 'JHN',
  actes: 'ACT',
  romains: 'ROM',
  '1corinthiens': '1CO',
  '2corinthiens': '2CO',
  galates: 'GAL',
  ephesiens: 'EPH',
  philippiens: 'PHP',
  colossiens: 'COL',
  '1thessaloniciens': '1TH',
  '2thessaloniciens': '2TH',
  '1timothee': '1TI',
  '2timothee': '2TI',
  tite: 'TIT',
  philemon: 'PHM',
  hebreux: 'HEB',
  jacques: 'JAS',
  '1pierre': '1PE',
  '2pierre': '2PE',
  '1jean': '1JN',
  '2jean': '2JN',
  '3jean': '3JN',
  jude: 'JUD',
  apocalypse: 'REV',
};

// Numérotation des livres (1-66, ordre protestant standard) utilisée par
// l'API getBible v2 pour la traduction ls1910 — vérifiée le 24/07/2026 via
// https://api.getbible.net/v2/ls1910/books.json. Mêmes clés que
// HELLOAO_BOOK_CODES ci-dessus pour rester interchangeable.
const GETBIBLE_BOOK_NUMBERS = {
  genese: 1,
  exode: 2,
  levitique: 3,
  nombres: 4,
  deuteronome: 5,
  josue: 6,
  juges: 7,
  ruth: 8,
  '1samuel': 9,
  '2samuel': 10,
  '1rois': 11,
  '2rois': 12,
  '1chroniques': 13,
  '2chroniques': 14,
  esdras: 15,
  nehemie: 16,
  esther: 17,
  job: 18,
  psaumes: 19,
  proverbes: 20,
  ecclesiaste: 21,
  cantique: 22,
  esaie: 23,
  jeremie: 24,
  lamentations: 25,
  ezechiel: 26,
  daniel: 27,
  osee: 28,
  joel: 29,
  amos: 30,
  abdias: 31,
  jonas: 32,
  michee: 33,
  nahum: 34,
  habacuc: 35,
  sophonie: 36,
  aggee: 37,
  zacharie: 38,
  malachie: 39,
  matthieu: 40,
  marc: 41,
  luc: 42,
  jean: 43,
  actes: 44,
  romains: 45,
  '1corinthiens': 46,
  '2corinthiens': 47,
  galates: 48,
  ephesiens: 49,
  philippiens: 50,
  colossiens: 51,
  '1thessaloniciens': 52,
  '2thessaloniciens': 53,
  '1timothee': 54,
  '2timothee': 55,
  tite: 56,
  philemon: 57,
  hebreux: 58,
  jacques: 59,
  '1pierre': 60,
  '2pierre': 61,
  '1jean': 62,
  '2jean': 63,
  '3jean': 64,
  jude: 65,
  apocalypse: 66,
};

const DISPLAY_NAMES = {
  genese: 'Genèse',
  exode: 'Exode',
  levitique: 'Lévitique',
  nombres: 'Nombres',
  deuteronome: 'Deutéronome',
  josue: 'Josué',
  juges: 'Juges',
  ruth: 'Ruth',
  '1samuel': '1 Samuel',
  '2samuel': '2 Samuel',
  '1rois': '1 Rois',
  '2rois': '2 Rois',
  '1chroniques': '1 Chroniques',
  '2chroniques': '2 Chroniques',
  esdras: 'Esdras',
  nehemie: 'Néhémie',
  esther: 'Esther',
  job: 'Job',
  psaumes: 'Psaumes',
  proverbes: 'Proverbes',
  ecclesiaste: 'Ecclésiaste',
  cantique: 'Cantique des cantiques',
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
  marc: 'Marc',
  luc: 'Luc',
  jean: 'Jean',
  actes: 'Actes',
  romains: 'Romains',
  '1corinthiens': '1 Corinthiens',
  '2corinthiens': '2 Corinthiens',
  galates: 'Galates',
  ephesiens: 'Éphésiens',
  philippiens: 'Philippiens',
  colossiens: 'Colossiens',
  '1thessaloniciens': '1 Thessaloniciens',
  '2thessaloniciens': '2 Thessaloniciens',
  '1timothee': '1 Timothée',
  '2timothee': '2 Timothée',
  tite: 'Tite',
  philemon: 'Philémon',
  hebreux: 'Hébreux',
  jacques: 'Jacques',
  '1pierre': '1 Pierre',
  '2pierre': '2 Pierre',
  '1jean': '1 Jean',
  '2jean': '2 Jean',
  '3jean': '3 Jean',
  jude: 'Jude',
  apocalypse: 'Apocalypse',
};

// Noms anglais officiels (utilisés pour l'affichage en mode 'en' seul).
const DISPLAY_NAMES_EN = {
  genese: 'Genesis',
  exode: 'Exodus',
  levitique: 'Leviticus',
  nombres: 'Numbers',
  deuteronome: 'Deuteronomy',
  josue: 'Joshua',
  juges: 'Judges',
  ruth: 'Ruth',
  '1samuel': '1 Samuel',
  '2samuel': '2 Samuel',
  '1rois': '1 Kings',
  '2rois': '2 Kings',
  '1chroniques': '1 Chronicles',
  '2chroniques': '2 Chronicles',
  esdras: 'Ezra',
  nehemie: 'Nehemiah',
  esther: 'Esther',
  job: 'Job',
  psaumes: 'Psalms',
  proverbes: 'Proverbs',
  ecclesiaste: 'Ecclesiastes',
  cantique: 'Song of Solomon',
  esaie: 'Isaiah',
  jeremie: 'Jeremiah',
  lamentations: 'Lamentations',
  ezechiel: 'Ezekiel',
  daniel: 'Daniel',
  osee: 'Hosea',
  joel: 'Joel',
  amos: 'Amos',
  abdias: 'Obadiah',
  jonas: 'Jonah',
  michee: 'Micah',
  nahum: 'Nahum',
  habacuc: 'Habakkuk',
  sophonie: 'Zephaniah',
  aggee: 'Haggai',
  zacharie: 'Zechariah',
  malachie: 'Malachi',
  matthieu: 'Matthew',
  marc: 'Mark',
  luc: 'Luke',
  jean: 'John',
  actes: 'Acts',
  romains: 'Romans',
  '1corinthiens': '1 Corinthians',
  '2corinthiens': '2 Corinthians',
  galates: 'Galatians',
  ephesiens: 'Ephesians',
  philippiens: 'Philippians',
  colossiens: 'Colossians',
  '1thessaloniciens': '1 Thessalonians',
  '2thessaloniciens': '2 Thessalonians',
  '1timothee': '1 Timothy',
  '2timothee': '2 Timothy',
  tite: 'Titus',
  philemon: 'Philemon',
  hebreux: 'Hebrews',
  jacques: 'James',
  '1pierre': '1 Peter',
  '2pierre': '2 Peter',
  '1jean': '1 John',
  '2jean': '2 John',
  '3jean': '3 John',
  jude: 'Jude',
  apocalypse: 'Revelation',
};

function label({ book, chapter, verseStart, verseEnd }, lang = 'fr') {
  const normBook = normalizeBookKey(book);
  const dict = lang === 'en' ? DISPLAY_NAMES_EN : DISPLAY_NAMES;
  const name = dict[normBook] || DISPLAY_NAMES[normBook] || DISPLAY_NAMES_EN[normBook] || book;
  return !verseStart
    ? `${name} ${chapter}`
    : `${name} ${chapter}:${verseStart}${verseEnd && verseEnd !== verseStart ? `-${verseEnd}` : ''}`;
}

// AJOUT (Chantier 2 — retries) : une panne transitoire (hoquet réseau, 5xx
// côté fournisseur, timeout) faisait échouer le verset du premier coup —
// sur un service d'une heure, une coupure Wi-Fi de quelques secondes pouvait
// donc empêcher un verset de s'afficher pendant le culte. Les requêtes ici
// sont des GET idempotents (chapitre par chapitre, jamais de mutation) : une
// nouvelle tentative est donc toujours sûre. On ne retente JAMAIS les 4xx
// (erreur de notre requête — un 404 "livre/chapitre absent" ne se résoudra
// pas en retentant), uniquement les pannes réseau et 5xx transitoires.
const FETCH_RETRY_DELAYS_MS = [600, 1600]; // jusqu'à 2 nouvelles tentatives

async function fetchJson(url, timeoutMs = 8000) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'ChurchOverlay/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) {
        // 5xx : transitoire côté fournisseur -> nouvelle tentative (après backoff).
        // Autre statut (4xx) : erreur définitive de notre requête -> on abandonne.
        if (response.status >= 500 && attempt < FETCH_RETRY_DELAYS_MS.length) {
          const err = new Error(`API returned ${response.status}`);
          lastErr = err;
          await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw new Error(`API returned ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      const isTransient =
        err instanceof Error &&
        (err.name === 'AbortError' ||
          err.name === 'TypeError' || // réseau (fetch échoue typiquement en TypeError)
          (err.message && err.message.startsWith('API returned 5')));
      if (!isTransient || attempt >= FETCH_RETRY_DELAYS_MS.length) {
        throw err;
      }
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAYS_MS[attempt]));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastErr;
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
      code,
      label: meta.label,
      active: code === activeCode,
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
  console.log(
    `[bible-lookup] Téléchargement du chapitre ${reference.book} ${reference.chapter} (${translation}) via helloao...`
  );
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
  return (
    contentItem
      .map((part) => (typeof part === 'string' ? part : part.text || ''))
      .join(' ')
      // Retire les marqueurs de paragraphe (¶) présents en KJV en début de verset.
      .replace(/¶\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// AJOUT (audit — Reading Mode, inspiré de Rhema) : contrairement à
// helloaoParseVerse (qui ne renvoie QUE le texte joint du verset/plage
// demandé), le Reading Mode a besoin de la liste complète des versets du
// chapitre, individuellement adressables par leur numéro, pour comparer
// chaque nouveau fragment transcrit au verset suivant. Réutilise la même
// donnée déjà en cache (chapterCache) — aucun appel réseau supplémentaire
// si le chapitre a déjà été consulté via une référence explicite.
function helloaoParseChapterVerses(chapterData) {
  const content = chapterData?.chapter?.content;
  if (!Array.isArray(content)) return null;
  const verses = content.filter((item) => item.type === 'verse');
  return verses
    .map((v) => ({ num: v.number, text: extractVerseText(v.content, v.content) }))
    .filter((v) => Number.isInteger(v.num) && v.text);
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
    .map(
      (v) => `${selected.length > 1 ? v.number + ' ' : ''}${extractVerseText(v.content, v.content)}`
    )
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
  console.log(
    `[bible-lookup] Téléchargement du chapitre ${reference.book} ${reference.chapter} (${translationSlug}) via getbible...`
  );
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

// AJOUT (audit — Reading Mode). Équivalent getbible de
// helloaoParseChapterVerses() ci-dessus : liste complète des versets du
// chapitre, utilisée en secours si helloao est indisponible (voir
// getChapterVerses() plus bas, qui parcourt BIBLE_PROVIDERS dans le même
// ordre que fetchFromProvider()).
function getbibleParseChapterVerses(chapterData) {
  const verses = chapterData?.verses;
  if (!Array.isArray(verses)) return null;
  return verses
    .map((v) => ({ num: v.verse, text: stripStrongNumbers(String(v.text || '')).trim() }))
    .filter((v) => Number.isInteger(v.num) && v.text);
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
    .map(
      (v) =>
        `${selected.length > 1 ? v.verse + ' ' : ''}${stripStrongNumbers(String(v.text || '')).trim()}`
    )
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
    parseChapterVerses: helloaoParseChapterVerses, // AJOUT (audit — Reading Mode)
  },
  {
    name: 'getbible-ls1910',
    supportsLang: (lang) => lang === 'fr',
    fetchChapter: getbibleFetchChapter,
    parseVerse: getbibleParseVerse,
    parseChapterVerses: getbibleParseChapterVerses, // AJOUT (audit — Reading Mode)
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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantWordSet(text) {
  // Mots de 3 lettres et plus seulement : élimine les articles/prépositions
  // très fréquents (de, la, un, et...) qui gonfleraient artificiellement le
  // score de similarité entre deux textes sans rapport.
  return new Set(
    normalizeForMatch(text)
      .split(' ')
      .filter((w) => w.length > 2)
  );
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

const BOOK_NORMALIZATION_MAP = {
  psaume: 'psaumes',
  psaumes: 'psaumes',
  ps: 'psaumes',
  psalm: 'psaumes',
  psalms: 'psaumes',
  somme: 'psaumes',
  sommes: 'psaumes',
  tome: 'psaumes',
  tomes: 'psaumes',
  genese: 'genese',
  gen: 'genese',
  genesis: 'genese',
  exode: 'exode',
  exo: 'exode',
  exodus: 'exode',
  levitique: 'levitique',
  lev: 'levitique',
  leviticus: 'levitique',
  nombres: 'nombres',
  nom: 'nombres',
  numbers: 'nombres',
  deuteronome: 'deuteronome',
  deut: 'deuteronome',
  deuteronomy: 'deuteronome',
  josue: 'josue',
  jos: 'josue',
  joshua: 'josue',
  juges: 'juges',
  jug: 'juges',
  judges: 'juges',
  ruth: 'ruth',
  '1samuel': '1samuel',
  '2samuel': '2samuel',
  '1rois': '1rois',
  '2rois': '2rois',
  '1chroniques': '1chroniques',
  '2chroniques': '2chroniques',
  esdras: 'esdras',
  ezra: 'esdras',
  nehemie: 'nehemie',
  nehemiah: 'nehemie',
  esther: 'esther',
  job: 'job',
  proverbes: 'proverbes',
  prov: 'proverbes',
  proverbs: 'proverbes',
  ecclesiaste: 'ecclesiaste',
  qohelet: 'ecclesiaste',
  ecclesiastes: 'ecclesiaste',
  cantique: 'cantique',
  cantiques: 'cantique',
  esaie: 'esaie',
  es: 'esaie',
  isaiah: 'esaie',
  jeremie: 'jeremie',
  jer: 'jeremie',
  jeremiah: 'jeremie',
  lamentations: 'lamentations',
  lam: 'lamentations',
  ezechiel: 'ezechiel',
  ez: 'ezechiel',
  ezekiel: 'ezechiel',
  daniel: 'daniel',
  dan: 'daniel',
  osee: 'osee',
  os: 'osee',
  hosea: 'osee',
  joel: 'joel',
  amos: 'amos',
  abdias: 'abdias',
  obadiah: 'abdias',
  jonas: 'jonas',
  jonah: 'jonas',
  michee: 'michee',
  mi: 'michee',
  micah: 'michee',
  nahum: 'nahum',
  habacuc: 'habacuc',
  ha: 'habacuc',
  habakkuk: 'habacuc',
  sophonie: 'sophonie',
  so: 'sophonie',
  zephaniah: 'sophonie',
  aggee: 'aggee',
  ag: 'aggee',
  haggai: 'aggee',
  zacharie: 'zacharie',
  za: 'zacharie',
  zechariah: 'zacharie',
  malachie: 'malachie',
  ml: 'malachie',
  malachi: 'malachie',
  matthieu: 'matthieu',
  mathieu: 'matthieu',
  mt: 'matthieu',
  matthew: 'matthieu',
  marc: 'marc',
  mc: 'marc',
  mark: 'marc',
  luc: 'luc',
  lc: 'luc',
  luke: 'luc',
  jean: 'jean',
  jn: 'jean',
  john: 'jean',
  actes: 'actes',
  ac: 'actes',
  acts: 'actes',
  romains: 'romains',
  rom: 'romains',
  rm: 'romains',
  romans: 'romains',
  '1corinthiens': '1corinthiens',
  '2corinthiens': '2corinthiens',
  ce2chapitre: '2corinthiens',
  ce2: '2corinthiens',
  galates: 'galates',
  ga: 'galates',
  galatians: 'galates',
  ephesiens: 'ephesiens',
  ep: 'ephesiens',
  ephesians: 'ephesiens',
  philippiens: 'philippiens',
  php: 'philippiens',
  philippians: 'philippiens',
  colossiens: 'colossiens',
  col: 'colossiens',
  colossians: 'colossiens',
  '1thessaloniciens': '1thessaloniciens',
  '2thessaloniciens': '2thessaloniciens',
  '1timothee': '1timothee',
  '2timothee': '2timothee',
  tite: 'tite',
  titus: 'tite',
  philemon: 'philemon',
  hebreux: 'hebreux',
  heb: 'hebreux',
  hebrews: 'hebreux',
  jacques: 'jacques',
  jc: 'jacques',
  james: 'jacques',
  '1pierre': '1pierre',
  '2pierre': '2pierre',
  '1jean': '1jean',
  '2jean': '2jean',
  '3jean': '3jean',
  jude: 'jude',
  apocalypse: 'apocalypse',
  ap: 'apocalypse',
  revelation: 'apocalypse',
};

function normalizeBookKey(rawBook) {
  if (!rawBook) return 'psaumes';
  const clean = String(rawBook)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

  if (HELLOAO_BOOK_CODES[clean]) return clean;
  if (BOOK_NORMALIZATION_MAP[clean]) return BOOK_NORMALIZATION_MAP[clean];

  // Strip noise words
  const stripped = clean.replace(/chapitre|verset|livre|epitre|evangile|ce/g, '').trim();
  if (stripped && HELLOAO_BOOK_CODES[stripped]) return stripped;
  if (stripped && BOOK_NORMALIZATION_MAP[stripped]) return BOOK_NORMALIZATION_MAP[stripped];

  // Levenshtein fuzzy match
  let bestKey = null;
  let minDist = Infinity;
  const allKnownKeys = [...Object.keys(HELLOAO_BOOK_CODES), ...Object.keys(BOOK_NORMALIZATION_MAP)];
  for (const key of allKnownKeys) {
    if (key.length < 3) continue;
    const dist = levenshteinDistance(clean, key);
    if (dist < minDist) {
      minDist = dist;
      bestKey = key;
    }
  }
  if (bestKey && minDist <= Math.max(2, Math.floor(clean.length / 2))) {
    return BOOK_NORMALIZATION_MAP[bestKey] || bestKey;
  }

  // Graceful fallback to psaumes
  return 'psaumes';
}

async function getVerse(reference, lang = 'fr') {
  if (!reference || !reference.book) {
    throw new Error('Référence invalide');
  }

  const normalizedBook = normalizeBookKey(reference.book);
  reference = { ...reference, book: normalizedBook };

  const cacheKey = `${lang}:${reference.book}:${reference.chapter}:${reference.verseStart || ''}-${reference.verseEnd || ''}`;
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
    // AJOUT (cahier des charges — Point 1B, offline-first) : dernier
    // recours avant d'abandonner — les DEUX fournisseurs réseau ont échoué
    // (connexion coupée en plein culte, la panne réelle que ce repli vise).
    // Repli en retard (pas en haut du fichier) : voir le commentaire
    // symétrique dans bible-offline-cache.js sur la dépendance circulaire.
    try {
      const offlineCache = require('./bible-offline-cache');
      const translation = getTranslationId(lang) || offlineCache.DEFAULT_TRANSLATION;
      const offlineText = offlineCache.getOfflineVerse(reference, translation);
      if (offlineText) {
        text = offlineText;
        provider = 'offline-cache';
        console.log(
          '[bible-lookup] ✓ Verset obtenu depuis la base hors-ligne (réseau indisponible)'
        );
      }
    } catch (_e) {
      // Module hors-ligne non initialisé ou base absente : traité comme
      // n'importe quel autre échec de fournisseur, voir throw ci-dessous.
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

  // CORRECTIF (Chantier 1 — latence fusion) : on NE met PAS dans le cache
  // "verset" (scanné par findByQuotedText pour la détection par citation)
  // les entrées CHAPITRE SEUL (verseStart absent, clé "lang:livre:chap:-").
  // Elles ne servent jamais aux recherches par verset (clés disjointes) —
  // leur seul effet était de POLLUER le matcher de citations : un préchauffage
  // de chapitre (échauffement du cache pour la latence) ajoutait une entrée
  // "1 Jean 4" (texte = chapitre entier) que "Dieu est amour" (1 Jean 4:8)
  // pouvait ensuite matcher (score 0.67 ≥ 0.55) — faux positif sur des
  // commandes comme « Répétez après moi Dieu est amour ». La donnée reste
  // utilisable via chapterCache (partagé avec helloaoFetchChapter), donc le
  // préchauffage par chapitre conserve TOUT son bénéfice de latence.
  if (reference.verseStart) {
    cache.set(cacheKey, result);
    if (cache.size > 200) {
      cache.delete(cache.keys().next().value);
    }
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
    let enOk = enRes.status === 'fulfilled' ? enRes.value : null;
    // CORRECTIF (signalé — mode bilingue : seule la référence était traduite,
    // pas le verset) : le français a un double avantage structurel sur
    // l'anglais dans cette course Promise.allSettled — il est presque
    // toujours déjà en cache (langue par défaut, chapitre déjà téléchargé
    // lors d'un usage précédent) ET dispose de 2 fournisseurs de repli
    // (helloao + getbible), alors que l'anglais n'a NI cache chaud NI
    // fournisseur de secours (seul helloao sert l'anglais). Sur un réseau
    // d'église chargé, le premier téléchargement du chapitre anglais dépasse
    // facilement le timeout de 5s (fetchJson) pendant que le français,
    // déjà en cache, répond instantanément — d'où le symptôme observé :
    // la référence bilingue s'affiche toujours (calculée localement, sans
    // réseau) mais le texte anglais du verset manque silencieusement.
    // Un seul nouvel essai (chapitre probablement déjà en cache navigateur/
    // CDN côté helloao au 2e essai, et le timeout initial a pu suffire à
    // amorcer la connexion) résout la grande majorité des cas transitoires
    // sans complexifier le fournisseur unique existant.
    if (!enOk) {
      console.warn(
        `[bible-lookup] Texte anglais manquant en mode bilingue pour ${reference.book} ${reference.chapter} — nouvelle tentative...`
      );
      try {
        enOk = await getVerse(reference, 'en');
      } catch (_e) {
        // Toujours en échec après le second essai — voir l'avertissement
        // ci-dessous, la référence bilingue reste affichée, le texte
        // anglais restera absent pour ce verset précis.
      }
    }
    if (!frOk && !enOk) {
      throw new Error('Verset introuvable en FR et en EN.');
    }
    if (!enOk) {
      console.warn(
        `[bible-lookup] ⚠ Texte anglais indisponible pour ${reference.book} ${reference.chapter} ` +
          'après 2 tentatives (réseau lent ou API anglaise indisponible) — ' +
          "le verset s'affichera en français uniquement malgré le mode bilingue."
      );
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

// -----------------------------------------------------------------------
// AJOUT (audit — Reading Mode, inspiré de Rhema).
// -----------------------------------------------------------------------
// Récupère TOUS les versets d'un chapitre (pas une plage isolée), triés
// par numéro, pour que reading-mode.js puisse comparer chaque nouveau
// fragment transcrit aux versets suivants sans redemander la référence
// exacte à chaque fois. Parcourt les mêmes fournisseurs, dans le même
// ordre, que fetchFromProvider() — mais un seul appel réseau par chapitre
// (grâce à chapterCache, déjà partagé avec getVerse()/helloaoFetchChapter()
// : si le chapitre a déjà été consulté via "Jean 3:16", ce chapitre est
// déjà en cache et cet appel ne coûte rien).
// @param {string} book - clé de livre normalisée (même format que reference.book)
// @param {number} chapter
// @param {string} lang - 'fr' ou 'en' (pas de mode 'both' ici : le Reading
//   Mode affiche une seule langue à la fois pendant la lecture continue)
// @returns {Promise<{num:number, text:string}[]>} versets triés par numéro
async function getChapterVerses(book, chapter, lang = 'fr') {
  const normBook = normalizeBookKey(book);
  const reference = { book: normBook, chapter };
  let lastError = null;

  for (const p of BIBLE_PROVIDERS) {
    if (p.supportsLang && !p.supportsLang(lang)) continue;
    if (typeof p.parseChapterVerses !== 'function') continue;
    try {
      console.log(
        `[bible-lookup] Reading Mode : chargement chapitre ${book} ${chapter} via ${p.name} (${lang})...`
      );
      const chapterData = await p.fetchChapter(reference, lang);
      const verses = p.parseChapterVerses(chapterData);
      if (verses && verses.length > 0) {
        verses.sort((a, b) => a.num - b.num);
        return verses;
      }
    } catch (error) {
      lastError = error;
      console.warn(
        `[bible-lookup] Reading Mode : ${p.name} a échoué pour ${book} ${chapter}: ${error.message}`
      );
    }
  }

  throw new Error(
    lastError
      ? `Chapitre ${book} ${chapter} introuvable : ${lastError.message}`
      : `Chapitre ${book} ${chapter} introuvable`
  );
}

/**
 * Équivalent chapitre de getVerseMultilang() : récupère TOUS les versets
 * d'un chapitre dans une ou deux langues, pour que le Reading Mode (lecture
 * continue) puisse afficher le FR et l'EN simultanément quand langMode
 * vaut 'both' — jusqu'ici seul le mode "un verset détecté explicitement"
 * (getVerseMultilang) supportait le bilingue ; le Reading Mode retombait
 * silencieusement sur une seule langue.
 * @param {string} book
 * @param {number} chapter
 * @param {string} langMode - 'fr', 'en', ou 'both'
 * @returns {Promise<{num:number, text:string, text_fr:?string, text_en:?string}[]>}
 *   `text` reste la langue principale (FR par défaut en mode 'both'), pour
 *   que le matching de mots du Reading Mode (basé sur ce que dit l'orateur,
 *   en général en français) continue à fonctionner sans changement ailleurs.
 */
async function getChapterVersesMultilang(book, chapter, langMode = 'fr') {
  if (langMode === 'both') {
    const [frRes, enRes] = await Promise.allSettled([
      getChapterVerses(book, chapter, 'fr'),
      getChapterVerses(book, chapter, 'en'),
    ]);
    const frVerses = frRes.status === 'fulfilled' ? frRes.value : null;
    const enVerses = enRes.status === 'fulfilled' ? enRes.value : null;
    if (!frVerses && !enVerses) {
      // On relance l'erreur d'origine (FR en priorité) pour un message utile.
      throw frRes.reason || enRes.reason || new Error(`Chapitre ${book} ${chapter} introuvable.`);
    }
    const enByNum = new Map((enVerses || []).map((v) => [v.num, v.text]));
    const frByNum = new Map((frVerses || []).map((v) => [v.num, v.text]));
    const base = frVerses || enVerses;
    return base.map((v) => ({
      num: v.num,
      text: frByNum.get(v.num) || enByNum.get(v.num) || v.text,
      text_fr: frByNum.get(v.num) || null,
      text_en: enByNum.get(v.num) || null,
    }));
  }
  const verses = await getChapterVerses(book, chapter, langMode);
  return verses.map((v) => ({
    num: v.num,
    text: v.text,
    text_fr: langMode === 'fr' ? v.text : null,
    text_en: langMode === 'en' ? v.text : null,
  }));
}

module.exports = {
  getVerse,
  getVerseMultilang,
  getChapterVerses, // AJOUT (audit) : Reading Mode, inspiré de Rhema
  getChapterVersesMultilang, // AJOUT : Reading Mode bilingue FR+EN
  buildReferenceLabel: label,
  getProviders: () => BIBLE_PROVIDERS.map((p) => p.name),
  resetFailedProviders: () => {}, // Conservé pour compatibilité avec server.js
  getCacheSize: () => cache.size,
  clearCache: () => {
    cache.clear();
    chapterCache.clear();
  },
  setTranslation,
  listTranslations,
  getTranslationId,
  setCacheDir, // AJOUT (audit) : cache de versets persistant sur disque
  findByQuotedText, // AJOUT (audit) : détection par citation, inspirée de Rhema
  // AJOUT (cahier des charges — base biblique hors-ligne) : exposé pour que
  // bible-offline-cache.js réutilise EXACTEMENT le même mapping que
  // helloaoFetchChapter() ci-dessus, plutôt que de dupliquer les 66 codes
  // USFM (risque de désynchronisation si l'un des deux fichiers est corrigé
  // sans l'autre).
  HELLOAO_BOOK_CODES,
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
        console.log(
          `✅ ${result.reference} [${result.provider}]: "${result.text.substring(0, 80)}..."`
        );
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
