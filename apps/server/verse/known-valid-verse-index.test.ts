import { test } from "node:test"
import assert from "node:assert/strict"
import { KnownValidVerseIndex } from "./known-valid-verse-index"

test("KnownValidVerseIndex: a real, in-range reference exists", () => {
  const index = new KnownValidVerseIndex()
  assert.equal(index.exists({ book: "john", chapter: 3, verse: 16 }), true)
  assert.equal(index.exists({ book: "romans", chapter: 8, verse: 28 }), true)
})

test("KnownValidVerseIndex: the last verse of a chapter exists, one past it does not", () => {
  const index = new KnownValidVerseIndex()
  // John 3 has 36 verses.
  assert.equal(index.exists({ book: "john", chapter: 3, verse: 36 }), true)
  assert.equal(index.exists({ book: "john", chapter: 3, verse: 37 }), false)
})

// The three canonical invalid examples from ARCHITECTURE.md section 14.
test("KnownValidVerseIndex: rejects an out-of-range chapter (John 999:999)", () => {
  const index = new KnownValidVerseIndex()
  assert.equal(index.exists({ book: "john", chapter: 999, verse: 999 }), false)
})

test("KnownValidVerseIndex: rejects an unrecognized book (UnknownBook 3:16)", () => {
  const index = new KnownValidVerseIndex()
  assert.equal(index.exists({ book: "unknownbook", chapter: 3, verse: 16 }), false)
})

test("KnownValidVerseIndex: rejects a negative chapter (John -1:16)", () => {
  const index = new KnownValidVerseIndex()
  assert.equal(index.exists({ book: "john", chapter: -1, verse: 16 }), false)
})

test("KnownValidVerseIndex: rejects chapter/verse zero and non-integers", () => {
  const index = new KnownValidVerseIndex()
  assert.equal(index.exists({ book: "john", chapter: 0, verse: 16 }), false)
  assert.equal(index.exists({ book: "john", chapter: 3, verse: 0 }), false)
  assert.equal(index.exists({ book: "john", chapter: 3.5, verse: 16 }), false)
})

test("KnownValidVerseIndex: resolves the same book regardless of the detector's whitespace/case normalization", () => {
  const index = new KnownValidVerseIndex()
  assert.equal(index.exists({ book: "1 corinthians", chapter: 13, verse: 4 }), true)
  assert.equal(index.exists({ book: "1  Corinthians", chapter: 13, verse: 4 }), true)
})

test("KnownValidVerseIndex: resolves a common alternate spelling (Psalms -> Psalm)", () => {
  const index = new KnownValidVerseIndex()
  // Psalm 119 is the longest chapter in the Bible, at 176 verses.
  assert.equal(index.exists({ book: "psalms", chapter: 119, verse: 176 }), true)
  assert.equal(index.exists({ book: "psalms", chapter: 119, verse: 177 }), false)
})

test("KnownValidVerseIndex: a single-chapter book validates against its one chapter (Jude)", () => {
  const index = new KnownValidVerseIndex()
  assert.equal(index.exists({ book: "jude", chapter: 1, verse: 25 }), true)
  assert.equal(index.exists({ book: "jude", chapter: 1, verse: 26 }), false)
  assert.equal(index.exists({ book: "jude", chapter: 2, verse: 1 }), false)
})
