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
  private french: VerseSource

  constructor(
    private readonly english: VerseSource,
    french: VerseSource,
    initialMode: DisplayMode,
    private readonly logger?: Logger,
    // ARCHITECTURE.md section 107: which actual French translation `french`
    // currently is (e.g. "ls1910", "darby") — a label the caller supplies
    // alongside the source itself, since VerseSource has no way to ask a
    // source what it is. Defaults to "ls1910" so every existing call site
    // (this class predates French translation choice existing at all)
    // keeps its previous getTranslationId() behavior unless it opts in.
    private frenchTranslationId: string = "ls1910"
  ) {
    this.mode = initialMode
    this.french = french
  }

  setMode(mode: DisplayMode): void {
    this.mode = mode
  }

  getMode(): DisplayMode {
    return this.mode
  }

  /**
   * ARCHITECTURE.md section 107: lets a live French-translation switch
   * (the dashboard's own toggle, via a new set-french-translation IPC
   * handler) swap which underlying VerseSource French/bilingual lookups
   * use, without tearing down and reconstructing AppCore the way
   * allowPhoneRemote's own switch must (that one's forced by the WS
   * server's listen host being fixed at construction; this class's
   * `french` field has no such constraint). `translationId` must be
   * supplied alongside the new source itself — see getTranslationId()
   * below for why silently reusing the previous label would be a real
   * cache-correctness bug, not a cosmetic one.
   */
  setFrenchSource(source: VerseSource, translationId: string): void {
    this.french = source
    this.frenchTranslationId = translationId
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
   *
   * CORRECTIF (ARCHITECTURE.md section 107): mode alone stopped being a
   * complete translation identity once a mode could map to more than one
   * underlying French VerseSource (ls1910 vs darby) — two different
   * French texts for the same reference would otherwise share one cache
   * key ("french"), so a switch from ls1910 to darby would silently serve
   * back the stale ls1910 text already cached under that key. English has
   * only ever had one translation (kjv), so its own branch is unaffected.
   */
  getTranslationId(): string {
    if (this.mode === "english") return "english"
    if (this.mode === "french") return `french:${this.frenchTranslationId}`
    return `bilingual:${this.frenchTranslationId}`
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
