'use strict';
const assert = require('assert');
const { detect, detectExact, hasIntroductionPhrase } = require('../detector');

const cases = [
  [
    'Lisons Jean 3:16.',
    { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16, confidence: 'high' },
  ],
  [
    'Dans premier Corinthiens 13 versets 4 à 7',
    { book: '1corinthiens', chapter: 13, verseStart: 4, verseEnd: 7 },
  ],
  [
    'Psaume 23',
    {
      book: 'psaumes',
      chapter: 23,
      verseStart: undefined,
      verseEnd: undefined,
      confidence: 'medium',
    },
  ],
  ['Jean chapitre trois verset seize', { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 }],
  [
    'premier Corinthiens treize versets quatre à sept',
    { book: '1corinthiens', chapter: 13, verseStart: 4, verseEnd: 7 },
  ],
  // CORRECTIF (audit — Ole, 2026-07-30) : "versus" est une déformation ASR
  // réelle de "verset" (reproduite en conditions réelles) — sans variante
  // phonétique enregistrée, le verset était perdu et le chapitre entier
  // s'affichait à la place du seul verset demandé.
  ['Jean 1 versus 1', { book: 'jean', chapter: 1, verseStart: 1, verseEnd: 1 }],
  ['Jean chapitre 1 versus 1', { book: 'jean', chapter: 1, verseStart: 1, verseEnd: 1 }],
  // CORRECTIF (audit — détecteur "pas assez performant", donnait le
  // chapitre entier au lieu du verset précis) : "Jean 3.16" (point comme
  // séparateur) et "Jean 3 v16" / "Jean 3 v. 16" (abréviation "v") ne
  // capturaient pas le numéro de verset — la référence retombait sur
  // "chapitre seul", donc le chapitre entier s'affichait au lieu du
  // verset attendu.
  ['Jean 3.16', { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 }],
  ['Jean 3 v 16', { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 }],
  ['Jean 3 v. 16', { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 }],
];
for (const [input, expected] of cases) {
  const actual = detect(input);
  assert(actual, `Référence non détectée : ${input}`);
  for (const [key, value] of Object.entries(expected))
    assert.strictEqual(actual[key], value, `${input}: ${key}`);
}
assert.strictEqual(detect('Bonjour à tous.'), null);

// AJOUT (cahier des charges — Point 1A, précision contextuelle) --------------

// hasIntroductionPhrase() : détecte les tournures de citation, insensible
// aux accents/majuscules (passe par normalize() en interne).
assert.strictEqual(hasIntroductionPhrase('Il EST écrit que Dieu aime le monde'), true);
assert.strictEqual(hasIntroductionPhrase('comme dit la Bible, tout est possible'), true);
assert.strictEqual(hasIntroductionPhrase("Ce qu'il va manger ce soir"), false);

// detectExact() : jamais de correspondance floue, confidence 'high'
// uniquement quand un verset est explicitement précisé.
assert.strictEqual(detectExact('Jean 3:16').confidence, 'high');
assert.strictEqual(detectExact('Jean chapitre 3').confidence, 'medium');
assert.strictEqual(
  detectExact('Filipiens 2:5'),
  null,
  'detectExact ne doit jamais deviner un nom de livre'
);

// Une correspondance floue (nom de livre mal transcrit) sans "chapitre" ni
// verset explicite était rejetée avant cet ajout — une tournure
// d'introduction juste avant doit maintenant suffire comme preuve.
assert.strictEqual(
  detect('vous savez que Filipiens 2 est important'),
  null,
  "sans tournure d'introduction, toujours rejeté (comportement inchangé)"
);
const withIntro = detect('il est ecrit dans Filipiens 2');
assert(withIntro, "avec une tournure d'introduction, la correspondance floue doit être acceptée");
assert.strictEqual(withIntro.book, 'philippiens');
assert.strictEqual(
  withIntro.confidence,
  'medium',
  'une correspondance floue ne dépasse jamais medium'
);

// AJOUT (Chantier A.1 — livres à chapitre unique) : Philémon, Abdias, Jude,
// 2 Jean, 3 Jean n'ont qu'un seul chapitre — cité sans jamais dire
// "chapitre" à l'oral. Corpus réel (D3 : "Philémon verset 6" renvoyait null
// avant ce correctif, voir BASELINE_CHANTIER_1.md).
const singleChapterCases = [
  ['Philémon verset 6', { book: 'philemon', chapter: 1, verseStart: 6, verseEnd: 6 }],
  // Un seul nombre après le nom du livre : ne peut être qu'un verset (le
  // chapitre 6 de Philémon n'existe pas), jamais réinterprété comme chapitre.
  ['Philémon 6', { book: 'philemon', chapter: 1, verseStart: 6, verseEnd: 6 }],
  ['verset 6 de Philémon', { book: 'philemon', chapter: 1, verseStart: 6, verseEnd: 6 }],
  ['Jude verset 3', { book: 'jude', chapter: 1, verseStart: 3, verseEnd: 3 }],
  ['2 Jean verset 5', { book: '2jean', chapter: 1, verseStart: 5, verseEnd: 5 }],
  ['3 Jean verset 2', { book: '3jean', chapter: 1, verseStart: 2, verseEnd: 2 }],
  ['Abdias verset 1', { book: 'abdias', chapter: 1, verseStart: 1, verseEnd: 1 }],
  // La forme explicite "chapitre 1" doit continuer à fonctionner (chemin
  // standard, inchangé).
  ['Philémon chapitre 1 verset 6', { book: 'philemon', chapter: 1, verseStart: 6, verseEnd: 6 }],
  // Une plage de versets doit continuer à fonctionner sur ces livres.
  ['Jude versets 3 à 5', { book: 'jude', chapter: 1, verseStart: 3, verseEnd: 5 }],
];
for (const [input, expected] of singleChapterCases) {
  const actual = detectExact(input);
  assert(actual, `Référence non détectée (livre à chapitre unique) : ${input}`);
  for (const [key, value] of Object.entries(expected))
    assert.strictEqual(actual[key], value, `${input}: ${key}`);
  assert.strictEqual(actual.confidence, 'high', `${input}: verset précisé -> confidence high`);
}

// Un livre à CHAPITRES MULTIPLES ne doit jamais être affecté par ce
// correctif — "Jean 6" reste chapitre 6, jamais réinterprété en verset.
assert.deepStrictEqual(
  { chapter: detectExact('Jean 6').chapter, verseStart: detectExact('Jean 6').verseStart },
  { chapter: 6, verseStart: undefined },
  'un livre à chapitres multiples ne doit jamais être réinterprété en "chapitre 1 verset N"'
);

console.log('✓ detector.js : tous les tests sont passés');
