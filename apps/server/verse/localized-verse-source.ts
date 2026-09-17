import type { DisplayMode, Verse, VerseReference, VerseSource } from "../../../packages/contracts"

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
    initialMode: DisplayMode
  ) {
    this.mode = initialMode
  }

  setMode(mode: DisplayMode): void {
    this.mode = mode
  }

  getMode(): DisplayMode {
    return this.mode
  }

  async getVerse(reference: VerseReference): Promise<Verse | null> {
    if (this.mode === "english") return this.english.getVerse(reference)
    if (this.mode === "french") return this.french.getVerse(reference)

    const [fr, en] = await Promise.all([
      this.french.getVerse(reference),
      this.english.getVerse(reference),
    ])
    // French is primary/prioritized in bilingual mode (section 63.3) — if
    // it's not found, there is nothing to show, even if English resolved.
    if (!fr) return null
    if (!en) return fr

    return {
      ...fr,
      secondary: { text: en.text, translation: en.translation, source: en.source },
    }
  }
}
