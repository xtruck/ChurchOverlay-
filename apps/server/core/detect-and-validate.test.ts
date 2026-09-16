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
