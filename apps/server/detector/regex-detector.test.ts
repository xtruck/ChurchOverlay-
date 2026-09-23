import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector, normalizeBookName } from "./regex-detector"

test("RegexDetector: detects a single valid 'Book Chapter:Verse' reference", () => {
  const detector = new RegexDetector()
  const result = detector.detect("Please turn to John 3:16 tonight.")
  assert.deepEqual(result, [{ book: "john", chapter: 3, verse: 16 }])
})

test("RegexDetector: returns no references when the transcript contains none", () => {
  const detector = new RegexDetector()
  const result = detector.detect("Welcome everyone, let's begin worship.")
  assert.deepEqual(result, [])
})

test("RegexDetector: returns no references for an empty transcript", () => {
  const detector = new RegexDetector()
  assert.deepEqual(detector.detect(""), [])
})

test("RegexDetector: detects multiple references in one transcript, in order, including a numeral-prefixed book", () => {
  const detector = new RegexDetector()
  const result = detector.detect(
    "Read 1 Corinthians 13:4 first, then John 3:16, then Romans 8:28."
  )
  assert.deepEqual(result, [
    { book: "1 corinthians", chapter: 13, verse: 4 },
    { book: "john", chapter: 3, verse: 16 },
    { book: "romans", chapter: 8, verse: 28 },
  ])
})

// CORRECTIF/IMPORTANT (architecture boundary, see ARCHITECTURE.md sections
// 12.2, 14, 15 and AGENTS.md section 12): the detector is intentionally
// unaware of which book names are real. It only recognizes the *syntactic*
// shape "Word(s) Chapter:Verse" (either case, since section 72) and
// reports it as a candidate reference. Rejecting nonexistent books (or
// invalid chapter/verse numbers) is the Known-Valid Verse Index's job,
// applied downstream — never the detector's. This test locks in that
// separation of concerns: an unrecognized/ambiguous "book" still produces
// a structured reference here.
test("RegexDetector: still emits a structured reference for an unrecognized/ambiguous book name (existence is validated downstream, not here)", () => {
  const detector = new RegexDetector()
  const result = detector.detect("Frogs 3:16 is not a real verse.")
  assert.deepEqual(result, [{ book: "frogs", chapter: 3, verse: 16 }])
})

// ARCHITECTURE.md section 72: capitalization is no longer what filters
// this out (lowercase book names are now allowed, to catch real books
// like "job"/"acts" that ASR often doesn't capitalize) — the small
// STOPWORDS list is what excludes "at" here specifically.
test("RegexDetector: does not match a common short function word directly before a digit:digit pattern", () => {
  const detector = new RegexDetector()
  const result = detector.detect("the meeting starts at 3:16 today")
  assert.deepEqual(result, [])
})

// ARCHITECTURE.md section 72: the real gap this closes — several genuine
// book names double as ordinary words ("Job", "Acts", "Mark") and Whisper
// routinely transcribes them lowercase mid-sentence, silently losing a
// real reference under the old capitalization-only requirement.
test("RegexDetector: detects a lowercase-transcribed real book name (e.g. 'job', 'acts') just as well as a capitalized one", () => {
  const detector = new RegexDetector()
  assert.deepEqual(detector.detect("let's read job 3:16 together"), [
    { book: "job", chapter: 3, verse: 16 },
  ])
  assert.deepEqual(detector.detect("turn to acts 3:16 please"), [
    { book: "acts", chapter: 3, verse: 16 },
  ])
})

// CORRECTIF (found via resolve-transcript-verses.test.ts): a sentence-
// initial capitalized word immediately before a real book name must not
// be swallowed into the book group. An earlier version of this pattern
// allowed the book group to greedily consume any run of consecutive
// capitalized words, so "Read John 3:16" parsed as book="Read John"
// instead of book="John" — a real, silent misdetection of a genuine
// reference (not a hallucination-guard case: KnownValidVerseIndex
// correctly rejects "read john", but the actual verse was lost with it).
test("RegexDetector: a sentence-initial capitalized word is not absorbed into the following book name", () => {
  const detector = new RegexDetector()
  const result = detector.detect("Read John 3:16 and then Romans 8:28.")
  assert.deepEqual(result, [
    { book: "john", chapter: 3, verse: 16 },
    { book: "romans", chapter: 8, verse: 28 },
  ])
})

// French book names (ARCHITECTURE.md section 65 — confirmed explicitly:
// the app's primary deployment target is a French-speaking church).
test("RegexDetector: detects a French book name (no accent in the book name itself)", () => {
  const detector = new RegexDetector()
  assert.deepEqual(detector.detect("Jean 3:16"), [{ book: "john", chapter: 3, verse: 16 }])
  assert.deepEqual(detector.detect("Romains 8:28"), [{ book: "romans", chapter: 8, verse: 28 }])
})

test("RegexDetector: detects a French book name that starts with an accented capital letter", () => {
  const detector = new RegexDetector()
  // Regression coverage: \b (JS's word-boundary) does not recognize an
  // accented letter as a "word" character at all, so a naive port of the
  // English-only pattern would silently reject these outright, before
  // normalizeBookName() ever runs.
  assert.deepEqual(detector.detect("Ésaïe 6:8"), [{ book: "isaiah", chapter: 6, verse: 8 }])
  assert.deepEqual(detector.detect("Éphésiens 2:8"), [{ book: "ephesians", chapter: 2, verse: 8 }])
})

test("RegexDetector: a French reference embedded mid-sentence is still detected correctly", () => {
  const detector = new RegexDetector()
  const result = detector.detect("Tournons-nous vers Jean 3:16 ce soir.")
  assert.deepEqual(result, [{ book: "john", chapter: 3, verse: 16 }])
})

test("normalizeBookName: translates French book names to BOOK_CATALOG's canonical id, with or without accents", () => {
  assert.equal(normalizeBookName("Jean"), "john")
  assert.equal(normalizeBookName("Romains"), "romans")
  assert.equal(normalizeBookName("Ésaïe"), "isaiah")
  assert.equal(normalizeBookName("Esaie"), "isaiah") // accent-optional — ASR may drop it
  assert.equal(normalizeBookName("1 Corinthiens"), "1 corinthians")
  assert.equal(normalizeBookName("Apocalypse"), "revelation")
})

test("normalizeBookName: 'Abacuc' with the initial H dropped still resolves (observed live, 2026-09)", () => {
  assert.equal(normalizeBookName("Habacuc"), "habakkuk")
  assert.equal(normalizeBookName("Abacuc"), "habakkuk")
})

test("normalizeBookName: an English name is returned unchanged (still needs no translation)", () => {
  assert.equal(normalizeBookName("John"), "john")
  assert.equal(normalizeBookName("Romans"), "romans")
})

test("RegexDetector: detects spoken French chapter and verse wording", () => {
  const detector = new RegexDetector()
  assert.deepEqual(detector.detect("Ésaïe 4, verset 8"), [{ book: "isaiah", chapter: 4, verse: 8 }])
  assert.deepEqual(detector.detect("Jean 3 chapitre 16"), [{ book: "john", chapter: 3, verse: 16 }])
})
