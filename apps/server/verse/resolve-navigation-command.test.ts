import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveNavigationCommand } from "./resolve-navigation-command"
import { KnownValidVerseIndex } from "./known-valid-verse-index"
import type { VerseReference } from "../../../packages/contracts"

const index = new KnownValidVerseIndex() // real catalog, real data — boundary rollover needs to be genuinely correct

test("resolveNavigationCommand: next-verse within a chapter", () => {
  const current: VerseReference = { book: "john", chapter: 3, verse: 15 }
  const result = resolveNavigationCommand({ kind: "next-verse" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 3, verse: 16 } })
})

test("resolveNavigationCommand: next-verse rolls into the next chapter at a chapter boundary (John 3:36 -> John 4:1)", () => {
  const current: VerseReference = { book: "john", chapter: 3, verse: 36 } // John 3 has exactly 36 verses
  const result = resolveNavigationCommand({ kind: "next-verse" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 4, verse: 1 } })
})

test("resolveNavigationCommand: next-verse rolls into the next BOOK at a book boundary (John 21:25 -> Acts 1:1)", () => {
  const current: VerseReference = { book: "john", chapter: 21, verse: 25 } // John's last chapter has exactly 25 verses
  const result = resolveNavigationCommand({ kind: "next-verse" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "acts", chapter: 1, verse: 1 } })
})

test("resolveNavigationCommand: next-verse at the very last verse of the Bible (Revelation 22:21) is a no-op", () => {
  const current: VerseReference = { book: "revelation", chapter: 22, verse: 21 } // Revelation's last chapter has exactly 21 verses
  const result = resolveNavigationCommand({ kind: "next-verse" }, current, index)
  assert.deepEqual(result, { kind: "no-op" })
})

test("resolveNavigationCommand: previous-verse within a chapter", () => {
  const current: VerseReference = { book: "john", chapter: 3, verse: 16 }
  const result = resolveNavigationCommand({ kind: "previous-verse" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 3, verse: 15 } })
})

test("resolveNavigationCommand: previous-verse rolls into the previous chapter's last verse (John 4:1 -> John 3:36)", () => {
  const current: VerseReference = { book: "john", chapter: 4, verse: 1 }
  const result = resolveNavigationCommand({ kind: "previous-verse" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 3, verse: 36 } })
})

test("resolveNavigationCommand: previous-verse rolls into the previous BOOK's last verse (Acts 1:1 -> John 21:25)", () => {
  const current: VerseReference = { book: "acts", chapter: 1, verse: 1 }
  const result = resolveNavigationCommand({ kind: "previous-verse" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 21, verse: 25 } })
})

test("resolveNavigationCommand: previous-verse at the very first verse of the Bible (Genesis 1:1) is a no-op", () => {
  const current: VerseReference = { book: "genesis", chapter: 1, verse: 1 }
  const result = resolveNavigationCommand({ kind: "previous-verse" }, current, index)
  assert.deepEqual(result, { kind: "no-op" })
})

test("resolveNavigationCommand: next-chapter within a book", () => {
  const current: VerseReference = { book: "john", chapter: 3, verse: 16 }
  const result = resolveNavigationCommand({ kind: "next-chapter" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 4, verse: 1 } })
})

test("resolveNavigationCommand: next-chapter rolls into the next book at the last chapter (John 21 -> Acts 1)", () => {
  const current: VerseReference = { book: "john", chapter: 21, verse: 5 }
  const result = resolveNavigationCommand({ kind: "next-chapter" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "acts", chapter: 1, verse: 1 } })
})

test("resolveNavigationCommand: next-chapter at the last chapter of the last book (Revelation 22) is a no-op", () => {
  const current: VerseReference = { book: "revelation", chapter: 22, verse: 1 }
  const result = resolveNavigationCommand({ kind: "next-chapter" }, current, index)
  assert.deepEqual(result, { kind: "no-op" })
})

test("resolveNavigationCommand: previous-chapter within a book", () => {
  const current: VerseReference = { book: "john", chapter: 4, verse: 1 }
  const result = resolveNavigationCommand({ kind: "previous-chapter" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 3, verse: 1 } })
})

test("resolveNavigationCommand: previous-chapter rolls into the previous book's last chapter (Acts 1 -> John 21)", () => {
  const current: VerseReference = { book: "acts", chapter: 1, verse: 10 }
  const result = resolveNavigationCommand({ kind: "previous-chapter" }, current, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "john", chapter: 21, verse: 1 } })
})

test("resolveNavigationCommand: previous-chapter at the first chapter of the first book (Genesis 1) is a no-op", () => {
  const current: VerseReference = { book: "genesis", chapter: 1, verse: 1 }
  const result = resolveNavigationCommand({ kind: "previous-chapter" }, current, index)
  assert.deepEqual(result, { kind: "no-op" })
})

test("resolveNavigationCommand: next-verse/previous-verse/next-chapter/previous-chapter with no current position are all no-ops", () => {
  assert.deepEqual(resolveNavigationCommand({ kind: "next-verse" }, null, index), { kind: "no-op" })
  assert.deepEqual(resolveNavigationCommand({ kind: "previous-verse" }, null, index), { kind: "no-op" })
  assert.deepEqual(resolveNavigationCommand({ kind: "next-chapter" }, null, index), { kind: "no-op" })
  assert.deepEqual(resolveNavigationCommand({ kind: "previous-chapter" }, null, index), { kind: "no-op" })
})

test("resolveNavigationCommand: goto-chapter for a valid book/chapter resolves to verse 1", () => {
  const result = resolveNavigationCommand({ kind: "goto-chapter", book: "romans", chapter: 8 }, null, index)
  assert.deepEqual(result, { kind: "reference", reference: { book: "romans", chapter: 8, verse: 1 } })
})

test("resolveNavigationCommand: goto-chapter for an invalid book or out-of-range chapter is a no-op (never bypasses the hallucination guard)", () => {
  assert.deepEqual(
    resolveNavigationCommand({ kind: "goto-chapter", book: "frogs", chapter: 1 }, null, index),
    { kind: "no-op" }
  )
  assert.deepEqual(
    resolveNavigationCommand({ kind: "goto-chapter", book: "john", chapter: 999 }, null, index),
    { kind: "no-op" }
  )
})

test("resolveNavigationCommand: cancel always resolves to cancel, regardless of current position", () => {
  assert.deepEqual(resolveNavigationCommand({ kind: "cancel" }, null, index), { kind: "cancel" })
  assert.deepEqual(
    resolveNavigationCommand({ kind: "cancel" }, { book: "john", chapter: 3, verse: 16 }, index),
    { kind: "cancel" }
  )
})

test("resolveNavigationCommand: a current position with an unknown book is a no-op, not a crash", () => {
  const current: VerseReference = { book: "not-a-real-book", chapter: 1, verse: 1 }
  assert.deepEqual(resolveNavigationCommand({ kind: "next-verse" }, current, index), { kind: "no-op" })
  assert.deepEqual(resolveNavigationCommand({ kind: "previous-verse" }, current, index), { kind: "no-op" })
  assert.deepEqual(resolveNavigationCommand({ kind: "next-chapter" }, current, index), { kind: "no-op" })
  assert.deepEqual(resolveNavigationCommand({ kind: "previous-chapter" }, current, index), { kind: "no-op" })
})
