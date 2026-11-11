import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveChapter } from "./resolve-chapter"
import { ChapterCache } from "./chapter-cache"
import { VerseCache } from "./verse-cache"
import { CircuitBreaker } from "./circuit-breaker"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"

const TRANSLATION = "english"

function verses(book: string, chapter: number, count: number): Verse[] {
  return Array.from({ length: count }, (_, i) => ({
    reference: { book, chapter, verse: i + 1 },
    text: `text ${i + 1}`,
    translation: "kjv",
    source: "fake",
  }))
}

/** Named per AGENTS.md section 45 — a test double, not a real source. */
class FakeChapterSource implements VerseSource {
  calls = 0
  constructor(private readonly behavior: () => Promise<readonly Verse[] | null>) {}
  async getVerse(): Promise<Verse | null> {
    throw new Error("getVerse must not be used when getChapter exists")
  }
  async getChapter(): Promise<readonly Verse[] | null> {
    this.calls += 1
    return this.behavior()
  }
}

function deps() {
  return { chapterCache: new ChapterCache(), verseCache: new VerseCache(), breaker: new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 }) }
}

test("resolveChapter: reads once, caches the chapter, and warms the verse cache", async () => {
  const d = deps()
  const source = new FakeChapterSource(async () => verses("john", 3, 4))
  const first = await resolveChapter("john", 3, 36, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(first.kind, "ok")
  const again = await resolveChapter("john", 3, 36, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(again.kind, "ok")
  assert.equal(source.calls, 1, "the second read must come from the chapter cache")
  const ref: VerseReference = { book: "john", chapter: 3, verse: 2 }
  assert.equal(d.verseCache.getVerse(ref, TRANSLATION)?.text, "text 2", "a later verse:override of this verse is already cached")
})

test("resolveChapter: a confirmed-absent chapter is negative-cached and not asked again", async () => {
  const d = deps()
  const source = new FakeChapterSource(async () => null)
  assert.deepEqual(await resolveChapter("john", 3, 36, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION), { kind: "not-found" })
  assert.deepEqual(await resolveChapter("john", 3, 36, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION), { kind: "not-found" })
  assert.equal(source.calls, 1)
})

test("resolveChapter: a failing source is unavailable, and is NOT cached either way", async () => {
  const d = deps()
  let fail = true
  const source = new FakeChapterSource(async () => {
    if (fail) throw new Error("network")
    return verses("john", 3, 4)
  })
  assert.deepEqual(await resolveChapter("john", 3, 36, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION), { kind: "unavailable" })
  fail = false
  const retry = await resolveChapter("john", 3, 36, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(retry.kind, "ok", "a transient failure must not hide the chapter")
})

test("resolveChapter: an open circuit breaker answers unavailable without calling the source", async () => {
  const d = deps()
  const source = new FakeChapterSource(async () => {
    throw new Error("down")
  })
  await resolveChapter("john", 1, 51, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  await resolveChapter("john", 2, 25, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(d.breaker.getState(), "open")
  const before = source.calls
  assert.deepEqual(await resolveChapter("john", 3, 36, source, d.chapterCache, d.verseCache, d.breaker, TRANSLATION), { kind: "unavailable" })
  assert.equal(source.calls, before)
})

test("resolveChapter: a malformed source answer (other chapter, empty text, empty list) is a failure, never shown", async () => {
  for (const bad of [
    [{ reference: { book: "john", chapter: 4, verse: 1 }, text: "x", translation: "kjv", source: "f" }],
    [{ reference: { book: "john", chapter: 3, verse: 1 }, text: "   ", translation: "kjv", source: "f" }],
    [] as Verse[],
  ]) {
    const d = deps()
    const result = await resolveChapter("john", 3, 36, new FakeChapterSource(async () => bad), d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
    assert.deepEqual(result, { kind: "unavailable" })
    assert.equal(d.chapterCache.get("john", 3, TRANSLATION), undefined)
  }
})

test("resolveChapter: verses past the catalog count are dropped (they could never pass the known-valid index)", async () => {
  const d = deps()
  const result = await resolveChapter("john", 3, 3, new FakeChapterSource(async () => verses("john", 3, 6)), d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(result.kind, "ok")
  if (result.kind === "ok") assert.deepEqual(result.verses.map((v) => v.reference.verse), [1, 2, 3])
})

test("resolveChapter: a source without getChapter is read verse by verse; a chapter with gaps is returned but not cached", async () => {
  const d = deps()
  const onlyOdd: VerseSource = {
    getVerse: async (reference) => (reference.verse % 2 === 1 ? (verses("john", 3, 9)[reference.verse - 1] ?? null) : null),
  }
  const result = await resolveChapter("john", 3, 4, onlyOdd, d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(result.kind, "ok")
  if (result.kind === "ok") assert.deepEqual(result.verses.map((v) => v.reference.verse), [1, 3])
  assert.equal(d.chapterCache.get("john", 3, TRANSLATION), undefined)

  const complete = await resolveChapter(
    "john",
    4,
    2,
    { getVerse: async (r) => verses("john", 4, 2)[r.verse - 1] ?? null },
    d.chapterCache,
    d.verseCache,
    d.breaker,
    TRANSLATION
  )
  assert.equal(complete.kind, "ok")
  assert.ok(d.chapterCache.get("john", 4, TRANSLATION))
})

test("ChapterCache: bounded LRU, and loadedChapters() lists what is currently loaded", () => {
  const cache = new ChapterCache({ maxChapters: 2 })
  cache.set("john", 1, "t", verses("john", 1, 1))
  cache.set("john", 2, "t", verses("john", 2, 1))
  cache.set("john", 3, "t", verses("john", 3, 1))
  assert.equal(cache.get("john", 1, "t"), undefined, "oldest evicted")
  assert.equal(cache.loadedChapters().length, 2)
})

test("resolveChapter: malformed chapters from the browser never trip the breaker shared with LIVE verse display", async () => {
  const d = deps() // threshold 2: two counted failures would open it
  const malformed = new FakeChapterSource(async () => [{ reference: { book: "john", chapter: 9, verse: 1 }, text: "x", translation: "kjv", source: "f" }])
  for (let i = 1; i <= 6; i++) {
    const result = await resolveChapter("john", 3, 36, malformed, d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
    assert.deepEqual(result, { kind: "unavailable" })
  }
  assert.equal(d.breaker.getState(), "closed")
  const live: VerseSource = { getVerse: async (reference) => ({ reference, text: "live", translation: "kjv", source: "f" }) }
  const { resolveVerse } = await import("./resolve-verse")
  const verse = await resolveVerse({ book: "john", chapter: 3, verse: 16 }, live, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(verse?.text, "live", "live display is still available")
})

test("resolveChapter: oversize verse text fails explicitly, and a gappy chapter reports its missing verses", async () => {
  const d = deps()
  const huge = [{ reference: { book: "john", chapter: 3, verse: 1 }, text: "x".repeat(4001), translation: "kjv", source: "f" }]
  assert.deepEqual(await resolveChapter("john", 3, 36, new FakeChapterSource(async () => huge), d.chapterCache, d.verseCache, d.breaker, TRANSLATION), { kind: "unavailable" })
  const gappy = await resolveChapter("john", 4, 5, new FakeChapterSource(async () => verses("john", 4, 5).filter((v) => v.reference.verse !== 2 && v.reference.verse !== 4)), d.chapterCache, d.verseCache, d.breaker, TRANSLATION)
  assert.equal(gappy.kind, "ok")
  if (gappy.kind === "ok") assert.deepEqual(gappy.missing, [2, 4])
})
