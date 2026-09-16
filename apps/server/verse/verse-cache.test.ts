import { test } from "node:test"
import assert from "node:assert/strict"
import { VerseCache, buildVerseCacheKey } from "./verse-cache"
import type { Verse } from "../../../packages/contracts"

const JOHN_3_16 = { book: "john", chapter: 3, verse: 16 }

function makeVerse(overrides: Partial<Verse> = {}): Verse {
  return {
    reference: JOHN_3_16,
    text: "For God so loved the world...",
    translation: "kjv",
    source: "free-api",
    ...overrides,
  }
}

test("buildVerseCacheKey: matches the exact format from ARCHITECTURE.md section 19", () => {
  assert.equal(buildVerseCacheKey(JOHN_3_16, "default"), "john:3:16:default")
})

test("buildVerseCacheKey: normalizes book case/whitespace and translation case", () => {
  assert.equal(
    buildVerseCacheKey({ book: "  1  Corinthians ", chapter: 13, verse: 4 }, "KJV"),
    "1 corinthians:13:4:kjv"
  )
})

test("VerseCache: a cache miss returns undefined and is not negatively cached", () => {
  const cache = new VerseCache()
  assert.equal(cache.getVerse(JOHN_3_16, "kjv"), undefined)
  assert.equal(cache.isNegativelyCached(JOHN_3_16, "kjv"), false)
})

test("VerseCache: setVerse/getVerse roundtrip", () => {
  const cache = new VerseCache()
  const verse = makeVerse()
  cache.setVerse(JOHN_3_16, "kjv", verse)
  assert.deepEqual(cache.getVerse(JOHN_3_16, "kjv"), verse)
})

test("VerseCache: setNotFound/isNegativelyCached roundtrip", () => {
  const cache = new VerseCache()
  cache.setNotFound({ book: "john", chapter: 999, verse: 999 }, "kjv")
  assert.equal(cache.isNegativelyCached({ book: "john", chapter: 999, verse: 999 }, "kjv"), true)
  assert.equal(cache.getVerse({ book: "john", chapter: 999, verse: 999 }, "kjv"), undefined)
})

test("VerseCache: a fresh positive result clears a stale negative entry for the same key", () => {
  const cache = new VerseCache()
  cache.setNotFound(JOHN_3_16, "kjv")
  assert.equal(cache.isNegativelyCached(JOHN_3_16, "kjv"), true)

  cache.setVerse(JOHN_3_16, "kjv", makeVerse())
  assert.equal(cache.isNegativelyCached(JOHN_3_16, "kjv"), false)
  assert.deepEqual(cache.getVerse(JOHN_3_16, "kjv"), makeVerse())
})

test("VerseCache: a fresh negative result clears a stale positive entry for the same key", () => {
  const cache = new VerseCache()
  cache.setVerse(JOHN_3_16, "kjv", makeVerse())
  assert.deepEqual(cache.getVerse(JOHN_3_16, "kjv"), makeVerse())

  cache.setNotFound(JOHN_3_16, "kjv")
  assert.equal(cache.getVerse(JOHN_3_16, "kjv"), undefined)
  assert.equal(cache.isNegativelyCached(JOHN_3_16, "kjv"), true)
})

test("VerseCache: translation identity is part of the key — same reference, different translation, does not collide", () => {
  const cache = new VerseCache()
  cache.setVerse(JOHN_3_16, "kjv", makeVerse({ translation: "kjv", text: "KJV text" }))
  assert.equal(cache.getVerse(JOHN_3_16, "niv"), undefined)
})

// ARCHITECTURE.md section 20: negative entries must have a shorter
// lifetime than successful entries.
test("VerseCache: negative entries expire before positive entries with the default TTLs", () => {
  let now = 0
  const cache = new VerseCache({ now: () => now })
  cache.setVerse(JOHN_3_16, "kjv", makeVerse())
  cache.setNotFound({ book: "john", chapter: 999, verse: 999 }, "kjv")

  now = 5 * 60 * 1000 // 5 minutes: past the default negative TTL
  assert.equal(cache.isNegativelyCached({ book: "john", chapter: 999, verse: 999 }, "kjv"), false)
  assert.deepEqual(cache.getVerse(JOHN_3_16, "kjv"), makeVerse()) // positive entry still alive
})

test("VerseCache: the positive and negative caches are independently bounded", () => {
  const cache = new VerseCache({ maxPositiveEntries: 1, maxNegativeEntries: 1 })
  cache.setVerse({ book: "john", chapter: 1, verse: 1 }, "kjv", makeVerse())
  cache.setVerse({ book: "john", chapter: 2, verse: 1 }, "kjv", makeVerse())
  assert.equal(cache.getVerse({ book: "john", chapter: 1, verse: 1 }, "kjv"), undefined)
  assert.deepEqual(cache.getVerse({ book: "john", chapter: 2, verse: 1 }, "kjv"), makeVerse())
})
