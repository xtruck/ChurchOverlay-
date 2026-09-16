import { test } from "node:test"
import assert from "node:assert/strict"
import { passesTranscriptGate } from "./transcript-gate"
import type { TranscriptResult } from "../../../packages/contracts"

function makeTranscript(overrides: Partial<TranscriptResult>): TranscriptResult {
  return {
    id: "01ABC",
    correlationId: "01CORR",
    sequence: 0,
    text: "John 3:16",
    state: "final",
    timestamp: Date.now(),
    ...overrides,
  }
}

test("passesTranscriptGate: a final transcript passes", () => {
  assert.equal(passesTranscriptGate(makeTranscript({ state: "final" })), true)
})

test("passesTranscriptGate: a partial transcript is rejected (Invariant 1)", () => {
  assert.equal(passesTranscriptGate(makeTranscript({ state: "partial" })), false)
})

// Defense in depth: fail closed, not "reject only 'partial'". A value that
// should be unreachable under the TranscriptResult type must still be
// rejected if it somehow arrives (e.g. a buggy or untrusted ASR adapter).
test("passesTranscriptGate: fails closed for an unexpected state value", () => {
  const transcript = makeTranscript({
    state: "final",
  }) as TranscriptResult
  const corrupted = { ...transcript, state: "unknown" } as unknown as TranscriptResult
  assert.equal(passesTranscriptGate(corrupted), false)
})
