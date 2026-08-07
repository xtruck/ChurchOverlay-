/**
 * Détecteur de références bibliques en anglais.
 *
 * Miroir de detector.js pour les prédicateurs anglophones. Renvoie EXACTEMENT
 * la même structure ({ book, chapter, verseStart, verseEnd, raw }) et utilise
 * les mêmes CLÉS de livre en interne (`jean`, `psaumes`, `apocalypse`, ...)
 * que detector.js afin que bible-lookup-with-api.js n'ait rien à changer :
 * ces clés servent uniquement de lookup pour HELLOAO_BOOK_CODES / DISPLAY_NAMES.
 *
 * Reconnaît les formats les plus fréquents à l'oral :
 *   "John 3:16", "John chapter 3 verse 16", "John 3 verse 16",
 *   "John chapter 3 verses 16 to 18", "First Corinthians 13:4-7",
 *   "Psalm 23", "Psalms 23:1", "Second Timothy 3:16".
 */
'use strict';

// AJOUT (audit — inspiré de Rhema, correspondance floue sur les noms de
// livres). Miroir du même ajout dans detector.js — voir levenshtein.js.
const { correctBookNameFuzzy } = require('./levenshtein');

// Alias EN → clé interne FR (identique à detector.js).
const BOOKS = {
  genese: ['genesis', 'gen'],
  exode: ['exodus', 'exod', 'exo'],
  levitique: ['leviticus', 'lev'],
  nombres: ['numbers', 'num'],
  deuteronome: ['deuteronomy', 'deut'],
  josue: ['joshua', 'josh'],
  juges: ['judges', 'judg'],
  ruth: ['ruth'],
  '1samuel': ['1 samuel', 'first samuel', 'i samuel'],
  '2samuel': ['2 samuel', 'second samuel', 'ii samuel'],
  '1rois': ['1 kings', 'first kings', 'i kings'],
  '2rois': ['2 kings', 'second kings', 'ii kings'],
  '1chroniques': ['1 chronicles', 'first chronicles', 'i chronicles'],
  '2chroniques': ['2 chronicles', 'second chronicles', 'ii chronicles'],
  esdras: ['ezra'],
  nehemie: ['nehemiah', 'neh'],
  esther: ['esther', 'esth'],
  job: ['job'],
  psaumes: ['psalms', 'psalm', 'ps'],
  proverbes: ['proverbs', 'prov'],
  ecclesiaste: ['ecclesiastes', 'eccl'],
  cantique: ['song of solomon', 'song of songs', 'canticles'],
  esaie: ['isaiah', 'isa'],
  jeremie: ['jeremiah', 'jer'],
  lamentations: ['lamentations', 'lam'],
  ezechiel: ['ezekiel', 'ezek'],
  daniel: ['daniel', 'dan'],
  osee: ['hosea', 'hos'],
  joel: ['joel'],
  amos: ['amos'],
  abdias: ['obadiah', 'obad'],
  jonas: ['jonah'],
  michee: ['micah', 'mic'],
  nahum: ['nahum', 'nah'],
  habacuc: ['habakkuk', 'hab'],
  sophonie: ['zephaniah', 'zeph'],
  aggee: ['haggai', 'hag'],
  zacharie: ['zechariah', 'zech'],
  malachie: ['malachi', 'mal'],
  matthieu: ['matthew', 'matt', 'mt'],
  marc: ['mark', 'mk'],
  luc: ['luke', 'lk'],
  jean: ['john', 'jn'],
  actes: ['acts'],
  romains: ['romans', 'rom'],
  '1corinthiens': ['1 corinthians', 'first corinthians', 'i corinthians'],
  '2corinthiens': ['2 corinthians', 'second corinthians', 'ii corinthians'],
  galates: ['galatians', 'gal'],
  ephesiens: ['ephesians', 'eph'],
  philippiens: ['philippians', 'phil'],
  colossiens: ['colossians', 'col'],
  '1thessaloniciens': ['1 thessalonians', 'first thessalonians', 'i thessalonians'],
  '2thessaloniciens': ['2 thessalonians', 'second thessalonians', 'ii thessalonians'],
  '1timothee': ['1 timothy', 'first timothy', 'i timothy'],
  '2timothee': ['2 timothy', 'second timothy', 'ii timothy'],
  tite: ['titus'],
  philemon: ['philemon', 'phlm'],
  hebreux: ['hebrews', 'heb'],
  jacques: ['james', 'jas'],
  '1pierre': ['1 peter', 'first peter', 'i peter'],
  '2pierre': ['2 peter', 'second peter', 'ii peter'],
  '1jean': ['1 john', 'first john', 'i john'],
  '2jean': ['2 john', 'second john', 'ii john'],
  '3jean': ['3 john', 'third john', 'iii john'],
  jude: ['jude'],
  apocalypse: ['revelation', 'revelations', 'rev'],
};

// Variantes phonétiques (erreurs Whisper base/tiny sur bruit ambiant).
const CHAPTER_VARIANTS = ['chapter', 'chapters', 'chap', 'chpt'];
const VERSE_VARIANTS = ['verse', 'verses', 'vs', 'v', 'vers'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[.,](?=\s|$)/g, ' ') // enlève les ponctuations de fin de segment
    .replace(/\s+/g, ' ')
    .trim();
}

// Chiffres écrits en toutes lettres (usuel à l'oral pour les versets).
const NUMBER_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  fifth: 5,
  '5th': 5,
  sixth: 6,
  '6th': 6,
  seventh: 7,
  '7th': 7,
  eighth: 8,
  '8th': 8,
  ninth: 9,
  '9th': 9,
  tenth: 10,
  '10th': 10,
  eleventh: 11,
  '11th': 11,
  twelfth: 12,
  '12th': 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
};
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join('|');

function numberWordsToDigits(text) {
  return text.replace(
    new RegExp(
      `\\b(?:${NUMBER_WORD_PATTERN})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUMBER_WORD_PATTERN}))*\\b`,
      'g'
    ),
    (words) => {
      const tokens = words
        .replace(/-/g, ' ')
        .split(/\s+/)
        .filter((t) => t !== 'and');
      let current = 0;
      for (const tok of tokens) {
        const v = NUMBER_WORDS[tok];
        if (v === undefined) continue;
        if (v === 100) current = Math.max(1, current) * 100;
        else current += v;
      }
      return String(current);
    }
  );
}

// Trie les alias par longueur DESC pour matcher "1 corinthians" avant "corinthians".
const aliases = Object.entries(BOOKS)
  .flatMap(([book, names]) => names.map((name) => ({ book, name })))
  .sort((a, b) => b.name.length - a.name.length);

// Uniformise les variantes chapter/verse.
function normalizeKeywords(text) {
  let out = text;
  for (const v of CHAPTER_VARIANTS) {
    if (v === 'chapter') continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(v)}\\b`, 'gi'), 'chapter');
  }
  for (const v of VERSE_VARIANTS) {
    if (v === 'verse') continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(v)}\\b`, 'gi'), 'verse');
  }
  return out;
}

// Boucle de détection exacte, extraite pour pouvoir être rejouée sur un
// texte corrigé par la correspondance floue (voir detect() ci-dessous).
function matchAgainstAliases(normalized) {
  for (const { book, name } of aliases) {
    const escaped = escapeRegExp(name).replace(/\s+/g, '\\s+');

    // Inverted Spoken Pattern 1: "verse 16 of chapter 3 of John" / "verse 16 of John chapter 3"
    const invPattern1 = new RegExp(
      `\\bverse(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|to|through)\\s*(\\d{1,3}))?\\s+(?:of|in)?\\s*chapter\\s+(\\d{1,3})\\s+(?:of|in)?\\s*${escaped}\\b`,
      'i'
    );
    const mInv1 = normalized.match(invPattern1);
    if (mInv1) {
      const vStart = Number(mInv1[1]);
      const vEnd = mInv1[2] ? Number(mInv1[2]) : vStart;
      const ch = Number(mInv1[3]);
      if (ch > 0 && ch <= 150 && vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
        return { book, chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv1[0].trim() };
      }
    }

    // Inverted Spoken Pattern 2: "chapter 3 of John verse 16"
    const invPattern2 = new RegExp(
      `\\bchapter\\s+(\\d{1,3})\\s+(?:of|in)?\\s*${escaped}\\s+(?:verse(?:s)?\\s+)?(\\d{1,3})(?:\\s*(?:-|to|through)\\s*(\\d{1,3}))?\\b`,
      'i'
    );
    const mInv2 = normalized.match(invPattern2);
    if (mInv2) {
      const ch = Number(mInv2[1]);
      const vStart = Number(mInv2[2]);
      const vEnd = mInv2[3] ? Number(mInv2[3]) : vStart;
      if (ch > 0 && ch <= 150 && vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
        return { book, chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv2[0].trim() };
      }
    }

    // Inverted Spoken Pattern 3: "verse 16 of John 3"
    const invPattern3 = new RegExp(
      `\\bverse(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|to|through)\\s*(\\d{1,3}))?\\s+(?:of|in)?\\s*${escaped}\\s+(?:chapter\\s+)?(\\d{1,3})\\b`,
      'i'
    );
    const mInv3 = normalized.match(invPattern3);
    if (mInv3) {
      const vStart = Number(mInv3[1]);
      const vEnd = mInv3[2] ? Number(mInv3[2]) : vStart;
      const ch = Number(mInv3[3]);
      if (ch > 0 && ch <= 150 && vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
        return { book, chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv3[0].trim() };
      }
    }

    // "John 3:16" | "John chapter 3 verse 16" | "John 3 verse 16" |
    // "John 3, 16" | "John 3:16-18" | "John chapter 3 verses 16 to 18"
    const pattern = new RegExp(
      `(?:^|\\s)${escaped}\\s+` +
        `(?:chapter\\s+)?` +
        `(\\d{1,3})` +
        `(?:` +
        `\\s*` +
        `(?:` +
        `[:,]\\s*(?:verse(?:s)?\\s+)?(\\d{1,3})` +
        `|` +
        `\\s+verse(?:s)?\\s+(\\d{1,3})` +
        `|` +
        `\\s+(\\d{1,3})` +
        `)` +
        `(?:` +
        `\\s*(?:-|to|through)\\s*(\\d{1,3})` +
        `)?` +
        `)?` +
        `(?=$|[\\s,.;!?)])`,
      'i'
    );

    const match = normalized.match(pattern);
    if (!match) continue;

    const chapter = Number(match[1]);
    const verseStart =
      match[2] || match[3] || match[4] ? Number(match[2] || match[3] || match[4]) : undefined;
    const verseEnd = match[5] ? Number(match[5]) : verseStart;

    if (chapter > 0 && chapter <= 150) {
      if (verseStart !== undefined && (verseStart <= 0 || verseStart > 200)) continue;
      if (verseEnd !== undefined && (verseEnd < verseStart || verseEnd > 200)) continue;
      return { book, chapter, verseStart, verseEnd, raw: match[0].trim() };
    }
  }
  return null;
}

function detectExact(text) {
  const normalized = numberWordsToDigits(normalizeKeywords(normalize(text)));
  return matchAgainstAliases(normalized);
}

function detect(text) {
  const normalized = numberWordsToDigits(normalizeKeywords(normalize(text)));
  const exact = matchAgainstAliases(normalized);
  if (exact) return exact;

  // AJOUT (audit — inspiré de Rhema, correspondance floue). Filet de
  // secours ciblé, identique en principe à celui de detector.js (FR) :
  // un seul essai de correction, rejoué une seule fois.
  const corrected = correctBookNameFuzzy(normalized, aliases);
  if (!corrected) return null;

  const fuzzyMatch = matchAgainstAliases(corrected.text);
  if (fuzzyMatch) {
    console.log(
      `[detector-en] Fuzzy match: "${corrected.original}" → "${corrected.name}" ` +
        `(distance ${corrected.distance})`
    );
  }
  return fuzzyMatch;
}

module.exports = { detect, detectExact, normalize, numberWordsToDigits, BOOKS };
