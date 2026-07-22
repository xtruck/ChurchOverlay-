/**
 * Bible Lookup Module with Free API Fallback
 * Uses multiple free Bible APIs for maximum reliability
 */
'use strict';

const cache = new Map();

// Free Bible API providers (in order of preference)
const BIBLE_PROVIDERS = [
  {
    name: 'genuinegospel',
    url: 'https://genuinegospel.com/api/verses/french/{book}/{chapter}/{verse}',
    parseResponse: (resp) => resp.text,
    needsAuth: false,
  },
  {
    name: 'getbible-free',
    url: 'https://cdn.jsdelivr.net/gh/aruljohn/bible-api@master/bibles/fr.json',
    parseResponse: (resp, ref) => {
      // This is a full Bible dump, extract the verse
      const bookKey = ref.book.toLowerCase();
      if (resp[bookKey] && resp[bookKey][ref.chapter] && resp[bookKey][ref.chapter][ref.verseStart]) {
        return resp[bookKey][ref.chapter][ref.verseStart].text;
      }
      return null;
    },
    needsAuth: false,
    isBulkDownload: true,
  },
];

const API_BOOK_CODES = {
  genese: 'genesis', exode: 'exodus', levitique: 'leviticus', nombres: 'numbers',
  deuteronome: 'deuteronomy', josue: 'joshua', juges: 'judges', ruth: 'ruth',
  '1samuel': '1-samuel', '2samuel': '2-samuel', '1rois': '1-kings',
  '2rois': '2-kings', '1chroniques': '1-chronicles', '2chroniques': '2-chronicles',
  esdras: 'ezra', nehemie: 'nehemiah', esther: 'esther', job: 'job',
  psaumes: 'psalms', proverbes: 'proverbs', ecclesiaste: 'ecclesiastes',
  cantique: 'song-of-songs', esaie: 'isaiah', jeremie: 'jeremiah',
  lamentations: 'lamentations', ezechiel: 'ezekiel', daniel: 'daniel',
  osee: 'hosea', joel: 'joel', amos: 'amos', abdias: 'obadiah',
  jonas: 'jonah', michee: 'micah', nahum: 'nahum', habacuc: 'habakkuk',
  sophonie: 'zephaniah', aggee: 'haggai', zacharie: 'zechariah',
  malachie: 'malachi', matthieu: 'matthew', marc: 'mark', luc: 'luke',
  jean: 'john', actes: 'acts', romains: 'romans', '1corinthiens': '1-corinthians',
  '2corinthiens': '2-corinthians', galates: 'galatians', ephesiens: 'ephesians',
  philippiens: 'philippians', colossiens: 'colossians',
  '1thessaloniciens': '1-thessalonians', '2thessaloniciens': '2-thessalonians',
  '1timothee': '1-timothy', '2timothee': '2-timothy', tite: 'titus',
  philemon: 'philemon', hebreux: 'hebrews', jacques: 'james',
  '1pierre': '1-peter', '2pierre': '2-peter', '1jean': '1-john',
  '2jean': '2-john', '3jean': '3-john', jude: 'jude', apocalypse: 'revelation',
};

const DISPLAY_NAMES = {
  jean: 'Jean', matthieu: 'Matthieu', marc: 'Marc', luc: 'Luc',
  actes: 'Actes', romains: 'Romains', psaumes: 'Psaumes', proverbes: 'Proverbes',
  genese: 'Genèse', exode: 'Exode', ephesiens: 'Éphésiens',
  philippiens: 'Philippiens', hebreux: 'Hébreux', apocalypse: 'Apocalypse',
};

function label({ book, chapter, verseStart, verseEnd }) {
  const name = DISPLAY_NAMES[book] || book;
  return !verseStart
    ? `${name} ${chapter}`
    : `${name} ${chapter}:${verseStart}${verseEnd && verseEnd !== verseStart ? `-${verseEnd}` : ''}`;
}

async function fetchFromProvider(provider, reference) {
  try {
    const url = provider.url
      .replace('{book}', API_BOOK_CODES[reference.book] || reference.book)
      .replace('{chapter}', reference.chapter)
      .replace('{verse}', reference.verseStart || 1);

    console.log(`[bible-lookup] Trying ${provider.name}...`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'ChurchOverlay/1.0' },
      timeout: 5000,
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const text = provider.parseResponse(data, reference);

    if (!text) {
      throw new Error('No text in response');
    }

    console.log(`[bible-lookup] ✓ Got verse from ${provider.name}`);
    return text;
  } catch (error) {
    console.warn(`[bible-lookup] ✗ ${provider.name} failed: ${error.message}`);
    return null;
  }
}

async function getVerse(reference) {
  // Check cache first
  const cacheKey = `${reference.book}:${reference.chapter}:${reference.verseStart}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  // Validate input
  if (!API_BOOK_CODES[reference.book]) {
    throw new Error(`Unknown book: ${reference.book}`);
  }

  let text = null;
  let provider = null;

  // Try each provider until one works
  for (const p of BIBLE_PROVIDERS) {
    text = await fetchFromProvider(p, reference);
    if (text) {
      provider = p.name;
      break;
    }
  }

  if (!text) {
    throw new Error(
      `Could not fetch verse from any provider. Check your internet connection or configure BIBLE_API_KEY.`
    );
  }

  const result = {
    reference: label(reference),
    text: text.trim(),
    provider: provider,
  };

  // Cache it
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
  resetFailedProviders: () => {}, // For compatibility
  getCacheSize: () => cache.size,
  clearCache: () => cache.clear(),
};
