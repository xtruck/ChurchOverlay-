/** Détecte les références bibliques citées en français dans une transcription. */
'use strict';

const BOOKS = {
  genese: ['genese', 'gen'], exode: ['exode', 'exo'], levitique: ['levitique', 'lev'],
  nombres: ['nombres', 'nom'], deuteronome: ['deuteronome', 'deut'], josue: ['josue', 'jos'],
  juges: ['juges', 'jug'], ruth: ['ruth'], '1samuel': ['1 samuel', 'premier samuel'],
  '2samuel': ['2 samuel', 'deuxieme samuel'], '1rois': ['1 rois', 'premier rois'],
  '2rois': ['2 rois', 'deuxieme rois'], '1chroniques': ['1 chroniques', 'premier chroniques'],
  '2chroniques': ['2 chroniques', 'deuxieme chroniques'], esdras: ['esdras'], nehemie: ['nehemie'],
  esther: ['esther'], job: ['job'], psaumes: ['psaumes', 'psaume', 'ps'], proverbes: ['proverbes', 'prov'],
  ecclesiaste: ['ecclesiaste', 'qohélet', 'qohelet'], cantique: ['cantique'], esaie: ['esaie', 'es'],
  jeremie: ['jeremie', 'jer'], lamentations: ['lamentations', 'lam'], ezechiel: ['ezechiel', 'ez'],
  daniel: ['daniel', 'dan'], osee: ['osee', 'os'], joel: ['joel'], amos: ['amos'], abdias: ['abdias'],
  jonas: ['jonas'], michee: ['michee', 'mi'], nahum: ['nahum'], habacuc: ['habacuc', 'ha'],
  sophonie: ['sophonie', 'so'], aggee: ['aggee', 'ag'], zacharie: ['zacharie', 'za'], malachie: ['malachie', 'ml'],
  matthieu: ['matthieu', 'mathieu', 'mt'], marc: ['marc', 'mc'], luc: ['luc', 'lc'], jean: ['jean', 'jn'],
  actes: ['actes', 'ac'], romains: ['romains', 'rom', 'rm'], '1corinthiens': ['1 corinthiens', 'premier corinthiens'],
  '2corinthiens': ['2 corinthiens', 'deuxieme corinthiens'], galates: ['galates', 'ga'], ephesiens: ['ephesiens', 'ep'],
  philippiens: ['philippiens', 'php'], colossiens: ['colossiens', 'col'], '1thessaloniciens': ['1 thessaloniciens', 'premier thessaloniciens'],
  '2thessaloniciens': ['2 thessaloniciens', 'deuxieme thessaloniciens'], '1timothee': ['1 timothee', 'premier timothee'],
  '2timothee': ['2 timothee', 'deuxieme timothee'], tite: ['tite'], philemon: ['philemon'], hebreux: ['hebreux', 'heb'],
  jacques: ['jacques', 'jc'], '1pierre': ['1 pierre', 'premier pierre'], '2pierre': ['2 pierre', 'deuxieme pierre'],
  '1jean': ['1 jean', 'premier jean'], '2jean': ['2 jean', 'deuxieme jean'], '3jean': ['3 jean', 'troisieme jean'],
  jude: ['jude'], apocalypse: ['apocalypse', 'ap']
};

// Corrige les déformations phonétiques courantes produites par Whisper
// (surtout en base/tiny sur bruit ambiant) pour "chapitre" et "verset".
// Étendez ces listes au fur et à mesure que vous observez de nouvelles
// variantes dans vos logs de transcription réels. Chaque variante doit être
// déjà en minuscules/sans accents, car elle est appliquée APRÈS le
// dé-accentuage NFD dans normalize().
const CHAPITRE_VARIANTS = [
  'chapitre', 'chappitois', 'sabitoire', 'chabitouale', 'sapitois', 'chapitois',
  'chappitre', 'chappite', 'chapite', 'chapit', 'chaptre',
];
const VERSET_VARIANTS = [
  'verset', 'versets', 'vecc', 'vece', 'vsc', 'vc', 'veille',
  'versai', 'verse', 'verce', 'vercet', 'versait',
];

function correctPhoneticNoise(text) {
  let result = text;
  for (const variant of CHAPITRE_VARIANTS) {
    if (variant === 'chapitre') continue;
    result = result.replace(new RegExp(`\\b${escapeRegExp(variant)}\\b`, 'gi'), 'chapitre');
  }
  for (const variant of VERSET_VARIANTS) {
    if (variant === 'verset' || variant === 'versets') continue;
    result = result.replace(new RegExp(`\\b${escapeRegExp(variant)}\\b`, 'gi'), 'verset');
  }
  return result;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value) {
  const base = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();
  return correctPhoneticNoise(base);
}

const NUMBER_WORDS = {
  zero: 0, un: 1, une: 1, premier: 1, premiere: 1, deux: 2, trois: 3,
  quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
  dixsept: 17, dixhuit: 18, dixneuf: 19, vingt: 20, trente: 30,
  quarante: 40, cinquante: 50, soixante: 60, cent: 100, cents: 100,
};
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join('|');

function numberWordsToDigits(text) {
  return text.replace(new RegExp(`\\b(?:${NUMBER_WORD_PATTERN})(?:[\\s-]+(?:et[\\s-]+)?(?:${NUMBER_WORD_PATTERN}))*\\b`, 'g'), (words) => {
    const tokens = words.replace(/-/g, ' ').split(/\s+/).filter((token) => token !== 'et');
    let total = 0;
    let current = 0;
    for (const token of tokens) {
      const value = NUMBER_WORDS[token];
      if (value === 100) current = Math.max(1, current) * 100;
      else if (value === 20 && current === 4) current = 80; // quatre-vingt
      else current += value;
    }
    return String(total + current);
  });
}

const aliases = Object.entries(BOOKS).flatMap(([book, names]) => names.map((name) => ({ book, name })))
  .sort((a, b) => b.name.length - a.name.length);

function detect(text) {
  const normalized = numberWordsToDigits(normalize(text));
  
  for (const { book, name } of aliases) {
    const escaped = escapeRegExp(name).replace(/\s+/g, '\\s+');
    
    // Pattern that handles ALL formats:
    // "Jean 3:4", "Jean chapitre 3, verset 4", "Jean 3 4", "Jean 3:4-6",
    // "Jean chapitre 3 versets 16 à 18", "Jean 3, verset 4"
    const pattern = new RegExp(
      `(?:^|\\s)${escaped}\\s+` +                    // Book name
      `(?:chapitre\\s+)?` +                          // Optional "chapitre"
      `(\\d{1,3})` +                                 // Chapter (group 1)
      `(?:` +                                        // Start optional verse group
        `\\s*` +                                     // Optional whitespace
        `(?:` +
          `[:,]\\s*` +                               // Colon or comma
          `(?:verset(?:s)?\\s+)?` +                  // Optional "verset" after colon/comma
          `(\\d{1,3})` +                             // Verse start (group 2) - colon/comma format
          `|` +
          `\\s+verset(?:s)?\\s+` +                   // " verset "
          `(\\d{1,3})` +                             // Verse start (group 3) - "verset" format
          `|` +
          `\\s+` +                                   // Just whitespace
          `(\\d{1,3})` +                             // Verse start (group 4) - space format
        `)` +
        `(?:` +                                      // Optional verse range
          `\\s*` +
          `(?:-|a|à|au)` +                           // Range separator
          `\\s*` +
          `(\\d{1,3})` +                             // Verse end (group 5)
        `)?` +
      `)?` +
      `(?=$|[\\s,.;!?)])`,                           // Word boundary
      'i'
    );
    
    const match = normalized.match(pattern);
    if (!match) continue;
    
    const chapter = Number(match[1]);
    
    // Get verse start from whichever group captured it (2, 3, or 4)
    const verseStart = (match[2] || match[3] || match[4]) 
      ? Number(match[2] || match[3] || match[4]) 
      : undefined;
    
    // Get verse end (group 5) or default to verse start
    const verseEnd = match[5] ? Number(match[5]) : verseStart;
    
    // Validation
    if (chapter > 0 && chapter <= 150) {
      if (verseStart && (verseStart <= 0 || verseStart > 200)) continue;
      if (verseEnd && (verseEnd < verseStart || verseEnd > 200)) continue;
      
      return { 
        book, 
        chapter, 
        verseStart, 
        verseEnd, 
        raw: match[0].trim() 
      };
    }
  }
  
  return null;
}

// Quick test when run directly
if (require.main === module) {
  console.log('=== Testing detector.js ===\n');
  
  const tests = [
    // Formats that should work
    { text: 'Jean chapitre 3, verset 4', expected: true },
    { text: 'Jean 3:4', expected: true },
    { text: 'Jean 3:4-6', expected: true },
    { text: 'Matthieu chapitre 5, verset 3', expected: true },
    { text: 'Psaumes 23:1', expected: true },
    { text: '1 Corinthiens 13:4-7', expected: true },
    { text: 'Jean chapitre 3 versets 16 à 18', expected: true },
    { text: 'Romains 8:28', expected: true },
    { text: 'Apocalypse 21:4', expected: true },
    
    // Edge cases
    { text: 'Jean 3', expected: false }, // Chapter only, no verse
    { text: 'Jean chapitre 3', expected: false }, // Chapter only
    
    // Phonetic variations (Whisper errors)
    { text: 'Jean chappitois 3, vece 4', expected: true },
    { text: 'Jean sapitois 3, vsc 4', expected: true },
    
    // Should NOT match
    { text: "Ce qu'il va manger", expected: false },
    { text: 'Merci beaucoup', expected: false },
    { text: 'Obrigada', expected: false },
    
    // Mixed language
    { text: 'Se abarde', expected: false },
  ];
  
  let passed = 0;
  let failed = 0;
  
  tests.forEach(({ text, expected }) => {
    const result = detect(text);
    const detected = result !== null;
    const status = detected === expected ? '✅' : '❌';
    
    if (detected === expected) passed++;
    else failed++;
    
    console.log(`${status} "${text}"`);
    if (result) {
      console.log(`   → ${result.book} ${result.chapter}:${result.verseStart || ''}${result.verseEnd && result.verseEnd !== result.verseStart ? '-' + result.verseEnd : ''}`);
    } else if (expected) {
      console.log(`   → Expected match but got null`);
    }
    console.log('');
  });
  
  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
}

module.exports = { detect, normalize, numberWordsToDigits, BOOKS };
