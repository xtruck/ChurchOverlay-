import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveVerse, translationIdFor } from "./resolve-verse"
import { VerseCache } from "./verse-cache"
import { CircuitBreaker } from "./circuit-breaker"
import { Logger } from "../../../packages/shared/logger"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"

function capturingLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = []
  const logger = new Logger({ write: (line) => lines.push(JSON.parse(line)) })
  return { logger, lines }
}

const JOHN_3_16: VerseReference = { book: "john", chapter: 3, verse: 16 }
const SOME_VERSE: Verse = {
  reference: JOHN_3_16,
  text: "For God so loved the world...",
  translation: "kjv",
  source: "bible-api.com",
}

/** Named per AGENTS.md section 45 ("No Fake Implementations") — a test double, not a real provider. */
class CountingFakeVerseSource implements VerseSource {
  callCount = 0
  constructor(private readonly behavior: () => Promise<Verse | null>) {}
  async getVerse(): Promise<Verse | null> {
    this.callCount += 1
    return this.behavior()
  }
}

test("resolveVerse: a cache hit returns the cached verse without calling the source", async () => {
  const cache = new VerseCache()
  cache.setVerse(JOHN_3_16, "kjv", SOME_VERSE)
  const source = new CountingFakeVerseSource(async () => {
    throw new Error("must not be called")
  })

  const result = await resolveVerse(JOHN_3_16, source, cache, new CircuitBreaker())
  assert.deepEqual(result, SOME_VERSE)
  assert.equal(source.callCount, 0)
})

test("resolveVerse: a negatively-cached reference returns null without calling the source", async () => {
  const cache = new VerseCache()
  cache.setNotFound(JOHN_3_16, "kjv")
  const source = new CountingFakeVerseSource(async () => {
    throw new Error("must not be called")
  })

  const result = await resolveVerse(JOHN_3_16, source, cache, new CircuitBreaker())
  assert.equal(result, null)
  assert.equal(source.callCount, 0)
})

test("resolveVerse: on a cache miss, a successful source result is returned and cached positively", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker()
  const source = new CountingFakeVerseSource(async () => SOME_VERSE)

  const result = await resolveVerse(JOHN_3_16, source, cache, circuitBreaker)
  assert.deepEqual(result, SOME_VERSE)
  assert.equal(source.callCount, 1)
  assert.deepEqual(cache.getVerse(JOHN_3_16, "kjv"), SOME_VERSE)
  assert.equal(circuitBreaker.getState(), "closed")

  // A second call must hit the cache, not the source again.
  const second = await resolveVerse(JOHN_3_16, source, cache, circuitBreaker)
  assert.deepEqual(second, SOME_VERSE)
  assert.equal(source.callCount, 1)
})

test("resolveVerse: a confirmed 'not found' result is cached negatively and counts as a circuit-breaker success", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 1 })
  const source = new CountingFakeVerseSource(async () => null)

  const result = await resolveVerse(JOHN_3_16, source, cache, circuitBreaker)
  assert.equal(result, null)
  assert.equal(cache.isNegativelyCached(JOHN_3_16, "kjv"), true)
  // A confirmed negative is a healthy response — it must not open the circuit.
  assert.equal(circuitBreaker.getState(), "closed")

  const second = await resolveVerse(JOHN_3_16, source, cache, circuitBreaker)
  assert.equal(second, null)
  assert.equal(source.callCount, 1) // second call served from the negative cache
})

test("resolveVerse: a thrown source error returns null, counts as a circuit-breaker failure, and caches nothing", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 1 })
  const source = new CountingFakeVerseSource(async () => {
    throw new Error("service unavailable")
  })

  const result = await resolveVerse(JOHN_3_16, source, cache, circuitBreaker)
  assert.equal(result, null)
  assert.equal(circuitBreaker.getState(), "open")
  assert.equal(cache.getVerse(JOHN_3_16, "kjv"), undefined)
  assert.equal(cache.isNegativelyCached(JOHN_3_16, "kjv"), false)
})

test("resolveVerse: a thrown source error is reported through the optional logger (ARCHITECTURE.md section 40)", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 1 })
  const source = new CountingFakeVerseSource(async () => {
    throw new Error("bible-api.com is down")
  })
  const { logger, lines } = capturingLogger()

  await resolveVerse(JOHN_3_16, source, cache, circuitBreaker, undefined, logger)

  assert.equal(lines.length, 1)
  const entry = lines[0] as { level: string; event: string; error: string }
  assert.equal(entry.level, "error")
  assert.equal(entry.event, "source-failed")
  assert.equal(entry.error, "bible-api.com is down")
})

test("resolveVerse: an open circuit is reported through the optional logger, distinctly from a source failure", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 1 })
  const source = new CountingFakeVerseSource(async () => {
    throw new Error("first call opens the circuit")
  })
  const { logger, lines } = capturingLogger()

  await resolveVerse(JOHN_3_16, source, cache, circuitBreaker, undefined, logger)
  lines.length = 0 // discard the first call's own source-failed log

  const result = await resolveVerse(JOHN_3_16, source, cache, circuitBreaker, undefined, logger)
  assert.equal(result, null)
  assert.equal(lines.length, 1)
  const entry = lines[0] as { level: string; event: string }
  assert.equal(entry.level, "warn")
  assert.equal(entry.event, "circuit-open")
})

// ARCHITECTURE.md production audit (section 74): a hypothesis for an
// intermittently-missing verse — the reference was detected and logged
// upstream, but a prior transient failure silently suppresses every
// repeat for up to the negative TTL, with no log at the point that
// actually happens. This confirms it's now traceable.
test("resolveVerse: a suppressed negative-cache hit is logged with the reference and remaining TTL, distinctly from a fresh 'not found'", async () => {
  const cache = new VerseCache({ negativeTtlMs: 60000 })
  const source = new CountingFakeVerseSource(async () => null)
  const { logger, lines } = capturingLogger()

  await resolveVerse(JOHN_3_16, source, cache, new CircuitBreaker(), undefined, logger)
  assert.equal(lines.length, 0) // the first, fresh 'not found' logs nothing (existing behavior, unchanged)

  const result = await resolveVerse(JOHN_3_16, source, cache, new CircuitBreaker(), undefined, logger)
  assert.equal(result, null)
  assert.equal(source.callCount, 1) // the second call never reaches the source — suppressed by the negative cache
  assert.equal(lines.length, 1)
  const entry = lines[0] as { level: string; event: string; metadata: { reference: unknown; remainingMs: number } }
  assert.equal(entry.level, "warn")
  assert.equal(entry.event, "suppressed-negative-cache")
  assert.deepEqual(entry.metadata.reference, JOHN_3_16)
  assert.ok(entry.metadata.remainingMs > 0 && entry.metadata.remainingMs <= 60000)
})

test("resolveVerse: a confirmed 'not found' result logs nothing — only real failures are reported", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker()
  const source = new CountingFakeVerseSource(async () => null)
  const { logger, lines } = capturingLogger()

  await resolveVerse(JOHN_3_16, source, cache, circuitBreaker, undefined, logger)
  assert.equal(lines.length, 0)
})

test("resolveVerse: an open circuit short-circuits without calling the source at all", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 1 })
  const source = new CountingFakeVerseSource(async () => {
    throw new Error("first call opens the circuit")
  })

  await resolveVerse(JOHN_3_16, source, cache, circuitBreaker)
  assert.equal(circuitBreaker.getState(), "open")

  // A different, uncached reference — proves the short-circuit is the
  // circuit breaker's doing, not an incidental cache hit.
  const anotherReference: VerseReference = { book: "romans", chapter: 8, verse: 28 }
  const result = await resolveVerse(anotherReference, source, cache, circuitBreaker)
  assert.equal(result, null)
  assert.equal(source.callCount, 1) // still just the first call
})

test("translationIdFor: reads a source's optional getTranslationId() capability when present", () => {
  const withId: VerseSource & { getTranslationId(): string } = {
    async getVerse() {
      return null
    },
    getTranslationId() {
      return "bilingual"
    },
  }
  assert.equal(translationIdFor(withId), "bilingual")
})

test("translationIdFor: returns undefined for a source with no such capability, without throwing", () => {
  const plain: VerseSource = {
    async getVerse() {
      return null
    },
  }
  assert.equal(translationIdFor(plain), undefined)
})

// ARCHITECTURE.md section 16: a real regression test for the bug the audit
// found — a source whose output depends on live-mutable state (like
// LocalizedVerseSource's display mode) must not have its result served
// back from the cache under a DIFFERENT mode just because the reference
// is the same. Modeled here with a minimal fake rather than the real
// LocalizedVerseSource, since the bug is in resolveVerse()'s cache-key
// wiring, not in that class itself.
test("resolveVerse: switching a source's mode (via getTranslationId) does not serve a stale result cached under the previous mode", async () => {
  const cache = new VerseCache()
  const circuitBreaker = new CircuitBreaker()
  let mode = "english"
  const modeSwitchingSource: VerseSource & { getTranslationId(): string } = {
    async getVerse(reference) {
      return { reference, text: `${mode} text`, translation: mode, source: "test" }
    },
    getTranslationId() {
      return mode
    },
  }

  const english = await resolveVerse(
    JOHN_3_16,
    modeSwitchingSource,
    cache,
    circuitBreaker,
    translationIdFor(modeSwitchingSource)
  )
  assert.equal(english?.text, "english text")

  mode = "french"
  const french = await resolveVerse(
    JOHN_3_16,
    modeSwitchingSource,
    cache,
    circuitBreaker,
    translationIdFor(modeSwitchingSource)
  )
  assert.equal(french?.text, "french text") // NOT the stale "english text" from before the switch
})
