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
