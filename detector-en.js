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
// CUTOVER (support bilingue FR/EN, lot 10) : BOOKS était auparavant un
// littéral dupliqué (à l'identique) entre ce fichier et detector.js — voir
// book-catalog.js (lot 8), qui fusionne déjà les deux et sert maintenant de
// SOURCE UNIQUE. Dérivé ici (pas retapé) pour garantir un contenu
// strictement identique à l'ancien littéral — verrouillé par
// test-book-catalog.js (lot 8) et par le fait que test-detector-en.js (ce
// fichier) passe sans aucune modification.
const { BOOK_CATALOG, SINGLE_CHAPTER_BOOKS } = require('./book-catalog');
// Alias EN → clé interne FR (identique à detector.js).
const BOOKS = Object.fromEntries(Object.entries(BOOK_CATALOG).map(([key, { en }]) => [key, en]));

// CUTOVER (support bilingue FR/EN, lot 11a) : ces listes de déformations
// phonétiques Whisper étaient auparavant un littéral dupliqué distinct de
// celui de detector.js — voir keyword-variants.js, qui fusionne désormais
// les deux et sert de SOURCE UNIQUE, avec un contrôle de collision FR/EN
// permanent (test-keyword-variants.js). Étendez les listes dans
// keyword-variants.js désormais, pas ici.
const { KEYWORD_VARIANTS } = require('./keyword-variants');
const CHAPTER_VARIANTS = KEYWORD_VARIANTS.chapitre.en;
const VERSE_VARIANTS = KEYWORD_VARIANTS.verset.en;

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

// CUTOVER (support bilingue FR/EN, lot 10) : voir number-words.js (lot 9),
// fusion des tables NUMBER_WORDS de ce fichier et de detector.js —
// verrouillée par test-number-words.js et par le fait que
// test-detector-en.js (ce fichier) passe sans aucune modification.
const { numberWordsToDigits: sharedNumberWordsToDigits } = require('./number-words');

function numberWordsToDigits(text) {
  return sharedNumberWordsToDigits(text, 'en');
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

// EXTRACTION (support bilingue FR/EN, lot 11b) : corps de boucle de
// matchAgainstAliases ci-dessous, isolé pour UN SEUL alias — miroir de
// l'extraction équivalente dans detector.js, nécessaire pour que
// bilingual-matcher.js puisse entrelacer les alias FR et EN dans UNE SEULE
// boucle triée par longueur. Extraction MÉCANIQUE : tous les `continue`
// deviennent `return null`, aucune logique de matching modifiée —
// verrouillé par le fait que test-detector-en.js passe sans aucune
// modification.
function testAlias(normalized, name, book) {
  const escaped = escapeRegExp(name).replace(/\s+/g, '\\s+');
  const isSingleChapterBook = SINGLE_CHAPTER_BOOKS.has(book);

  // AJOUT (Chantier A.1 — livres à chapitre unique) : "Philemon verse 6",
  // "Jude verse 3" — miroir exact de la même addition dans detector.js
  // (FR). Testé avant tout le reste, uniquement pour les livres concernés.
  if (isSingleChapterBook) {
    const verseOnly = new RegExp(
      `\\b${escaped}\\s+verse(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|to|through)\\s*(\\d{1,3}))?\\b`,
      'i'
    );
    const mVerseOnly = normalized.match(verseOnly);
    if (mVerseOnly) {
      const vStart = Number(mVerseOnly[1]);
      const vEnd = mVerseOnly[2] ? Number(mVerseOnly[2]) : vStart;
      if (vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
        return { chapter: 1, verseStart: vStart, verseEnd: vEnd, raw: mVerseOnly[0].trim() };
      }
    }
    const verseOnlyReversed = new RegExp(
      `\\bverse(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|to|through)\\s*(\\d{1,3}))?\\s+(?:of|in)?\\s*${escaped}\\b`,
      'i'
    );
    const mVerseOnlyReversed = normalized.match(verseOnlyReversed);
    if (mVerseOnlyReversed) {
      const vStart = Number(mVerseOnlyReversed[1]);
      const vEnd = mVerseOnlyReversed[2] ? Number(mVerseOnlyReversed[2]) : vStart;
      if (vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
        return {
          chapter: 1,
          verseStart: vStart,
          verseEnd: vEnd,
          raw: mVerseOnlyReversed[0].trim(),
        };
      }
    }
  }

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
      return { chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv1[0].trim() };
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
      return { chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv2[0].trim() };
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
      return { chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv3[0].trim() };
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
  if (!match) return null;

  const chapter = Number(match[1]);
  const verseStart =
    match[2] || match[3] || match[4] ? Number(match[2] || match[3] || match[4]) : undefined;
  const verseEnd = match[5] ? Number(match[5]) : verseStart;

  if (chapter > 0 && chapter <= 150) {
    if (verseStart !== undefined && (verseStart <= 0 || verseStart > 200)) return null;
    if (verseEnd !== undefined && (verseEnd < verseStart || verseEnd > 200)) return null;
    // AJOUT (Chantier A.1) : "Philemon 6" — miroir exact de detector.js.
    if (isSingleChapterBook && verseStart === undefined) {
      return { chapter: 1, verseStart: chapter, verseEnd: chapter, raw: match[0].trim() };
    }
    return { chapter, verseStart, verseEnd, raw: match[0].trim() };
  }
  return null;
}

// Boucle de détection exacte, extraite pour pouvoir être rejouée sur un
// texte corrigé par la correspondance floue (voir detect() ci-dessous).
function matchAgainstAliases(normalized) {
  for (const { book, name } of aliases) {
    const result = testAlias(normalized, name, book);
    if (result) return { book, ...result };
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

module.exports = {
  detect,
  detectExact,
  normalize,
  numberWordsToDigits,
  BOOKS,
  // AJOUT (support bilingue FR/EN, lot 11b) : exports additifs pour
  // bilingual-matcher.js — aucun appelant existant n'est affecté.
  aliases,
  testAlias,
  normalizeKeywords,
};
