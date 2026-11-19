import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { detectValidatedReferences } from "./detect-and-validate"

// Real v1 implementations, not mocks: both are deterministic, in-memory,
// and fast (AGENTS.md section 32 only requires mocking *external*
// providers). This suite is the concrete proof that the wiring described
// in ARCHITECTURE.md section 14 actually holds end to end.

test("detectValidatedReferences: a real, valid reference survives validation", () => {
  const result = detectValidatedReferences(
    new RegexDetector(),
    new KnownValidVerseIndex(),
    "Please turn to John 3:16 tonight."
  )
  assert.deepEqual(result, [{ book: "john", chapter: 3, verse: 16 }])
})

// This is the hallucination-guard behavior itself: the detector matches
// "Frogs 3:16" syntactically (see regex-detector.test.ts), but it must
// never reach anything downstream because "frogs" is not a real book.
test("detectValidatedReferences: a syntactically-matched but nonexistent book is filtered out", () => {
  const result = detectValidatedReferences(
    new RegexDetector(),
    new KnownValidVerseIndex(),
    "Frogs 3:16 is not a real verse."
  )
  assert.deepEqual(result, [])
})

test("detectValidatedReferences: an out-of-range chapter is filtered out even for a real book", () => {
  const result = detectValidatedReferences(
    new RegexDetector(),
    new KnownValidVerseIndex(),
    "John 999:999 does not exist."
  )
  assert.deepEqual(result, [])
})

test("detectValidatedReferences: an out-of-range verse in a real chapter is filtered out", () => {
  const result = detectValidatedReferences(
    new RegexDetector(),
    new KnownValidVerseIndex(),
    // John chapter 3 has 36 verses.
    "John 3:37 does not exist."
  )
  assert.deepEqual(result, [])
})

test("detectValidatedReferences: mixed valid and invalid references — only the valid one survives, order preserved", () => {
  const result = detectValidatedReferences(
    new RegexDetector(),
    new KnownValidVerseIndex(),
    "Frogs 3:16 is fake, but John 3:16 is real, and John 999:999 is also fake."
  )
  assert.deepEqual(result, [{ book: "john", chapter: 3, verse: 16 }])
})

test("detectValidatedReferences: no detected references means no validated references", () => {
  const result = detectValidatedReferences(
    new RegexDetector(),
    new KnownValidVerseIndex(),
    "Welcome everyone, let's begin worship."
  )
  assert.deepEqual(result, [])
})

// ---------------------------------------------------------------------------
// Innovation pass (ARCHITECTURE.md section 145): validated verse RANGES.
// ---------------------------------------------------------------------------

import { detectValidatedRanges, MAX_RANGE_VERSES } from "./detect-and-validate"
import { asVerseRangeDetector, VerseRangeDetector } from "../detector/verse-range-detector"

const rangeDetector = new VerseRangeDetector()
const rangeIndex = new KnownValidVerseIndex()

// The hallucination guard's range twin: a detected range is a candidate too.
test("detectValidatedRanges: the hallucination guard clamps to a contiguous existing stretch", () => {
  // John 3 has 36 verses; "16 to 40" first hits the MAX_RANGE_VERSES cap
  // (16 + 12 - 1 = 27), which the index then confirms in full.
  assert.deepEqual(
    detectValidatedRanges(rangeDetector, rangeIndex, "Jean 3:16-40"),
    [{ book: "john", chapter: 3, startVerse: 16, endVerse: 27 }]
  )
  // A start that does not exist drops the whole range.
  assert.deepEqual(detectValidatedRanges(rangeDetector, rangeIndex, "Jean 2:40-45"), [])
  // Chapter-length clamping without the cap: John 3 ends at verse 36.
  assert.deepEqual(detectValidatedRanges(rangeDetector, rangeIndex, "Jean 3:30-40"), [
    { book: "john", chapter: 3, startVerse: 30, endVerse: 36 },
  ])
  // Psalm 23 has 6 verses: "1 to 9" clamps to 1-6.
  assert.deepEqual(detectValidatedRanges(rangeDetector, rangeIndex, "Psaume 23:1-9"), [
    { book: "psalm", chapter: 23, startVerse: 1, endVerse: 6 },
  ])
})

test("detectValidatedRanges: the MAX_RANGE_VERSES cap bounds one utterance", () => {
  assert.equal(MAX_RANGE_VERSES, 12)
  // Psalm 119 has 176 verses; a spoken "1 à 176" must neither flood the
  // overlay nor turn one detection into 176 source reads.
  const validated = detectValidatedRanges(rangeDetector, rangeIndex, "Psaume 119:1-176")
  assert.deepEqual(validated, [{ book: "psalm", chapter: 119, startVerse: 1, endVerse: 12 }])
})

test("detectValidatedRanges: duplicates collapse to one range", () => {
  assert.deepEqual(detectValidatedRanges(rangeDetector, rangeIndex, "Jean 3:16-18 et 16-18"), [
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
  ])
})

test("asVerseRangeDetector: structural lookup on the pipeline detector instance", () => {
  const regex = new RegexDetector()
  assert.equal(asVerseRangeDetector(regex), regex)
  assert.equal(asVerseRangeDetector({ detect: () => [] }), null)
  assert.equal(asVerseRangeDetector(null), null)
  assert.equal(asVerseRangeDetector(undefined), null)
})
