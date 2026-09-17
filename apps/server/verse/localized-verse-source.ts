import type { DisplayMode, Verse, VerseReference, VerseSource } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"

/**
 * ARCHITECTURE.md section 63.2: wraps an English and a French VerseSource
 * behind the unchanged VerseSource interface — no change to VerseSource
 * itself, resolveVerse(), resolveTranscriptVerses(), or AppCore's `source`
 * dependency. Matches section 57's "a new verse source can be added
 * without modifying the detector" success criterion, extended to
 * "without modifying anything downstream of it either."
 *
 * setMode()/getMode() are additions beyond VerseSource, the same
 * documented pattern GroqProvider.onError already uses for AsrProvider —
 * an optional capability a specific implementation offers, never a change
 * to the shared interface every implementation must satisfy.
 */
export class LocalizedVerseSource implements VerseSource {
  private mode: DisplayMode

  constructor(
    private readonly english: VerseSource,
    private readonly french: VerseSource,
    initialMode: DisplayMode,
    private readonly logger?: Logger
  ) {
    this.mode = initialMode
  }

  setMode(mode: DisplayMode): void {
    this.mode = mode
  }

  getMode(): DisplayMode {
    return this.mode
  }

  /**
   * An optional capability, same pattern as setMode/getMode above (and
   * GroqProvider.onError for AsrProvider) — resolveVerse()'s callers use
   * this (see translationIdFor() in resolve-verse.ts) to key the verse
   * cache by *mode*, not just a hardcoded default. Without this, a verse
   * cached while showing English would be served right back after a live
   * switch to French or bilingual, since the cache key would never change
   * (ARCHITECTURE.md section 16's "include translation identity in the
   * cache key" — the mode IS the translation identity here, since it's
   * what actually determines the shape/language of the returned Verse).
   */
  getTranslationId(): string {
    return this.mode
  }

  async getVerse(reference: VerseReference): Promise<Verse | null> {
    if (this.mode === "english") return this.english.getVerse(reference)
    if (this.mode === "french") return this.french.getVerse(reference)

    // Promise.allSettled, not Promise.all: a real thrown failure in just
    // ONE language must not sink the whole bilingual lookup when the
    // other language is perfectly healthy — a per-language "not found"
    // already degrades gracefully (see below), and a per-language service
    // outage deserves the same treatment for the SECONDARY language,
    // rather than surfacing nothing at all over a transient failure in
    // the language nobody asked to see on its own.
    const [frResult, enResult] = await Promise.allSettled([
      this.french.getVerse(reference),
      this.english.getVerse(reference),
    ])

    // French is primary/prioritized (section 63.3) — its failure is NOT
    // degraded the same way: re-throwing lets resolveVerse()'s own
    // try/catch treat this as the genuine source failure it is (circuit
    // breaker failure, left uncached), rather than this class silently
    // absorbing it and getting miscategorized as a confirmed "not found".
    if (frResult.status === "rejected") throw frResult.reason

    const fr = frResult.value
    if (!fr) return null

    if (enResult.status === "rejected") {
      this.logger?.warn({
        component: "localized-verse-source",
        event: "secondary-language-failed",
        metadata: { reference },
        error: enResult.reason instanceof Error ? enResult.reason.message : String(enResult.reason),
      })
      return fr
    }

    const en = enResult.value
    if (!en) return fr

    return {
      ...fr,
      secondary: { text: en.text, translation: en.translation, source: en.source },
    }
  }
}
