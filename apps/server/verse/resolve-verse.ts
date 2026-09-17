import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"
import { VerseCache } from "./verse-cache"
import { CircuitBreaker } from "./circuit-breaker"

const DEFAULT_TRANSLATION = "kjv"

/**
 * Composes a VerseSource with its supporting infrastructure
 * (ARCHITECTURE.md sections 16-21): check the cache first (both the
 * positive and negative sides), consult the circuit breaker before
 * attempting a network call, and record the real outcome. This is the
 * sanctioned way to resolve an already-validated VerseReference into
 * actual verse text — a caller should never call source.getVerse()
 * directly and skip the cache/circuit-breaker layer.
 *
 * Relies on VerseSource's contract (see FreeApiSource's doc comment):
 * a resolved `null` means the service confirmed this reference has no
 * verse (cached as a negative result, and counted as a *success* for the
 * circuit breaker — a confirmed negative is a healthy response, not a
 * failure); a *thrown* error means the request or the service itself
 * failed (counted as a circuit-breaker failure, and deliberately left
 * uncached in either direction, since a transient failure tells us
 * nothing about whether the reference actually exists).
 *
 * Returns null both when the verse is confirmed not to exist and when
 * the circuit is open or the source call fails — ARCHITECTURE.md section
 * 48: "Bible API unavailable -> VERSE_SOURCE_UNAVAILABLE. No unverified
 * verse is displayed." Distinguishing *why* for an operator is a logging/
 * observability concern (not yet built), not something this function's
 * return type needs to carry.
 */
export async function resolveVerse(
  reference: VerseReference,
  source: VerseSource,
  cache: VerseCache,
  circuitBreaker: CircuitBreaker,
  translation: string = DEFAULT_TRANSLATION
): Promise<Verse | null> {
  const cached = cache.getVerse(reference, translation)
  if (cached) return cached

  if (cache.isNegativelyCached(reference, translation)) return null

  if (!circuitBreaker.canProceed()) return null

  try {
    const verse = await source.getVerse(reference)
    circuitBreaker.recordSuccess()

    if (verse) {
      cache.setVerse(reference, translation, verse)
    } else {
      cache.setNotFound(reference, translation)
    }
    return verse
  } catch {
    circuitBreaker.recordFailure()
    return null
  }
}
