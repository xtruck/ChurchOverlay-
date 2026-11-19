import { test } from "node:test"
import assert from "node:assert/strict"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"
import { VerseCache } from "./verse-cache"
import { CircuitBreaker } from "./circuit-breaker"
import { resolveVerseRange } from "./resolve-verse-range"

/** Named per AGENTS.md section 45 — a test double, not a real provider. */

function makeVerse(reference: VerseReference, text: string, secondary?: { text: string; translation: string; source: string }): Verse {
  return { reference, text, translation: "kjv", source: "bible-api.com", ...(secondary ? { secondary } : {}) }
}

function versesForChapter(book: string, chapter: number, count: number, secondary = false): Verse[] {
  return Array.from({ length: count }, (_, i) =>
    makeVerse(
      { book, chapter, verse: i + 1 },
      `text of ${book} ${chapter}:${i + 1}`,
      secondary ? { text: `texte de ${i + 1}`, translation: "ls1910", source: "offline" } : undefined
    )
  )
}

class ChapterStubSource implements VerseSource {
  chapterCallCount = 0
  constructor(private readonly chapters: Record<string, readonly Verse[] | null>, private readonly failChapter = false) {}
  async getVerse(_reference: VerseReference): Promise<Verse | null> {
    throw new Error("getVerse must not be called by the range resolver when getChapter exists")
  }
  async getChapter(book: string, chapter: number): Promise<readonly Verse[] | null> {
    this.chapterCallCount += 1
    if (this.failChapter) throw new Error("chapter read failed")
    return this.chapters[`${book}:${chapter}`] ?? null
  }
}

test("resolveVerseRange: joins the range into one Verse with bracketed verse numbers and verseEnd", async () => {
  const cache = new VerseCache()
  const source = new ChapterStubSource({ "john:3": versesForChapter("john", 3, 21) })

  const result = await resolveVerseRange(
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
    source,
    cache,
    new CircuitBreaker()
  )
  assert.ok(result)
  assert.deepEqual(result.reference, { book: "john", chapter: 3, verse: 16 })
  assert.equal(result.verseEnd, 18)
  assert.equal(result.text, "[16] text of john 3:16 [17] text of john 3:17 [18] text of john 3:18")
  assert.equal(result.translation, "kjv")
  assert.equal(result.source, "bible-api.com")
})

test("resolveVerseRange: the whole range resolves from ONE chapter read (warming pays)", async () => {
  const source = new ChapterStubSource({ "psalm:23": versesForChapter("psalm", 23, 6) })
  const cache = new VerseCache()

  const result = await resolveVerseRange(
    { book: "psalm", chapter: 23, startVerse: 1, endVerse: 6 },
    source,
    cache,
    new CircuitBreaker()
  )
  assert.ok(result)
  assert.equal(result.verseEnd, 6)
  assert.equal(source.chapterCallCount, 1)
  assert.equal((result.text.match(/\[\d+\]/g) ?? []).length, 6)
})

test("resolveVerseRange: a verse confirmed absent inside the range is skipped and logged, the rest still shows", async () => {
  // John 3 with verse 17 missing from the source (a versification gap).
  const chapters = versesForChapter("john", 3, 21).filter((v) => v.reference.verse !== 17)
  const source = new ChapterStubSource({ "john:3": chapters })

  const result = await resolveVerseRange(
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.ok(result)
  assert.equal(result.verseEnd, 18)
  assert.equal(result.text, "[16] text of john 3:16 [18] text of john 3:18")
})

test("resolveVerseRange: a start verse that fails to resolve shows nothing (null)", async () => {
  const source = new ChapterStubSource({ "john:3": null }) // confirmed-absent chapter
  const result = await resolveVerseRange(
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.equal(result, null)
})

test("resolveVerseRange: a thrown chapter read is a breaker failure, never a display", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 })
  const source = new ChapterStubSource({}, true)
  const result = await resolveVerseRange(
    { book: "john", chapter: 3, startVerse: 16, endVerse: 18 },
    source,
    new VerseCache(),
    breaker
  )
  assert.equal(result, null)
  assert.equal(breaker.canProceed(), false)
})

test("resolveVerseRange: a partial source failure keeps the resolved prefix", async () => {
  // A chapter-capable source that serves verses 1-5 of a 20-verse chapter.
  const source = new ChapterStubSource({ "psalm:23": versesForChapter("psalm", 23, 5) })
  const result = await resolveVerseRange(
    { book: "psalm", chapter: 23, startVerse: 1, endVerse: 6 },
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.ok(result)
  assert.equal(result.verseEnd, 6)
  assert.equal((result.text.match(/\[\d+\]/g) ?? []).length, 5)
})

test("resolveVerseRange: bilingual secondaries join when every verse carries them, and never half-join", async () => {
  const complete = new ChapterStubSource({ "john:3": versesForChapter("john", 3, 21, true) })
  const completeResult = await resolveVerseRange(
    { book: "john", chapter: 3, startVerse: 16, endVerse: 17 },
    complete,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.ok(completeResult?.secondary)
  assert.equal(completeResult.secondary.text, "[16] texte de 16 [17] texte de 17")
  assert.equal(completeResult.secondary.translation, "ls1910")

  // Verse 17 without a secondary -> the whole secondary is dropped, never half-shown.
  const withoutSecondary = versesForChapter("john", 3, 21, true).map((v) =>
    v.reference.verse === 17 ? makeVerse(v.reference, v.text) : v
  )
  const partial = new ChapterStubSource({ "john:3": withoutSecondary })
  const partialResult = await resolveVerseRange(
    { book: "john", chapter: 3, startVerse: 16, endVerse: 17 },
    partial,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.ok(partialResult)
  assert.equal(partialResult.secondary, undefined)
})
