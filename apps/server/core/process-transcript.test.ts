import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { processTranscript } from "./process-transcript"
import type { TranscriptResult } from "../../../packages/contracts"

function makeTranscript(overrides: Partial<TranscriptResult>): TranscriptResult {
  return {
    id: "01ABC",
    correlationId: "01CORR",
    sequence: 0,
    text: "",
    state: "final",
    timestamp: Date.now(),
    ...overrides,
  }
}

test("processTranscript: a final transcript with a real reference produces it", () => {
  const result = processTranscript(
    makeTranscript({ state: "final", text: "Please turn to John 3:16 tonight." }),
    new RegexDetector(),
    new KnownValidVerseIndex()
  )
  assert.deepEqual(result, [{ book: "john", chapter: 3, verse: 16 }])
})

// This is the single most important test in the pipeline so far: it proves
// Invariant 1 (ARCHITECTURE.md section 47) holds end to end, not just at
// the gate's own unit-test level. The exact same text that produces a
// verified reference when final must produce nothing at all while it is
// still partial.
test("processTranscript: the identical text produces nothing while the transcript is only partial", () => {
  const text = "Please turn to John 3:16 tonight."
  const partial = processTranscript(
    makeTranscript({ state: "partial", text }),
    new RegexDetector(),
    new KnownValidVerseIndex()
  )
  const final = processTranscript(
    makeTranscript({ state: "final", text }),
    new RegexDetector(),
    new KnownValidVerseIndex()
  )
  assert.deepEqual(partial, [])
  assert.deepEqual(final, [{ book: "john", chapter: 3, verse: 16 }])
})

test("processTranscript: a final transcript with a syntactically-matched but nonexistent book produces nothing", () => {
  const result = processTranscript(
    makeTranscript({ state: "final", text: "Frogs 3:16 is not a real verse." }),
    new RegexDetector(),
    new KnownValidVerseIndex()
  )
  assert.deepEqual(result, [])
})

test("processTranscript: a final transcript with no reference produces nothing", () => {
  const result = processTranscript(
    makeTranscript({ state: "final", text: "Welcome everyone, let's begin worship." }),
    new RegexDetector(),
    new KnownValidVerseIndex()
  )
  assert.deepEqual(result, [])
})
