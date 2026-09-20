import { test } from "node:test"
import assert from "node:assert/strict"
import { NavigationCommandDetector } from "./navigation-command-detector"

/**
 * TASK 0: Dead-zone tests — now asserting the FIXED behavior.
 *
 * These tests verify that French "Book chapitre N verset M" utterances now
 * correctly produce goto-book-chapter-verse commands.
 *
 * The natural French utterance "Jean chapitre 3 verset 16" previously matched
 * ZERO patterns because:
 * - GOTO_CHAPTER_PATTERN required \p{Lu} (uppercase first letter) for book name
 * - BARE_CHAPTER_VERSE_PATTERN's negative lookbehind excluded it (saw "Jean" as a
 *   capitalized book-like word and assumed it's a full reference for RegexDetector)
 * - BARE_VERSE_PATTERN only captured the verse number, losing the book/chapter
 *
 * TASK 1 + TASK 2 fixed this by adding BOOK_CHAPTER_VERSE_PATTERN with \p{L}
 * (any case) and validating against BOOK_CATALOG via normalizeBookName().
 */
const detector = new NavigationCommandDetector()

// --- Cases that NOW correctly return goto-book-chapter-verse ---

test("dead-zone: 'Jean chapitre 3 verset 16' returns goto-book-chapter-verse", () => {
  const result = detector.detect("Jean chapitre 3 verset 16")
  assert.deepEqual(result, [{ kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 }])
})

test("dead-zone: 'Jean chapitre 3, verset 16' returns goto-book-chapter-verse", () => {
  const result = detector.detect("Jean chapitre 3, verset 16")
  assert.deepEqual(result, [{ kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 }])
})

test("dead-zone: 'Ouvrons Jean chapitre 3 verset 16' returns goto-book-chapter-verse", () => {
  const result = detector.detect("Ouvrons Jean chapitre 3 verset 16")
  assert.deepEqual(result, [{ kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 }])
})

// --- Case that previously returned WRONG command (steals current book) ---
// Now correctly returns goto-book-chapter-verse (the bare pattern still fires
// but the new pattern takes precedence and includes the book)

test("dead-zone: 'jean chapitre 3 verset 16' returns goto-book-chapter-verse (not bare)", () => {
  const result = detector.detect("jean chapitre 3 verset 16")
  // The new pattern correctly identifies "jean" -> "john" via catalog lookup
  // The bare pattern also fires (producing goto-bare-chapter-verse) but the
  // new goto-book-chapter-verse is the correct one with the book included
  assert.ok(result.some((c) => c.kind === "goto-book-chapter-verse" && c.book === "john" && c.chapter === 3 && c.verse === 16))
})

// --- Cases that ALREADY WORK and must be preserved ---

test("dead-zone: 'Romains chapitre 8' keeps goto-chapter", () => {
  const result = detector.detect("Romains chapitre 8")
  assert.deepEqual(result, [{ kind: "goto-chapter", book: "romans", chapter: 8 }])
})

test("dead-zone: 'chapitre 3 verset 16' keeps goto-bare-chapter-verse", () => {
  const result = detector.detect("chapitre 3 verset 16")
  assert.deepEqual(result, [{ kind: "goto-bare-chapter-verse", chapter: 3, verse: 16 }])
})

test("dead-zone: 'verset 16' keeps goto-bare-verse", () => {
  const result = detector.detect("verset 16")
  assert.deepEqual(result, [{ kind: "goto-bare-verse", verse: 16 }])
})

// --- Negative cases that must stay rejected ---

test("dead-zone: 'Let's turn to chapter 8' must NOT produce book='to'", () => {
  const result = detector.detect("Let's turn to chapter 8")
  // The CORRECTIF in GOTO_CHAPTER_PATTERN prevents matching lowercase "to" as a book
  assert.deepEqual(result, [])
})

test("dead-zone: 'the meeting starts at 3:16 today' must stay rejected (stopword)", () => {
  const result = detector.detect("the meeting starts at 3:16 today")
  // This is RegexDetector's territory (N:M pattern) but "at" is a stopword
  // NavigationCommandDetector doesn't handle N:M patterns at all
  assert.deepEqual(result, [])
})

// --- TASK 0 regression: detect(text).length === 1 for both phrasings ---

test("regression: 'Jean chapitre 3 verset 16' returns exactly ONE command", () => {
  const result = detector.detect("Jean chapitre 3 verset 16")
  assert.equal(result.length, 1)
  assert.deepEqual(result[0], { kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 })
})

test("regression: 'jean chapitre 3 verset 16' returns exactly ONE command", () => {
  const result = detector.detect("jean chapitre 3 verset 16")
  assert.equal(result.length, 1)
  assert.deepEqual(result[0], { kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 })
})

test("regression: 'Jean chapitre 3, verset 16' returns exactly ONE command", () => {
  const result = detector.detect("Jean chapitre 3, verset 16")
  assert.equal(result.length, 1)
  assert.deepEqual(result[0], { kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 })
})

test("regression: 'jean chapitre 3, verset 16' returns exactly ONE command", () => {
  const result = detector.detect("jean chapitre 3, verset 16")
  assert.equal(result.length, 1)
  assert.deepEqual(result[0], { kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 })
})

// --- TASK 0 regression: repeated utterance must produce two commands ---

test("regression: repeated 'Jean chapitre 3 verset 16' twice returns TWO commands (span-based dedup)", () => {
  const result = detector.detect("Jean chapitre 3 verset 16 ... et je le répète, Jean chapitre 3 verset 16")
  assert.equal(result.length, 2, "repeated utterance should produce two distinct commands")
  assert.deepEqual(result[0], { kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 })
  assert.deepEqual(result[1], { kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 })
})