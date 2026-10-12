import { test } from "node:test"
import assert from "node:assert/strict"
import { KnownValidVerseIndex } from "./known-valid-verse-index"
import { suggestNearestReferences } from "./nearest-references"

const index = new KnownValidVerseIndex()

test("suggestNearestReferences: a verse past the end of a real chapter offers that chapter's last verse (live case: Isaiah 4:8)", () => {
  assert.deepEqual(suggestNearestReferences({ book: "isaiah", chapter: 4, verse: 8 }, index), [
    { book: "isaiah", chapter: 4, verse: 6 },
  ])
})

test("suggestNearestReferences: a valid reference needs no suggestion", () => {
  assert.deepEqual(suggestNearestReferences({ book: "john", chapter: 3, verse: 16 }, index), [])
})

test("suggestNearestReferences: an out-of-range chapter or unknown book has no honest guess", () => {
  assert.deepEqual(suggestNearestReferences({ book: "john", chapter: 23, verse: 1 }, index), [])
  assert.deepEqual(suggestNearestReferences({ book: "frogs", chapter: 1, verse: 1 }, index), [])
  assert.deepEqual(suggestNearestReferences({ book: "john", chapter: 0, verse: 1 }, index), [])
})

test("suggestNearestReferences: verse 0 is not 'past the end' and gets no suggestion", () => {
  assert.deepEqual(suggestNearestReferences({ book: "john", chapter: 3, verse: 0 }, index), [])
})
