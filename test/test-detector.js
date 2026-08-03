'use strict';
const assert = require('assert');
const { detect } = require('../detector');

const cases = [
  ['Lisons Jean 3:16.', { book: 'jean', chapter: 3, verseStart: 16, verseEnd: 16 }],
  [
    'Dans premier Corinthiens 13 versets 4 à 7',
    { book: '1corinthiens', chapter: 13, verseStart: 4, verseEnd: 7 },
  ],
  ['Psaume 23', { book: 'psaumes', chapter: 23, verseStart: undefined, verseEnd: undefined }],
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
];
for (const [input, expected] of cases) {
  const actual = detect(input);
  assert(actual, `Référence non détectée : ${input}`);
  for (const [key, value] of Object.entries(expected))
    assert.strictEqual(actual[key], value, `${input}: ${key}`);
}
assert.strictEqual(detect('Bonjour à tous.'), null);
console.log('✓ detector.js : tous les tests sont passés');
