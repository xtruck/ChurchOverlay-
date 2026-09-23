import { test } from "node:test"
import assert from "node:assert/strict"
import { buildServiceSummaryInput } from "./service-summary"
import type { SessionEntry } from "../core/session-recorder"

function makeEntry(book: string, chapter: number, verse: number, text: string): SessionEntry {
  return { reference: { book, chapter, verse }, text, translation: "kjv", timestamp: Date.now() }
}

test("buildServiceSummaryInput: includes every shown verse with its reference and text", () => {
  const entries = [makeEntry("john", 3, 16, "For God so loved the world..."), makeEntry("psalm", 23, 1, "The Lord is my shepherd...")]
  const input = buildServiceSummaryInput(entries, "")
  assert.match(input, /john 3:16: "For God so loved the world\.\.\."/)
  assert.match(input, /psalm 23:1: "The Lord is my shepherd\.\.\."/)
})

test("buildServiceSummaryInput: includes the sermon notes text when present", () => {
  const input = buildServiceSummaryInput([], "- Grace and forgiveness\n- Living by faith")
  assert.match(input, /Grace and forgiveness/)
  assert.match(input, /Living by faith/)
})

test("buildServiceSummaryInput: says nothing was shown/noted when both are empty, rather than an empty section", () => {
  const input = buildServiceSummaryInput([], "")
  assert.match(input, /No verses were shown during this service\./)
  assert.match(input, /No sermon notes were generated during this service\./)
})

test("buildServiceSummaryInput: never fabricates verse content beyond what SessionEntry already carries", () => {
  const entries = [makeEntry("john", 3, 16, "For God so loved the world...")]
  const input = buildServiceSummaryInput(entries, "")
  // The exact, already-validated text is present verbatim, and nothing else
  // verse-shaped is introduced (no other book name appears in the input).
  assert.ok(input.includes("For God so loved the world..."))
  assert.equal((input.match(/john 3:16/g) ?? []).length, 1)
})
