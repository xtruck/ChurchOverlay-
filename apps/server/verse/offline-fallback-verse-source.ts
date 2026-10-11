import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { CircuitBreaker } from "./circuit-breaker"

export type OfflineFallbackVerseSourceOptions = {
  readonly primary: VerseSource
  readonly offline: VerseSource
  readonly logger?: Logger
  readonly circuitBreaker?: CircuitBreaker
}

/**
 * ARCHITECTURE.md section 77: wraps a live VerseSource with a bundled,
 * always-available offline fallback (OfflineVerseSource) — a live-API
 * outage (the venue's own internet, or the API itself) no longer means
 * "no verse resolves at all" for the language this wraps.
 *
 * Deliberately NOT just "try primary, catch, try offline" on every call:
 * this class holds its OWN CircuitBreaker, separate from resolveVerse()'s
 * own outer one (verse-cache.ts / resolve-verse.ts). Once wrapped like
 * this, this source practically never throws upward (a primary failure
 * always resolves via offline instead), which would otherwise silently
 * defeat the outer circuit breaker's actual purpose — it would see only
 * successes and keep letting every single detection re-attempt a known-
 * down live API. This inner breaker keeps that protection where it
 * belongs: skip straight to offline while the live API is confirmed
 * down, and only probe it again on the breaker's own cooldown, exactly
 * like any other circuit-breaker-guarded source in this codebase.
 *
 * Composed with the existing VerseSource interface only (LocalizedVerseSource
 * never calls anything beyond getVerse() on its wrapped english/french
 * sources) — nothing downstream needed to change to use this.
 */
export class OfflineFallbackVerseSource implements VerseSource {
  private readonly primary: VerseSource
  private readonly offline: VerseSource
  private readonly logger?: Logger
  private readonly circuitBreaker: CircuitBreaker
  /** True once the "serving from offline while the breaker is open" state has been logged, so a long outage logs once, not per lookup. */
  private openStateLogged = false

  constructor(options: OfflineFallbackVerseSourceOptions) {
    this.primary = options.primary
    this.offline = options.offline
    this.logger = options.logger
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker()
  }

  async getVerse(reference: VerseReference): Promise<Verse | null> {
    if (!this.circuitBreaker.canProceed()) {
      // Section 46: the operator must be able to tell which source produced the text.
      if (!this.openStateLogged) {
        this.openStateLogged = true
        this.logger?.warn({
          component: "offline-fallback-verse-source",
          event: "breaker-open-serving-offline",
          metadata: { reference },
        })
      }
      return this.offline.getVerse(reference)
    }

    try {
      const verse = await this.primary.getVerse(reference)
      this.circuitBreaker.recordSuccess()
      this.openStateLogged = false
      return verse
    } catch (err) {
      this.circuitBreaker.recordFailure()
      this.logger?.warn({
        component: "offline-fallback-verse-source",
        event: "primary-failed-using-offline",
        metadata: { reference },
        error: err instanceof Error ? err.message : String(err),
      })
      const fallback = await this.offline.getVerse(reference)
      // The live source failed, so a null from offline is "unknown", not "not found".
      // Rethrow so the outer breaker and negative cache never record a false miss.
      if (fallback === null) throw err
      return fallback
    }
  }
}
