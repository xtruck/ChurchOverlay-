import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveVerse } from "./resolve-verse"
import { VerseCache } from "./verse-cache"
import { CircuitBreaker } from "./circuit-breaker"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"

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
