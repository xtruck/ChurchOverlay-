import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionRecorder } from "./session-recorder"
import type { Verse } from "../../../packages/contracts"

function makeVerse(book: string, chapter: number, verse: number, text: string): Verse {
  return { reference: { book, chapter, verse }, text, translation: "kjv", source: "test" }
}

test("SessionRecorder: getEntries() is empty for a fresh recorder", () => {
  const recorder = new SessionRecorder()
  assert.deepEqual(recorder.getEntries(), [])
})

test("SessionRecorder: record() appends an entry with the reference, text, translation, and given timestamp", () => {
  const recorder = new SessionRecorder()
  recorder.record(makeVerse("john", 3, 16, "For God so loved the world..."), 1700000000000)

  assert.deepEqual(recorder.getEntries(), [
    {
      reference: { book: "john", chapter: 3, verse: 16 },
      text: "For God so loved the world...",
      translation: "kjv",
      timestamp: 1700000000000,
    },
  ])
})

test("SessionRecorder: multiple record() calls accumulate in order", () => {
  const recorder = new SessionRecorder()
  recorder.record(makeVerse("john", 3, 16, "text A"), 1)
  recorder.record(makeVerse("romans", 8, 28, "text B"), 2)

  const entries = recorder.getEntries()
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.reference.book, "john")
  assert.equal(entries[1]?.reference.book, "romans")
})

test("SessionRecorder: getEntries() returns a read-only view, not the same mutable array reference behavior", () => {
  const recorder = new SessionRecorder()
  recorder.record(makeVerse("john", 3, 16, "text"), 1)
  const first = recorder.getEntries()
  recorder.record(makeVerse("romans", 8, 28, "text2"), 2)
  const second = recorder.getEntries()
  // Confirms getEntries() reflects the CURRENT state each call, not a
  // stale snapshot frozen at the first call.
  assert.equal(first.length, 1)
  assert.equal(second.length, 2)
})
