import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector } from "./regex-detector"

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
// shape "Capitalized Words Chapter:Verse" and reports it as a candidate
// reference. Rejecting nonexistent books (or invalid chapter/verse numbers)
// is the Known-Valid Verse Index's job, applied downstream — never the
// detector's. This test locks in that separation of concerns: an
// unrecognized/ambiguous "book" still produces a structured reference here.
test("RegexDetector: still emits a structured reference for an unrecognized/ambiguous book name (existence is validated downstream, not here)", () => {
  const detector = new RegexDetector()
  const result = detector.detect("Frogs 3:16 is not a real verse.")
  assert.deepEqual(result, [{ book: "frogs", chapter: 3, verse: 16 }])
})

test("RegexDetector: does not match a bare time-like pattern with no preceding capitalized book", () => {
  const detector = new RegexDetector()
  const result = detector.detect("the meeting starts at 3:16 today")
  assert.deepEqual(result, [])
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
