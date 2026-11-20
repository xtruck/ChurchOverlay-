import { test } from "node:test"
import assert from "node:assert/strict"
import { AsrContextHintsTracker, MAX_FOCUS_BOOKS } from "./asr-context-hints"

test("AsrContextHintsTracker: the newest focus book is first, bounded, and repeated notes are no-ops", () => {
  const t = new AsrContextHintsTracker()
  assert.deepEqual(t.current(), { focusBooks: [], plannedBooks: [] })
  assert.equal(t.noteFocusBook("john"), true)
  assert.equal(t.noteFocusBook("john"), false, "same book again: unchanged")
  assert.equal(t.noteFocusBook("romans"), true)
  assert.equal(t.noteFocusBook("acts"), true)
  assert.deepEqual(t.current().focusBooks, ["acts", "romans"])
  assert.equal(t.current().focusBooks.length, MAX_FOCUS_BOOKS)
  assert.equal(t.noteFocusBook("romans"), true, "moving an older focus book to the front is a change")
  assert.deepEqual(t.current().focusBooks, ["romans", "acts"])
})

test("AsrContextHintsTracker: unknown ids never reach a provider", () => {
  const t = new AsrContextHintsTracker()
  assert.equal(t.noteFocusBook("not-a-book"), false)
  assert.equal(t.setPlannedBooks(["john", "bogus", "john"]), true)
  assert.deepEqual(t.current().plannedBooks, ["john"])
})

test("AsrContextHintsTracker: the plan is deduplicated, reports real changes only, and never repeats a focus book", () => {
  const t = new AsrContextHintsTracker()
  assert.equal(t.setPlannedBooks(["psalm", "john"]), true)
  assert.equal(t.setPlannedBooks(["psalm", "john", "psalm"]), false)
  t.noteFocusBook("john")
  assert.deepEqual(t.current(), { focusBooks: ["john"], plannedBooks: ["psalm"] })
})

test("AsrContextHintsTracker: snapshots are immutable", () => {
  const t = new AsrContextHintsTracker()
  t.noteFocusBook("john")
  const snapshot = t.current()
  assert.throws(() => (snapshot.focusBooks as string[]).push("x"))
  t.noteFocusBook("acts")
  assert.deepEqual(snapshot.focusBooks, ["john"])
})
