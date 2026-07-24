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

// Cache du verset final déjà assemblé (clé -> { reference, text, provider })
const cache = new Map();
// Cache des chapitres bruts déjà téléchargés, pour éviter de re-télécharger
// tout un chapitre à chaque verset demandé dedans.
// clé: `${providerName}:${bookCode}:${chapter}` -> données JSON du chapitre
const chapterCache = new Map();

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

function label({ book, chapter, verseStart, verseEnd }) {
  const name = DISPLAY_NAMES[book] || book;
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

async function helloaoFetchChapter(reference) {
  const bookCode = HELLOAO_BOOK_CODES[reference.book];
  if (!bookCode) {
    throw new Error(`Livre inconnu pour helloao: ${reference.book}`);
  }
  const cacheKey = `helloao:${bookCode}:${reference.chapter}`;
  if (chapterCache.has(cacheKey)) {
    return chapterCache.get(cacheKey);
  }

  const url = `https://bible.helloao.org/api/fra_lsg/${bookCode}/${reference.chapter}.json`;
  console.log(`[bible-lookup] Téléchargement du chapitre ${reference.book} ${reference.chapter} via helloao...`);
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
  const cacheKey = `getbible:${bookNr}:${reference.chapter}`;
  if (chapterCache.has(cacheKey)) {
    return chapterCache.get(cacheKey);
  }

  const url = `https://api.getbible.net/v2/ls1910/${bookNr}/${reference.chapter}.json`;
  console.log(`[bible-lookup] Téléchargement du chapitre ${reference.book} ${reference.chapter} via getbible...`);
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
    fetchChapter: helloaoFetchChapter,
    parseVerse: helloaoParseVerse,
  },
  {
    name: 'getbible-ls1910',
    fetchChapter: getbibleFetchChapter,
    parseVerse: getbibleParseVerse,
  },
];

async function fetchFromProvider(provider, reference) {
  try {
    console.log(`[bible-lookup] Tentative via ${provider.name}...`);
    const chapterData = await provider.fetchChapter(reference);
    const text = provider.parseVerse(chapterData, reference);
    if (!text) {
      throw new Error('Verset introuvable dans la réponse');
    }
    console.log(`[bible-lookup] ✓ Verset obtenu via ${provider.name}`);
    return text;
  } catch (error) {
    console.warn(`[bible-lookup] ✗ ${provider.name} a échoué: ${error.message}`);
    return null;
  }
}

async function getVerse(reference) {
  const cacheKey = `${reference.book}:${reference.chapter}:${reference.verseStart || ''}-${reference.verseEnd || ''}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!HELLOAO_BOOK_CODES[reference.book]) {
    throw new Error(`Livre biblique inconnu: ${reference.book}`);
  }

  let text = null;
  let provider = null;

  for (const p of BIBLE_PROVIDERS) {
    text = await fetchFromProvider(p, reference);
    if (text) {
      provider = p.name;
      break;
    }
  }

  if (!text) {
    throw new Error('Could not fetch verse from any provider. Check your internet connection.');
  }

  const result = {
    reference: label(reference),
    text: text.trim(),
    provider,
  };

  cache.set(cacheKey, result);
  if (cache.size > 200) {
    cache.delete(cache.keys().next().value);
  }

  return result;
}

module.exports = {
  getVerse,
  buildReferenceLabel: label,
  getProviders: () => BIBLE_PROVIDERS.map((p) => p.name),
  resetFailedProviders: () => {}, // Conservé pour compatibilité avec server.js
  getCacheSize: () => cache.size,
  clearCache: () => { cache.clear(); chapterCache.clear(); },
};
