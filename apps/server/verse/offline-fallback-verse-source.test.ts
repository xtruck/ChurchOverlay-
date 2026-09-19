import { test } from "node:test"
import assert from "node:assert/strict"
import { OfflineFallbackVerseSource } from "./offline-fallback-verse-source"
import { CircuitBreaker } from "./circuit-breaker"
import { Logger } from "../../../packages/shared/logger"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"

const JOHN_3_16: VerseReference = { book: "john", chapter: 3, verse: 16 }

function makeVerse(source: string): Verse {
  return { reference: JOHN_3_16, text: "For God so loved the world...", translation: "kjv", source }
}

/** Named per AGENTS.md section 45 — a test double, not a real source. */
class FakeVerseSource implements VerseSource {
  calls = 0
  constructor(private readonly behavior: () => Promise<Verse | null>) {}
  async getVerse(): Promise<Verse | null> {
    this.calls += 1
    return this.behavior()
  }
}

function capturingLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = []
  const logger = new Logger({ write: (line) => lines.push(JSON.parse(line)) })
  return { logger, lines }
}

test("OfflineFallbackVerseSource: a healthy primary is used directly — offline is never even called", async () => {
  const primary = new FakeVerseSource(async () => makeVerse("live-api"))
  const offline = new FakeVerseSource(async () => {
    throw new Error("must not be called")
  })
  const source = new OfflineFallbackVerseSource({ primary, offline })

  const verse = await source.getVerse(JOHN_3_16)
  assert.deepEqual(verse, makeVerse("live-api"))
  assert.equal(primary.calls, 1)
  assert.equal(offline.calls, 0)
})

test("OfflineFallbackVerseSource: a primary that confirms 'not found' (returns null) is trusted — offline is not consulted", async () => {
  const primary = new FakeVerseSource(async () => null)
  const offline = new FakeVerseSource(async () => {
    throw new Error("must not be called")
  })
  const source = new OfflineFallbackVerseSource({ primary, offline })

  assert.equal(await source.getVerse(JOHN_3_16), null)
  assert.equal(offline.calls, 0)
})

test("OfflineFallbackVerseSource: a thrown primary error falls back to offline, and is logged", async () => {
  const primary = new FakeVerseSource(async () => {
    throw new Error("network unreachable")
  })
  const offline = new FakeVerseSource(async () => makeVerse("offline-bundled"))
  const { logger, lines } = capturingLogger()
  const source = new OfflineFallbackVerseSource({ primary, offline, logger })

  const verse = await source.getVerse(JOHN_3_16)
  assert.deepEqual(verse, makeVerse("offline-bundled"))
  assert.equal(lines.length, 1)
  const entry = lines[0] as { level: string; event: string }
  assert.equal(entry.level, "warn")
  assert.equal(entry.event, "primary-failed-using-offline")
})

test("OfflineFallbackVerseSource: once its own circuit breaker opens, primary is skipped entirely — straight to offline", async () => {
  const primary = new FakeVerseSource(async () => {
    throw new Error("network unreachable")
  })
  const offline = new FakeVerseSource(async () => makeVerse("offline-bundled"))
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 1 })
  const source = new OfflineFallbackVerseSource({ primary, offline, circuitBreaker })

  await source.getVerse(JOHN_3_16) // fails, opens the (1-failure-threshold) circuit
  assert.equal(primary.calls, 1)

  const verse = await source.getVerse(JOHN_3_16) // circuit now open
  assert.deepEqual(verse, makeVerse("offline-bundled"))
  assert.equal(primary.calls, 1) // NOT called again — this is the whole point of the inner breaker
  assert.equal(offline.calls, 2)
})

test("OfflineFallbackVerseSource: a successful primary call resets its own circuit breaker's failure streak", async () => {
  let shouldFail = true
  const primary = new FakeVerseSource(async () => {
    if (shouldFail) throw new Error("transient")
    return makeVerse("live-api")
  })
  const offline = new FakeVerseSource(async () => makeVerse("offline-bundled"))
  // threshold 2: one failure alone must not open it.
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 2 })
  const source = new OfflineFallbackVerseSource({ primary, offline, circuitBreaker })

  await source.getVerse(JOHN_3_16) // 1 failure, still closed
  shouldFail = false
  const recovered = await source.getVerse(JOHN_3_16) // succeeds, resets the streak
  assert.deepEqual(recovered, makeVerse("live-api"))
  assert.equal(primary.calls, 2)
})
