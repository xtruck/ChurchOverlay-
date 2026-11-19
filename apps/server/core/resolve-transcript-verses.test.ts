import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { VerseCache } from "../verse/verse-cache"
import { CircuitBreaker } from "../verse/circuit-breaker"
import { resolveTranscriptVerses } from "./resolve-transcript-verses"
import type { TranscriptResult, Verse, VerseReference, VerseSource } from "../../../packages/contracts"

function makeTranscript(overrides: Partial<TranscriptResult>): TranscriptResult {
  return {
    id: "01ABC",
    correlationId: "01CORR",
    sequence: 0,
    text: "",
    state: "final",
    timestamp: Date.now(),
    ...overrides,
  }
}

/** Named per AGENTS.md section 45 — a test double, not a real provider. */
class StubVerseSource implements VerseSource {
  callCount = 0
  constructor(private readonly byBook: Record<string, Verse | "fail">) {}
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    this.callCount += 1
    const outcome = this.byBook[reference.book]
    if (outcome === "fail") throw new Error(`source failure for ${reference.book}`)
    return outcome ?? null
  }
}

function makeVerse(reference: VerseReference, text: string): Verse {
  return { reference, text, translation: "kjv", source: "bible-api.com" }
}

test("resolveTranscriptVerses: a final transcript with a real reference resolves to a verse", async () => {
  const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "For God so loved the world...")
  const source = new StubVerseSource({ john: johnVerse })

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "John 3:16" }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.deepEqual(result, [johnVerse])
})

// Proves the Transcript Gate holds all the way through this composed
// pipeline, not just at processTranscript's own isolated level.
test("resolveTranscriptVerses: a partial transcript resolves to nothing and never touches the source", async () => {
  const source = new StubVerseSource({
    john: makeVerse({ book: "john", chapter: 3, verse: 16 }, "text"),
  })

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "partial", text: "John 3:16" }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.deepEqual(result, [])
  assert.equal(source.callCount, 0)
})

// Proves the hallucination guard holds all the way through: the source is
// never even consulted for a book the known-valid index already rejected.
test("resolveTranscriptVerses: a syntactically-matched but nonexistent book never reaches the source", async () => {
  const source = new StubVerseSource({})

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "Frogs 3:16 is not a real verse." }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.deepEqual(result, [])
  assert.equal(source.callCount, 0)
})

test("resolveTranscriptVerses: multiple valid references resolve to multiple verses, in order", async () => {
  const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "John text")
  const romansVerse = makeVerse({ book: "romans", chapter: 8, verse: 28 }, "Romans text")
  const source = new StubVerseSource({ john: johnVerse, romans: romansVerse })

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "Read John 3:16 and then Romans 8:28." }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.deepEqual(result, [johnVerse, romansVerse])
})

test("resolveTranscriptVerses: a source failure for one reference does not prevent others from resolving", async () => {
  const romansVerse = makeVerse({ book: "romans", chapter: 8, verse: 28 }, "Romans text")
  const source = new StubVerseSource({ john: "fail", romans: romansVerse })

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "Read John 3:16 and then Romans 8:28." }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.deepEqual(result, [romansVerse])
})

test("resolveTranscriptVerses: no detected references means the source is never called", async () => {
  const source = new StubVerseSource({})

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "Welcome everyone, let's begin worship." }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.deepEqual(result, [])
  assert.equal(source.callCount, 0)
})

// ---------------------------------------------------------------------------
// Innovation pass (ARCHITECTURE.md section 145): verse ranges + concurrency.
// ---------------------------------------------------------------------------

/** A chapter-capable stub: one getChapter call serves the whole chapter. */
class ChapterStubSource implements VerseSource {
  chapterCalls = 0
  constructor(private readonly chapters: Record<string, readonly Verse[]>) {}
  async getVerse(_reference: VerseReference): Promise<Verse | null> {
    throw new Error("getVerse must not be reached when getChapter exists")
  }
  async getChapter(book: string, chapter: number): Promise<readonly Verse[] | null> {
    this.chapterCalls += 1
    return this.chapters[`${book}:${chapter}`] ?? null
  }
}

/** A verse-by-verse stub whose resolution you gate, to prove concurrency. */
class GatedSource implements VerseSource {
  inFlight = 0
  maxConcurrent = 0
  constructor(private readonly byBook: Record<string, Verse | "fail">) {}
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    this.inFlight += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    this.inFlight -= 1
    const outcome = this.byBook[reference.book]
    if (outcome === "fail") throw new Error(`source failure for ${reference.book}`)
    return outcome ?? null
  }
}

test("resolveTranscriptVerses: a detected spoken range resolves into ONE joined verse with verseEnd", async () => {
  const source = new ChapterStubSource({
    "john:3": Array.from({ length: 21 }, (_, i) =>
      makeVerse({ book: "john", chapter: 3, verse: i + 1 }, `text ${i + 1}`)
    ),
  })
  const detector = new RegexDetector()

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "Jean chapitre 3 versets 16 à 18" }),
    detector,
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker(),
    undefined,
    undefined,
    detector
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0]!.reference, { book: "john", chapter: 3, verse: 16 })
  assert.equal(result[0]!.verseEnd, 18)
  assert.equal(result[0]!.text, "[16] text 16 [17] text 17 [18] text 18")
  assert.equal(source.chapterCalls, 1)
})

test("resolveTranscriptVerses: a range's verses never also show as leftover singles", async () => {
  // Both shapes in one transcript: the range owns 16-18; "Romains 8:28" is standalone.
  const source = new ChapterStubSource({
    "john:3": Array.from({ length: 21 }, (_, i) =>
      makeVerse({ book: "john", chapter: 3, verse: i + 1 }, `text ${i + 1}`)
    ),
    "romans:8": [makeVerse({ book: "romans", chapter: 8, verse: 28 }, "Romans text")],
  })
  const detector = new RegexDetector()

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "Jean chapitre 3 versets 16 à 18 et Romains 8:28" }),
    detector,
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker(),
    undefined,
    undefined,
    detector
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[0]!.reference, { book: "romans", chapter: 8, verse: 28 })
  assert.equal(result[1]!.verseEnd, 18)
  assert.equal((result[1]!.text.match(/\[\d+\]/g) ?? []).length, 3)
})

test("resolveTranscriptVerses: references in different chapters resolve CONCURRENTLY (order preserved)", async () => {
  const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "John text")
  const romansVerse = makeVerse({ book: "romans", chapter: 8, verse: 28 }, "Romans text")
  const psalmVerse = makeVerse({ book: "psalm", chapter: 23, verse: 1 }, "Psalm text")
  const source = new GatedSource({ john: johnVerse, romans: romansVerse, psalm: psalmVerse })
  const lookups: string[] = []

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "John 3:16, Romans 8:28 and Psalm 23:1." }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker(),
    undefined,
    (reference, failure) => lookups.push(`${reference.book}:${failure ?? "ok"}`)
  )
  // Order is exactly the sequential version's, only sooner.
  assert.deepEqual(result, [johnVerse, romansVerse, psalmVerse])
  assert.deepEqual(lookups, ["john:ok", "romans:ok", "psalm:ok"])
  // The concurrency proof: three gated 10 ms reads overlapped instead of queueing.
  assert.ok(source.maxConcurrent >= 2, `expected overlapping reads, maxConcurrent=${source.maxConcurrent}`)
})

test("resolveTranscriptVerses: a range still resolves without the optional range capability (plain VerseDetector)", async () => {
  const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "John text")
  const source = new StubVerseSource({ john: johnVerse })

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "final", text: "John 3:16" }),
    new RegexDetector(),
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker()
  )
  assert.deepEqual(result, [johnVerse])
})

test("resolveTranscriptVerses: a range inside a gated (partial) transcript resolves nothing", async () => {
  const source = new ChapterStubSource({
    "john:3": Array.from({ length: 21 }, (_, i) =>
      makeVerse({ book: "john", chapter: 3, verse: i + 1 }, `text ${i + 1}`)
    ),
  })
  const detector = new RegexDetector()

  const result = await resolveTranscriptVerses(
    makeTranscript({ state: "partial", text: "Jean chapitre 3 versets 16 à 18" }),
    detector,
    new KnownValidVerseIndex(),
    source,
    new VerseCache(),
    new CircuitBreaker(),
    undefined,
    undefined,
    detector
  )
  assert.deepEqual(result, [])
  assert.equal(source.chapterCalls, 0)
})
