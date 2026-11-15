import { test } from "node:test"
import assert from "node:assert/strict"
import { VerseRangeDetector } from "./verse-range-detector"
import { RegexDetector } from "./regex-detector"

const detector = new VerseRangeDetector()

test("VerseRangeDetector: the full prose form with both keywords, French and English", () => {
  assert.deepEqual(detector.detectRanges("Proverbes chapitre 1, verset 5 à 7"), [
    { book: "proverbs", chapter: 1, startVerse: 5, endVerse: 7 },
  ])
  assert.deepEqual(detector.detectRanges("Proverbs chapter 1 verse 5 to 7"), [
    { book: "proverbs", chapter: 1, startVerse: 5, endVerse: 7 },
  ])
  assert.deepEqual(detector.detectRanges("Proverbes chapitre 1 et verset 5 à 7"), [
    { book: "proverbs", chapter: 1, startVerse: 5, endVerse: 7 },
  ])
})

test("VerseRangeDetector: the single-keyword spoken form, French and English", () => {
  assert.deepEqual(detector.detectRanges("Jean 3 verset 16 à 18"), [
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
  ])
  assert.deepEqual(detector.detectRanges("Psalms 23 verses 1 to 3"), [
    { book: "psalm", chapter: 23, startVerse: 1, endVerse: 3 },
  ])
  // "et" as the range conjunction: two verses joined, not two references.
  assert.deepEqual(detector.detectRanges("Actes 2 versets 42 et 47"), [
    { book: "acts", chapter: 2, startVerse: 42, endVerse: 47 },
  ])
})

test("VerseRangeDetector: the dictated compact forms", () => {
  assert.deepEqual(detector.detectRanges("Jean 3:16-18"), [
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
  ])
  assert.deepEqual(detector.detectRanges("Jean 3.16-18"), [
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
  ])
  assert.deepEqual(detector.detectRanges("Jean 3, 16-18"), [
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
  ])
  assert.deepEqual(detector.detectRanges("Jean 3 16-18"), [
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
  ])
  assert.deepEqual(detector.detectRanges("lisez avec moi Jean 3:16-18 ce matin"), [
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
  ])
})

test("VerseRangeDetector: 'jusqu'au' / 'jusqu'à' join a range", () => {
  assert.deepEqual(detector.detectRanges("Marc 1 versets 1 jusqu'au 8"), [
    { book: "mark", chapter: 1, startVerse: 1, endVerse: 8 },
  ])
  assert.deepEqual(detector.detectRanges("Marc 1 versets 1 jusqu'à 8"), [
    { book: "mark", chapter: 1, startVerse: 1, endVerse: 8 },
  ])
})

test("VerseRangeDetector: number words normalize first (the same rule as singles)", () => {
  assert.deepEqual(detector.detectRanges("Psaume cent dix-neuf versets un à trois"), [
    { book: "psalm", chapter: 119, startVerse: 1, endVerse: 3 },
  ])
})

test("VerseRangeDetector: negatives that must never become ranges", () => {
  // The single reference's conjunction slot: a keyword between the numbers
  // means TWO anchored readings, not a range.
  assert.deepEqual(detector.detectRanges("1 Samuel chapter 16 and verse 7"), [])
  assert.deepEqual(detector.detectRanges("Jean chapitre 3 et verset 16"), [])
  // Enumeration without a verse keyword is ordinary speech.
  assert.deepEqual(detector.detectRanges("Marc 12 14 personnes"), [])
  // Reversed spans are quantity noise, not ranges.
  assert.deepEqual(detector.detectRanges("Romains 8, 28 - 5"), [])
  // No book, no range.
  assert.deepEqual(detector.detectRanges("versets 16 à 18"), [])
  // 'chapitre'/'verset' as book-name-shaped words are stopwords.
  assert.deepEqual(detector.detectRanges("chapitre 3 versets 16 à 18"), [])
})

test("VerseRangeDetector: the compact form keeps the everyday-word and trailing-word guards", () => {
  assert.deepEqual(detector.detectRanges("un grand nombre 12 14-16"), [])
  assert.deepEqual(detector.detectRanges("Marc 12 14-16 personnes"), [])
})

test("VerseRangeDetector: a range and a single never double-fire for the same numbers", () => {
  const singles = new RegexDetector()
  const text = "Proverbes chapitre 1 verset 5 à 7"
  assert.deepEqual(singles.detect(text), [])
  assert.deepEqual(detector.detectRanges(text).length, 1)
})
