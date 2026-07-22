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
];
const VERSET_VARIANTS = [
  'verset', 'versets', 'vecc', 'vece', 'vsc', 'vc', 'veille',
];

function correctPhoneticNoise(text) {
  let result = text;
  for (const variant of CHAPITRE_VARIANTS) {
    if (variant === 'chapitre') continue;
    result = result.replace(new RegExp(`\\b${variant}\\b`, 'gi'), 'chapitre');
  }
  for (const variant of VERSET_VARIANTS) {
    if (variant === 'verset' || variant === 'versets') continue;
    result = result.replace(new RegExp(`\\b${variant}\\b`, 'gi'), 'verset');
  }
  return result;
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
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // Accepte « Jean 3:16 », « Jean chapitre 3 versets 16 à 18 » et « Jean 3 16 ».
    const pattern = new RegExp(`(?:^|\\s)${escaped}\\s+(?:chapitre\\s+)?(\\d{1,3})(?:\\s*(?::|,|\\s+verset(?:s)?\\s+|\\s+)(\\d{1,3})(?:\\s*(?:-|a|à|au)\\s*(\\d{1,3}))?)?(?=$|[\\s,.;!?)])`, 'i');
    const match = normalized.match(pattern);
    if (!match) continue;
    const chapter = Number(match[1]);
    const verseStart = match[2] ? Number(match[2]) : undefined;
    const verseEnd = match[3] ? Number(match[3]) : verseStart;
    if (chapter > 0 && (!verseStart || verseStart > 0) && (!verseEnd || verseEnd >= verseStart)) {
      return { book, chapter, verseStart, verseEnd, raw: match[0].trim() };
    }
  }
  return null;
}

module.exports = { detect, normalize, numberWordsToDigits, BOOKS };
