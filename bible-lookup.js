/**
 * Recherche d'un passage biblique - version locale
 * Utilise un fichier JSON local au lieu d'APIs externes.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BIBLE_FILE = path.join(__dirname, 'bible-lsg.json');

let bibleData = null;

function loadBible() {
  if (bibleData) return bibleData;
  try {
    const raw = fs.readFileSync(BIBLE_FILE, 'utf8');
    bibleData = JSON.parse(raw);
    console.log('[bible-lookup] Bible chargée:', Object.keys(bibleData).length, 'livres');
    return bibleData;
  } catch (e) {
    console.error('[bible-lookup] Erreur chargement Bible:', e.message);
    return null;
  }
}

const API_BOOK_CODES = { 
  genese:'genese', exode:'exode', levitique:'levitique', nombres:'nombres', deuteronome:'deuteronome',
  josue:'josue', juges:'juges', ruth:'ruth', '1samuel':'1samuel', '2samuel':'2samuel',
  '1rois':'1rois', '2rois':'2rois', '1chroniques':'1chroniques', '2chroniques':'2chroniques',
  esdras:'esdras', nehemie:'nehemie', esther:'esther', job:'job', psaumes:'psaumes',
  proverbes:'proverbes', ecclesiaste:'ecclesiaste', cantique:'cantique', esaie:'esaie', jeremie:'jeremie',
  lamentations:'lamentations', ezechiel:'ezechiel', daniel:'daniel', osee:'osee', joel:'joel',
  amos:'amos', abdias:'abdias', jonas:'jonas', michee:'michee', nahum:'nahum',
  habacuc:'habacuc', sophonie:'sophonie', aggee:'aggee', zacharie:'zacharie', malachie:'malachie',
  matthieu:'matthieu', marc:'marc', luc:'luc', jean:'jean', actes:'actes', romains:'romains',
  '1corinthiens':'1corinthiens', '2corinthiens':'2corinthiens', galates:'galates', ephesiens:'ephesiens',
  philippiens:'philippiens', colossiens:'colossiens', '1thessaloniciens':'1thessaloniciens',
  '2thessaloniciens':'2thessaloniciens', '1timothee':'1timothee', '2timothee':'2timothee',
  tite:'tite', philemon:'philemon', hebreux:'hebreux', jacques:'jacques', '1pierre':'1pierre',
  '2pierre':'2pierre', '1jean':'1jean', '2jean':'2jean', '3jean':'3jean',
  jude:'jude', apocalypse:'apocalypse'
};

const DISPLAY_NAMES = { 
  ...Object.fromEntries(Object.keys(API_BOOK_CODES).map((key) => [key, key])),
  jean:'Jean', matthieu:'Matthieu', marc:'Marc', luc:'Luc',
  actes:'Actes', romains:'Romains', psaumes:'Psaumes', proverbes:'Proverbes',
  genese:'Genèse', exode:'Exode', ephesiens:'Éphésiens',
  philippiens:'Philippiens', hebreux:'Hébreux', apocalypse:'Apocalypse'
};

const cache = new Map();
let onError = null;

function label({ book, chapter, verseStart, verseEnd }) { 
  const name = DISPLAY_NAMES[book] || book; 
  return !verseStart ? `${name} ${chapter}` : 
    `${name} ${chapter}:${verseStart}${verseEnd && verseEnd !== verseStart ? `-${verseEnd}` : ''}`; 
}

async function getVerse(reference) {
  const data = loadBible();
  if (!data) throw new Error('Bible non disponible');
  
  const bookKey = API_BOOK_CODES[reference.book];
  if (!bookKey) throw new Error(`Livre non trouvé: ${reference.book}`);
  
  const book = data[bookKey];
  if (!book) throw new Error(`Livre non disponible: ${DISPLAY_NAMES[reference.book] || reference.book}`);
  
  const chapter = book[String(reference.chapter)];
  if (!chapter) throw new Error(`Chapitre non trouvé: ${label(reference)}`);
  
  const verseKey = `${reference.book}:${reference.chapter}:${reference.verseStart}`;
  if (cache.has(verseKey)) return cache.get(verseKey);
  
  let text;
  
  if (reference.verseStart) {
    // Get specific verse(s)
    if (reference.verseEnd && reference.verseEnd !== reference.verseStart) {
      // Range of verses
      const verses = [];
      for (let v = reference.verseStart; v <= reference.verseEnd; v++) {
        const verseText = chapter[String(v)];
        if (verseText) verses.push(verseText);
      }
      text = verses.join(' ');
    } else {
      // Single verse
      text = chapter[String(reference.verseStart)];
    }
    
    if (!text) throw new Error(`Verset non trouvé: ${label(reference)}`);
  } else {
    // Whole chapter
    text = Object.values(chapter).join(' ');
  }
  
  const result = { 
    reference: label(reference), 
    text: text.trim(), 
    provider: 'local' 
  };
  
  cache.set(verseKey, result);
  if (cache.size > 200) {
    cache.delete(cache.keys().next().value);
  }
  
  return result;
}

// Test mode
if (require.main === module) {
  console.log('=== Test bible-lookup.js (local) ===\n');
  
  const tests = [
    { book: 'jean', chapter: 3, verseStart: 16 },
    { book: 'jean', chapter: 3, verseStart: 4 },
    { book: 'psaumes', chapter: 23, verseStart: 1 },
    { book: 'matthieu', chapter: 5, verseStart: 3, verseEnd: 5 },
    { book: 'jean', chapter: 1, verseStart: 1 },
  ];
  
  (async () => {
    let success = 0;
    let failed = 0;
    
    for (const test of tests) {
      try {
        const result = await getVerse(test);
        console.log(`✅ ${result.reference}: "${result.text.substring(0, 80)}..."`);
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

module.exports = { 
  getVerse, 
  on: (callbacks) => { onError = callbacks && callbacks.onError; }, 
  clearCache: () => cache.clear(), 
  buildReferenceLabel: label, 
  getApiBookCodes: () => ({ ...API_BOOK_CODES }),
  getProviders: () => ['local'],
  resetFailedProviders: () => {},
  getCacheSize: () => cache.size
};
