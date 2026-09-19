import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { VerseCache } from "./verse-cache"
import { CircuitBreaker } from "./circuit-breaker"

const DEFAULT_TRANSLATION = "kjv"

/**
 * Reads a VerseSource's optional getTranslationId() capability (see
 * LocalizedVerseSource's doc comment) — an implementation that can return
 * meaningfully different results for the same reference depending on
 * live-mutable state (e.g. a display-mode toggle) must be able to change
 * resolveVerse()'s cache key accordingly, or a stale result from a
 * previous mode gets served back after the switch. A source with no such
 * state (FreeApiSource, GetBibleVerseSource on their own) simply has
 * nothing to report here, and resolveVerse() falls back to its own
 * DEFAULT_TRANSLATION.
 */
export function translationIdFor(source: VerseSource): string | undefined {
  const withId = source as VerseSource & { getTranslationId?: () => string }
  return withId.getTranslationId?.()
}

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
 * verse is displayed." The return type deliberately does NOT carry which
 * of those happened (AGENTS.md section 41: small interfaces, don't design
 * a richer result type nothing has asked for) — but ARCHITECTURE.md
 * section 40 still requires these to be "traceable through structured
 * logs", so the optional `logger` reports the two failure cases (circuit
 * open, source threw) at the one point that still has the distinction,
 * without forcing every caller to handle a richer return shape.
 */
export async function resolveVerse(
  reference: VerseReference,
  source: VerseSource,
  cache: VerseCache,
  circuitBreaker: CircuitBreaker,
  translation: string = DEFAULT_TRANSLATION,
  logger?: Logger
): Promise<Verse | null> {
  const cached = cache.getVerse(reference, translation)
  if (cached) return cached

  if (cache.isNegativelyCached(reference, translation)) {
    // ARCHITECTURE.md production audit (section 74): a hypothesis for an
    // intermittently-missing verse — the reference WAS detected and
    // logged upstream in processTranscript, but a prior transient
    // failure for this exact reference (a network hiccup against the
    // bilingual API, section 63) silently suppresses every repeat for up
    // to DEFAULT_NEGATIVE_TTL_MS (5 minutes), with no log at the point
    // that actually happens — indistinguishable, from the outside, from
    // the reference never having been detected at all. Logged at the
    // same level as the circuit-open case just below, which already
    // covers the sibling "resolution silently produced nothing" path.
    logger?.warn({
      component: "verse-resolver",
      event: "suppressed-negative-cache",
      metadata: { reference, translation, remainingMs: cache.negativeCacheRemainingMs(reference, translation) },
    })
    return null
  }

  if (!circuitBreaker.canProceed()) {
    logger?.warn({
      component: "verse-resolver",
      event: "circuit-open",
      metadata: { reference, translation },
    })
    return null
  }

  try {
    const verse = await source.getVerse(reference)
    circuitBreaker.recordSuccess()

    if (verse) {
      cache.setVerse(reference, translation, verse)
    } else {
      cache.setNotFound(reference, translation)
    }
    return verse
  } catch (err) {
    circuitBreaker.recordFailure()
    logger?.error({
      component: "verse-resolver",
      event: "source-failed",
      metadata: { reference, translation },
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
