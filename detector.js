/** Détecte les références bibliques citées en français dans une transcription. */
'use strict';

// AJOUT (audit — inspiré de Rhema, correspondance floue sur les noms de
// livres). Voir levenshtein.js pour le détail : ce module ne connaît aucun
// nom de livre, il ne fait que comparer des chaînes.
const { correctBookNameFuzzy } = require('./levenshtein');

const BOOKS = {
  genese: ['genese', 'gen', 'livre de la genese', 'livre de genese'],
  exode: ['exode', 'exo', 'livre de l exode', 'livre d exode'],
  levitique: ['levitique', 'lev', 'livre du levitique'],
  nombres: ['nombres', 'nom', 'livre des nombres'],
  deuteronome: ['deuteronome', 'deut', 'livre du deuteronome'],
  josue: ['josue', 'jos', 'livre de josue'],
  juges: ['juges', 'jug', 'livre des juges'],
  ruth: ['ruth', 'livre de ruth', 'rt'],
  '1samuel': [
    '1 samuel',
    '1er samuel',
    '1ere samuel',
    'premier samuel',
    'premier livre de samuel',
    '1 livre de samuel',
    'i samuel',
  ],
  '2samuel': [
    '2 samuel',
    '2eme samuel',
    'deuxieme samuel',
    'second samuel',
    'deuxieme livre de samuel',
    '2 livre de samuel',
    'ii samuel',
  ],
  '1rois': [
    '1 rois',
    '1er rois',
    'premier rois',
    'premier livre des rois',
    '1 livre des rois',
    'i rois',
  ],
  '2rois': [
    '2 rois',
    '2eme rois',
    'deuxieme rois',
    'second rois',
    'deuxieme livre des rois',
    '2 livre des rois',
    'ii rois',
  ],
  '1chroniques': [
    '1 chroniques',
    '1er chroniques',
    'premier chroniques',
    'premier livre des chroniques',
    'i chroniques',
  ],
  '2chroniques': [
    '2 chroniques',
    '2eme chroniques',
    'deuxieme chroniques',
    'second chroniques',
    'deuxieme livre des chroniques',
    'ii chroniques',
  ],
  esdras: ['esdras', 'livre d esdras', 'esd'],
  nehemie: ['nehemie', 'livre de nehemie', 'ne'],
  esther: ['esther', 'livre d esther', 'est'],
  job: ['job', 'livre de job', 'jb'],
  psaumes: ['psaumes', 'psaume', 'ps', 'livre des psaumes', 'somme', 'sommes', 'tome', 'tomes'],
  proverbes: ['proverbes', 'prov', 'livre des proverbes'],
  ecclesiaste: ['ecclesiaste', 'qohélet', 'qohelet', 'livre de l ecclesiaste'],
  cantique: ['cantique des cantiques', 'cantique', 'ct', 'cantique de salomon'],
  esaie: ['esaie', 'es', 'livre d esaie', 'prophete esaie'],
  jeremie: ['jeremie', 'jer', 'livre de jeremie', 'prophete jeremie'],
  lamentations: ['lamentations', 'lam', 'lamentations de jeremie'],
  ezechiel: ['ezechiel', 'ez', 'livre d ezechiel', 'prophete ezechiel'],
  daniel: ['daniel', 'dan', 'livre de daniel', 'prophete daniel'],
  osee: ['osee', 'os', 'livre d osee', 'prophete osee'],
  joel: ['joel', 'jl', 'livre de joel', 'prophete joel'],
  amos: ['amos', 'am', 'livre d amos', 'prophete amos'],
  abdias: ['abdias', 'ab', 'livre d abdias', 'prophete abdias'],
  jonas: ['jonas', 'jon', 'livre de jonas', 'prophete jonas'],
  michee: ['michee', 'mi', 'livre de michee', 'prophete michee'],
  nahum: ['nahum', 'na', 'livre de nahum', 'prophete nahum'],
  habacuc: ['habacuc', 'ha', 'livre d habacuc', 'prophete habacuc'],
  sophonie: ['sophonie', 'so', 'livre de sophonie', 'prophete sophonie'],
  aggee: ['aggee', 'ag', 'livre d aggee', 'prophete aggee'],
  zacharie: ['zacharie', 'za', 'livre de zacharie', 'prophete zacharie'],
  malachie: ['malachie', 'ml', 'livre de malachie', 'prophete malachie'],
  matthieu: [
    'matthieu',
    'mathieu',
    'mt',
    'evangile de matthieu',
    'evangile selon matthieu',
    'evangile selon saint matthieu',
  ],
  marc: ['marc', 'mc', 'evangile de marc', 'evangile selon marc', 'evangile selon saint marc'],
  luc: ['luc', 'lc', 'evangile de luc', 'evangile selon luc', 'evangile selon saint luc'],
  jean: ['jean', 'jn', 'evangile de jean', 'evangile selon jean', 'evangile selon saint jean'],
  actes: ['actes des apotres', 'actes', 'ac', 'livre des actes'],
  romains: ['romains', 'rom', 'rm', 'epitre aux romains', 'lettre aux romains'],
  '1corinthiens': [
    '1 corinthiens',
    '1er corinthiens',
    'premier corinthiens',
    'premiere aux corinthiens',
    '1ere aux corinthiens',
    'premiere lettre aux corinthiens',
    'premiere epitre aux corinthiens',
    'i corinthiens',
  ],
  '2corinthiens': [
    '2 corinthiens',
    '2eme corinthiens',
    'deuxieme corinthiens',
    'seconde aux corinthiens',
    'deuxieme aux corinthiens',
    '2ere aux corinthiens',
    'deuxieme lettre aux corinthiens',
    'deuxieme epitre aux corinthiens',
    'ii corinthiens',
  ],
  galates: ['galates', 'ga', 'epitre aux galates', 'lettre aux galates'],
  ephesiens: ['ephesiens', 'ep', 'epitre aux ephesiens', 'lettre aux ephesiens'],
  philippiens: ['philippiens', 'php', 'epitre aux philippiens', 'lettre aux philippiens'],
  colossiens: ['colossiens', 'col', 'epitre aux colossiens', 'lettre aux colossiens'],
  '1thessaloniciens': [
    '1 thessaloniciens',
    '1er thessaloniciens',
    'premier thessaloniciens',
    'premiere aux thessaloniciens',
    'premiere epitre aux thessaloniciens',
    'i thessaloniciens',
  ],
  '2thessaloniciens': [
    '2 thessaloniciens',
    '2eme thessaloniciens',
    'deuxieme thessaloniciens',
    'deuxieme aux thessaloniciens',
    'deuxieme epitre aux thessaloniciens',
    'ii thessaloniciens',
  ],
  '1timothee': [
    '1 timothee',
    '1er timothee',
    'premier timothee',
    'premiere a timothee',
    'premiere epitre a timothee',
    'i timothee',
  ],
  '2timothee': [
    '2 timothee',
    '2eme timothee',
    'deuxieme timothee',
    'deuxieme a timothee',
    'deuxieme epitre a timothee',
    'ii timothee',
  ],
  tite: ['tite', 'epitre a tite', 'lettre a tite', 'tt'],
  philemon: ['philemon', 'epitre a philemon', 'lettre a philemon', 'phm'],
  hebreux: ['hebreux', 'heb', 'epitre aux hebreux', 'lettre aux hebreux'],
  jacques: ['jacques', 'jc', 'epitre de jacques'],
  '1pierre': [
    '1 pierre',
    '1er pierre',
    'premier pierre',
    'premiere de pierre',
    'premiere epitre de pierre',
    'i pierre',
  ],
  '2pierre': [
    '2 pierre',
    '2eme pierre',
    'deuxieme pierre',
    'seconde de pierre',
    'deuxieme de pierre',
    'deuxieme epitre de pierre',
    'ii pierre',
  ],
  '1jean': [
    '1 jean',
    '1er jean',
    'premier jean',
    'premiere de jean',
    'premiere epitre de jean',
    'i jean',
  ],
  '2jean': [
    '2 jean',
    '2eme jean',
    'deuxieme jean',
    'deuxieme de jean',
    'deuxieme epitre de jean',
    'ii jean',
  ],
  '3jean': [
    '3 jean',
    '3eme jean',
    'troisieme jean',
    'troisieme de jean',
    'troisieme epitre de jean',
    'iii jean',
  ],
  jude: ['jude', 'epitre de jude', 'lettre de jude', 'jd'],
  apocalypse: ['apocalypse', 'ap', 'livre de l apocalypse', 'revelation'],
};

// Corrige les déformations phonétiques courantes produites par Whisper
// (surtout en base/tiny sur bruit ambiant) pour "chapitre" et "verset".
// Étendez ces listes au fur et à mesure que vous observez de nouvelles
// variantes dans vos logs de transcription réels. Chaque variante doit être
// déjà en minuscules/sans accents, car elle est appliquée APRÈS le
// dé-accentuage NFD dans normalize().
const CHAPITRE_VARIANTS = [
  'chapitre',
  'chappitois',
  'sabitoire',
  'chabitouale',
  'sapitois',
  'chapitois',
  'chappitre',
  'chappite',
  'chapite',
  'chapit',
  'chaptre',
];
const VERSET_VARIANTS = [
  'verset',
  'versets',
  'vecc',
  'vece',
  'vsc',
  'vc',
  'veille',
  'versai',
  'verse',
  'verce',
  'vercet',
  'versait',
  // CORRECTIF (audit — Ole, 2026-07-30) : "versus" reproduit en conditions
  // réelles — la reconnaissance vocale (Web Speech API comme un simple
  // dictaphone) transforme parfois "verset" en "versus" ("Jean 1 versus 1").
  // Sans cette entrée, le mot "verset" n'était jamais reconnu : le chapitre
  // entier de Jean 1 s'affichait au lieu du seul verset 1, la référence
  // retombant sur le format le plus faible ("livre + chapitre" seul).
  'versus',
];

function correctPhoneticNoise(text) {
  let result = text;
  result = result.replace(/\bce\s*(\d{1,3})\s*(?:eme|e)?\s*chapitre\b/gi, 'chapitre $1');
  result = result.replace(/\bce2chapitre\b/gi, 'chapitre 2');
  result = result.replace(/\bce\s*chapitre\b/gi, 'chapitre');
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
  const base = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return correctPhoneticNoise(base);
}

const NUMBER_WORDS = {
  zero: 0,
  un: 1,
  une: 1,
  premier: 1,
  premiere: 1,
  '1er': 1,
  '1ere': 1,
  '1st': 1,
  first: 1,
  deux: 2,
  deuxieme: 2,
  second: 2,
  seconde: 2,
  '2eme': 2,
  '2ere': 2,
  '2nd': 2,
  trois: 3,
  troisieme: 3,
  '3eme': 3,
  '3rd': 3,
  quatre: 4,
  quatrieme: 4,
  '4eme': 4,
  '4th': 4,
  cinq: 5,
  cinquieme: 5,
  '5eme': 5,
  '5th': 5,
  six: 6,
  sixieme: 6,
  '6eme': 6,
  '6th': 6,
  sept: 7,
  septieme: 7,
  '7eme': 7,
  '7th': 7,
  huit: 8,
  huitieme: 8,
  '8eme': 8,
  '8th': 8,
  neuf: 9,
  neuvieme: 9,
  '9eme': 9,
  '9th': 9,
  dix: 10,
  dixieme: 10,
  '10eme': 10,
  '10th': 10,
  onze: 11,
  onzieme: 11,
  onzeieme: 11,
  douze: 12,
  douzieme: 12,
  treize: 13,
  treizieme: 13,
  quatorze: 14,
  quatorzieme: 14,
  quinze: 15,
  quinzieme: 15,
  seize: 16,
  seizieme: 16,
  dixsept: 17,
  dixseptieme: 17,
  dixhuit: 18,
  dixhuitieme: 18,
  dixneuf: 19,
  dixneuvieme: 19,
  vingt: 20,
  vingtieme: 20,
  trente: 30,
  trentieme: 30,
  quarante: 40,
  quarantieme: 40,
  cinquante: 50,
  cinquantieme: 50,
  soixante: 60,
  cent: 100,
  cents: 100,
  centieme: 100,
};
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join('|');

function numberWordsToDigits(text) {
  return text.replace(
    new RegExp(
      `\\b(?:${NUMBER_WORD_PATTERN})(?:[\\s-]+(?:et[\\s-]+)?(?:${NUMBER_WORD_PATTERN}))*\\b`,
      'g'
    ),
    (words) => {
      const tokens = words
        .replace(/-/g, ' ')
        .split(/\s+/)
        .filter((token) => token !== 'et');
      let total = 0;
      let current = 0;
      for (const token of tokens) {
        const value = NUMBER_WORDS[token];
        if (value === undefined) continue;
        if (value === 100) current = Math.max(1, current) * 100;
        else if (value === 20 && current === 4)
          current = 80; // quatre-vingt
        else current += value;
      }
      return String(total + current);
    }
  );
}

const aliases = Object.entries(BOOKS)
  .flatMap(([book, names]) => names.map((name) => ({ book, name })))
  .sort((a, b) => b.name.length - a.name.length);

// Boucle de détection exacte (regex par alias), extraite de detect() pour
// pouvoir être rejouée une seconde fois sur un texte corrigé par la
// correspondance floue (voir detect() ci-dessous) sans dupliquer la logique.
function matchAgainstAliases(normalized) {
  for (const { book, name } of aliases) {
    const escaped = escapeRegExp(name).replace(/\s+/g, '\\s+');

    // Inverted Spoken Pattern 1: "verset 16 du chapitre 3 de Jean"
    const invPattern1 = new RegExp(
      `\\bverset(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|a|à|au)\\s*(\\d{1,3}))?\\s+(?:du|de|dans|au)?\\s*chapitre\\s+(\\d{1,3})\\s+(?:de|du|dans|de\\s+l|d|sur)?\\s*${escaped}\\b`,
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

    // Inverted Spoken Pattern 2: "chapitre 3 de Jean verset 16"
    const invPattern2 = new RegExp(
      `\\bchapitre\\s+(\\d{1,3})\\s+(?:de|du|dans|de\\s+l|d|sur)?\\s*${escaped}\\s+(?:au\\s+|le\\s+|les\\s+)?verset(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|a|à|au)\\s*(\\d{1,3}))?\\b`,
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

    // Inverted Spoken Pattern 3: "verset 16 de Jean 3"
    const invPattern3 = new RegExp(
      `\\bverset(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|a|à|au)\\s*(\\d{1,3}))?\\s+(?:dans|de|du)?\\s*${escaped}\\s+(?:chapitre\\s+)?(\\d{1,3})\\b`,
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

    const requireExplicitChapitre = name.length <= 2;
    const chapitreKeyword = requireExplicitChapitre ? `chapitre\\s+` : `(?:chapitre\\s+)?`;

    // Standard Pattern
    const pattern = new RegExp(
      `(?:^|\\s)${escaped}\\s+` + // Book name
        chapitreKeyword + // "chapitre"
        `(\\d{1,3})` + // Chapter (group 1)
        `(?:` + // Start optional verse group
        `\\s*` + // Optional whitespace
        `(?:` +
        `[:,]\\s*` + // Colon or comma
        `(?:verset(?:s)?\\s+)?` + // Optional "verset" after colon/comma
        `(\\d{1,3})` + // Verse start (group 2)
        `|` +
        `\\s+verset(?:s)?\\s+` + // " verset "
        `(\\d{1,3})` + // Verse start (group 3)
        `|` +
        `\\s+` + // Just whitespace
        `(\\d{1,3})` + // Verse start (group 4)
        `)` +
        `(?:` + // Optional verse range
        `\\s*` +
        `(?:-|a|à|au)` + // Range separator
        `\\s*` +
        `(\\d{1,3})` + // Verse end (group 5)
        `)?` +
        `)?` +
        `(?=$|[\\s,.;!?)])`, // Word boundary
      'i'
    );

    const match = normalized.match(pattern);
    if (!match) continue;

    const chapter = Number(match[1]);

    // Get verse start from whichever group captured it (2, 3, or 4)
    const verseStart =
      match[2] || match[3] || match[4] ? Number(match[2] || match[3] || match[4]) : undefined;

    // Get verse end (group 5) or default to verse start
    const verseEnd = match[5] ? Number(match[5]) : verseStart;

    // Validation
    if (chapter > 0 && chapter <= 150) {
      // NB: verseStart peut valoir 0 (ex. transcription erronée "verset 0"),
      // qui est une valeur "falsy" en JS — on doit donc tester
      // `!== undefined` et non `verseStart` seul, sinon 0 échappait à la
      // validation de plage ci-dessous.
      if (verseStart !== undefined && (verseStart <= 0 || verseStart > 200)) continue;
      if (verseEnd !== undefined && (verseEnd < verseStart || verseEnd > 200)) continue;

      return {
        book,
        chapter,
        verseStart,
        verseEnd,
        raw: match[0].trim(),
      };
    }
  }

  return null;
}

function detectExact(text) {
  const normalized = numberWordsToDigits(normalize(text));
  return matchAgainstAliases(normalized);
}

function detect(text) {
  const normalized = numberWordsToDigits(normalize(text));
  const exact = matchAgainstAliases(normalized);
  if (exact) return exact;

  // AJOUT (audit — inspiré de Rhema, correspondance floue). Aucune
  // correspondance exacte : peut-être que Whisper/Groq a mal transcrit le
  // nom du livre ("Filipiens" au lieu de "Philippiens", "Gen" déformé en
  // "Jan"...) alors que le reste de la phrase (chapitre/verset) est correct.
  // On tente une seule correction, on rejoue la même détection dessus, et on
  // s'arrête là : ce n'est qu'un filet de secours ciblé, pas une boucle de
  // réessais illimitée.
  const corrected = correctBookNameFuzzy(normalized, aliases);
  if (!corrected) return null;

  const fuzzyMatch = matchAgainstAliases(corrected.text);
  if (!fuzzyMatch) return null;

  // CORRECTIF (audit — faux positif résiduel découvert après le correctif
  // sur les alias courts ci-dessus) : "vous êtes deux témoins" (aucune
  // référence biblique) se faisait corriger en "vous actes 2 témoins" par
  // le fuzzy matching ("etes" ~ "actes", distance 2, alias de 5 lettres —
  // donc non couvert par la garde "chapitre obligatoire" qui ne vise que
  // les alias <=2 lettres), puis matchait le format le plus faible
  // possible : "livre + numéro nu", sans "chapitre" ni verset. Ce format
  // est acceptable pour un match EXACT (le nom du livre est alors une
  // preuve suffisante à lui seul), mais beaucoup trop faible pour un match
  // FUZZY, où l'identité même du livre est déjà une supposition. On exige
  // donc, uniquement sur ce chemin fuzzy, une preuve contextuelle
  // supplémentaire : soit le mot "chapitre" est explicitement présent,
  // soit un verset est spécifié (":16", ", verset 16"...). C'est déjà le
  // cas de tous les tests fuzzy existants ("Filipiens 2:5", "Jan 3:16"...
  // — tous au format deux-points+verset), donc cette garde ne change rien
  // pour eux.
  const hasChapitreKeyword = /\bchapitre\b/i.test(fuzzyMatch.raw);
  const hasVerseSpecified = fuzzyMatch.verseStart !== undefined;
  if (!hasChapitreKeyword && !hasVerseSpecified) {
    console.log(
      `[detector] Correspondance floue rejetée (preuve insuffisante — ni "chapitre" ni verset) : ` +
        `"${corrected.original}" → "${corrected.name}"`
    );
    return null;
  }

  console.log(
    `[detector] Correspondance floue : "${corrected.original}" → "${corrected.name}" ` +
      `(distance ${corrected.distance})`
  );
  // CORRECTIF : une correspondance floue (nom de livre deviné, pas certain)
  // était renvoyée avec exactement la même forme qu'une correspondance
  // exacte — server.js n'avait donc aucun moyen de la traiter différemment
  // (ex. demander confirmation avant affichage). On l'annote.
  return {
    ...fuzzyMatch,
    fuzzy: true,
    fuzzyDistance: corrected.distance,
    fuzzyOriginal: corrected.original,
  };
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
    // Chapitre seul, sans verset : DOIT être détecté (voir tests/test-detector.js,
    // suite officielle, cas "Psaume 23" avec verseStart/verseEnd undefined).
    { text: 'Jean 3', expected: true },
    { text: 'Jean chapitre 3', expected: true },

    // Phonetic variations (Whisper errors)
    { text: 'Jean chappitois 3, vece 4', expected: true },
    { text: 'Jean sapitois 3, vsc 4', expected: true },

    // AJOUT (audit — correspondance floue Levenshtein, inspirée de Rhema) :
    // erreurs de transcription sur le NOM DU LIVRE lui-même (distinct des
    // variantes phonétiques "chapitre"/"verset" testées ci-dessus).
    { text: 'Filipiens 2:5', expected: true }, // Philippiens mal transcrit
    { text: 'Ruthe 1:16', expected: true }, // Ruth + résidu
    { text: 'Efesiens 4:32', expected: true }, // Éphésiens mal transcrit
    { text: 'Jan 3:16', expected: true }, // Jean mal transcrit

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
      console.log(
        `   → ${result.book} ${result.chapter}:${result.verseStart || ''}${result.verseEnd && result.verseEnd !== result.verseStart ? '-' + result.verseEnd : ''}`
      );
    } else if (expected) {
      console.log(`   → Expected match but got null`);
    }
    console.log('');
  });

  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
}

/**
 * AJOUT (audit — inspiré de Rhema, "changement de traduction à la voix").
 * Détecte une phrase de commande demandant de changer de traduction
 * biblique en cours de culte (ex: "passons en Darby", "lis en Segond"),
 * distincte d'une référence de verset classique. Volontairement permissive
 * sur le verbe déclencheur (la reconnaissance vocale ne rendra jamais
 * exactement la même formulation deux fois), mais stricte sur le nom de
 * traduction : seules 'segond' et 'darby' sont reconnues (les deux seules
 * traductions françaises disponibles via des APIs libres de droits — voir
 * bible-lookup-with-api.js/AVAILABLE_TRANSLATIONS).
 * @param {string} text - Segment de transcription à analyser
 * @returns {{ code: 'lsg'|'darby' }|null}
 */
function detectTranslationSwitch(text) {
  const normalized = normalize(text);
  // Verbe déclencheur, conjugué correctement (le français ne forme pas
  // "nous passons" en collant "e"+"ons" à l'infinitif — piège sur lequel la
  // première version de cette regex trébuchait). Prépositions optionnelles
  // ("en", "à", "vers", "sur", "la", "le") car "utilisons la Darby" est tout
  // aussi naturel que "passons en Darby" à l'oral.
  const match = normalized.match(
    /\b(?:lis(?:ons|ez)?|lire|lecture|passe(?:z)?|passons|repasse(?:z)?|repassons|retourne(?:z)?|retournons|change(?:z)?|changeons|utilise(?:z)?|utilisons)\b.{0,25}?\b(?:en|a|vers|sur|la|le)?\s*(segond|louis\s*segond|darby)\b/
  );
  if (!match) return null;
  const code = match[1].startsWith('darby') ? 'darby' : 'lsg';
  return { code };
}

module.exports = {
  detect,
  detectExact,
  normalize,
  numberWordsToDigits,
  detectTranslationSwitch,
  BOOKS,
};
