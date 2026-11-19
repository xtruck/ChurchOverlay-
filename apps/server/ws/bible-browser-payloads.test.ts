import { test } from "node:test"
import assert from "node:assert/strict"
import { validateWsMessage } from "./action-registry"

function message(type: string, payload: unknown) {
  return { id: "01TEST", type, timestamp: Date.now(), payload }
}

// ---- commands: operator only, strict shape and bounds --------------------

test("bible:chapter: accepted for the operator with a well-formed payload, refused for a viewer", () => {
  const good = message("bible:chapter", { seq: 1, book: "john", chapter: 3 })
  assert.equal(validateWsMessage(good, "operator").ok, true)
  assert.equal(validateWsMessage(good, "viewer").ok, false)
})

test("bible:chapter: rejects bad seq, empty/huge book, non-integer or out-of-range chapter, and extra keys", () => {
  const bad: unknown[] = [
    { seq: -1, book: "john", chapter: 3 },
    { seq: 1.5, book: "john", chapter: 3 },
    { seq: 1, book: "", chapter: 3 },
    { seq: 1, book: "x".repeat(41), chapter: 3 },
    { seq: 1, book: "john", chapter: 0 },
    { seq: 1, book: "john", chapter: 151 },
    { seq: 1, book: "john", chapter: 3.5 },
    { seq: 1, book: "john", chapter: "3" },
    { seq: 1, book: "john", chapter: 3, extra: true },
    null,
  ]
  for (const payload of bad) assert.equal(validateWsMessage(message("bible:chapter", payload), "operator").ok, false, JSON.stringify(payload))
})

test("bible:search: accepted up to 120 characters, refused above, for viewers, or with extra keys", () => {
  assert.equal(validateWsMessage(message("bible:search", { seq: 1, query: "dieu a tant aimé" }), "operator").ok, true)
  assert.equal(validateWsMessage(message("bible:search", { seq: 1, query: "" }), "operator").ok, true)
  assert.equal(validateWsMessage(message("bible:search", { seq: 1, query: "x".repeat(120) }), "operator").ok, true)
  assert.equal(validateWsMessage(message("bible:search", { seq: 1, query: "x".repeat(121) }), "operator").ok, false)
  assert.equal(validateWsMessage(message("bible:search", { seq: 1, query: 5 }), "operator").ok, false)
  assert.equal(validateWsMessage(message("bible:search", { seq: 1, query: "a", limit: 9999 }), "operator").ok, false)
  assert.equal(validateWsMessage(message("bible:search", { seq: 1, query: "amour" }), "viewer").ok, false)
})

test("verse:navigate: only the four directions, operator only", () => {
  for (const direction of ["next-verse", "previous-verse", "next-chapter", "previous-chapter"]) {
    assert.equal(validateWsMessage(message("verse:navigate", { direction }), "operator").ok, true, direction)
    assert.equal(validateWsMessage(message("verse:navigate", { direction }), "viewer").ok, false)
  }
  for (const payload of [{ direction: "goto-chapter" }, { direction: "constructor" }, { direction: 1 }, {}, null, { direction: "next-verse", book: "john" }]) {
    assert.equal(validateWsMessage(message("verse:navigate", payload), "operator").ok, false, JSON.stringify(payload))
  }
})

// ---- events: server-only (no client may send them) ----------------------------

test("bible:chapter-result and bible:search-result can never be sent inbound, by any role", () => {
  const chapterResult = message("bible:chapter-result", { seq: 1, book: "john", chapter: 3, verses: null, reason: "not-found" })
  const searchResult = message("bible:search-result", { seq: 1, query: "a", hits: [], total: 0, coverage: { french: "offline", loadedChapters: 0 } })
  for (const role of ["operator", "viewer"] as const) {
    assert.equal(validateWsMessage(chapterResult, role).ok, false)
    assert.equal(validateWsMessage(searchResult, role).ok, false)
  }
})

// ---- outbound payload shapes (what the server emits, bounded) -------------------

import { isBibleChapterResultPayload, isBibleSearchResultPayload } from "./bible-browser-payloads"

test("bible:chapter-result: a well-formed chapter, or a null verse list WITH a reason, is valid; unbounded or malformed is not", () => {
  const ok = { seq: 1, book: "john", chapter: 3, verses: [{ verse: 1, text: "a" }, { verse: 2, text: "b", secondary: "c" }], translation: "kjv", source: "x" }
  assert.equal(isBibleChapterResultPayload(ok), true)
  assert.equal(isBibleChapterResultPayload({ seq: 1, book: "john", chapter: 3, verses: null, reason: "unavailable" }), true)
  assert.equal(isBibleChapterResultPayload({ seq: 1, book: "john", chapter: 3, verses: null }), false, "null needs a reason")
  assert.equal(isBibleChapterResultPayload({ ...ok, verses: [] }), false)
  assert.equal(isBibleChapterResultPayload({ ...ok, verses: Array.from({ length: 201 }, (_, i) => ({ verse: i + 1, text: "a" })) }), false)
  assert.equal(isBibleChapterResultPayload({ ...ok, verses: [{ verse: 1, text: "x".repeat(4001) }] }), false)
  assert.equal(isBibleChapterResultPayload({ ...ok, verses: [{ verse: 0, text: "a" }] }), false)
  assert.equal(isBibleChapterResultPayload({ ...ok, reason: "weird" }), false)
})

test("bible:search-result: at most 20 hits, references and scores sane, coverage required", () => {
  const hit = { reference: { book: "john", chapter: 3, verse: 16 }, text: "t", translation: "ls1910", score: 0.9 }
  const ok = { seq: 1, query: "q", hits: [hit], total: 1, coverage: { french: "offline", loadedChapters: 0 } }
  assert.equal(isBibleSearchResultPayload(ok), true)
  assert.equal(isBibleSearchResultPayload({ ...ok, hits: Array.from({ length: 21 }, () => hit) }), false)
  assert.equal(isBibleSearchResultPayload({ ...ok, hits: [{ ...hit, score: 5 }] }), false)
  assert.equal(isBibleSearchResultPayload({ ...ok, hits: [{ ...hit, reference: { book: "", chapter: 1, verse: 1 } }] }), false)
  assert.equal(isBibleSearchResultPayload({ ...ok, coverage: { french: "maybe", loadedChapters: 0 } }), false)
  assert.equal(isBibleSearchResultPayload({ seq: 1, query: "q", hits: [], total: 0 }), false)
})

test("verse:navigate-result and chapter 'missing' are validated and server-only", async () => {
  const { isVerseNavigateResultPayload } = await import("./bible-browser-payloads")
  assert.equal(isVerseNavigateResultPayload({ direction: "next-verse", reason: "boundary" }), true)
  assert.equal(isVerseNavigateResultPayload({ direction: "next-verse", reason: "weird" }), false)
  assert.equal(validateWsMessage(message("verse:navigate-result", { direction: "next-verse", reason: "boundary" }), "operator").ok, false)
  const ok = { seq: 1, book: "john", chapter: 3, verses: [{ verse: 1, text: "a" }], missing: [2, 3] }
  assert.equal(isBibleChapterResultPayload(ok), true)
  assert.equal(isBibleChapterResultPayload({ ...ok, missing: [0] }), false)
  assert.equal(isBibleChapterResultPayload({ ...ok, missing: "2" }), false)
})
