export type VerseReference = {
  book: string
  chapter: number
  verse: number
}

export type Verse = {
  reference: VerseReference
  text: string
  translation: string
  source: string
  /**
   * Phase 2 (ARCHITECTURE.md section 63.3): present only in bilingual
   * display mode. Additive and backward-compatible — every existing
   * reader of text/translation/reference is unaffected. In bilingual
   * mode the top-level fields carry French (primary/prioritized) and
   * this carries English (secondary), per section 63.4's overlay layout.
   */
  secondary?: {
    text: string
    translation: string
    source: string
  }
}

/** Phase 2 (ARCHITECTURE.md section 63.2). */
export type DisplayMode = "english" | "french" | "bilingual"

/**
 * Phase 2 (ARCHITECTURE.md section 65.2) — "how did this verse get shown,"
 * a dashboard-only operator-context field, never sent to the overlay/
 * audience. The adapted equivalent of the researched "confidence badge"
 * idea: this app's detection is deterministic (regex + hallucination
 * guard), not fuzzy/semantic, so there is no graduated confidence to show
 * — every accepted detection is equally "exact" by construction. What
 * genuinely varies, and is useful operator context, is the trigger.
 */
export type VerseTrigger = "detected" | "override" | "navigation" | "rundown"

/** verse:show's actual wire payload — Verse's pure content plus the trigger. */
export type VerseShowPayload = Verse & {
  readonly trigger: VerseTrigger
}

/**
 * Phase 2 (ARCHITECTURE.md section 65.3) — confirmed explicitly: "auto"
 * stays the default, unchanged from pre-existing behavior. Only affects
 * DETECTED references — manual override, voice navigation, and rundown
 * scene activation are all already explicit operator-driven actions and
 * are never held for confirmation.
 */
export type VerseConfirmationMode = "auto" | "review"

/**
 * ARCHITECTURE.md section 82 — purely a presentation choice for the
 * overlay; carries no effect on detection, lookup, or caching. "fullscreen"
 * is the default (confirmed with the user: verse-only display should read
 * from across a room), "lower-third" is for when video/media is on screen
 * at the same time and a full-bleed verse would cover it.
 */
export type VerseLayout = "fullscreen" | "lower-third"

/** layout:set's payload (operator -> server) and layout:update's (server -> viewers) — same shape, different direction. */
export type VerseLayoutPayload = {
  readonly layout: VerseLayout
}

/** Extension seam — v1 ships one implementation (RegexDetector). See ARCHITECTURE.md §50. */
export interface VerseDetector {
  detect(text: string): VerseReference[]
}

/** Hallucination guard: answers "does this reference exist?", never holds verse text. */
export interface VerseIndex {
  exists(reference: VerseReference): boolean
}

/** Extension seam — v1 ships one implementation (FreeApiSource). See ARCHITECTURE.md §50. */
export interface VerseSource {
  getVerse(reference: VerseReference): Promise<Verse | null>
}

/**
 * Phase 2 (ARCHITECTURE.md section 61.2). Deliberately NOT part of
 * VerseDetector: resolving "next verse" requires the current position
 * (state), while VerseDetector.detect() is a pure function of text alone.
 */
export type NavigationCommand =
  | { readonly kind: "next-verse" }
  | { readonly kind: "previous-verse" }
  | { readonly kind: "next-chapter" }
  | { readonly kind: "previous-chapter" }
  | { readonly kind: "goto-chapter"; readonly book: string; readonly chapter: number }
  | { readonly kind: "cancel" }
  /**
   * Phase 2 (ARCHITECTURE.md section 65.1): "verse 16" said after "Romans
   * chapter 8" — reuses currentPosition's book AND chapter.
   */
  | { readonly kind: "goto-bare-verse"; readonly verse: number }
/**
 * Phase 2 (ARCHITECTURE.md section 65.1): "chapter 9, verse 3" — reuses
 * currentPosition's book only.
 */
  | { readonly kind: "goto-bare-chapter-verse"; readonly chapter: number; readonly verse: number }
  /**
   * TASK 1: explicit "<book> chapitre|chapter N[,] verset|verse M" — a full
   * reference spoken in prose form. Unlike goto-chapter (no verse) and the
   * bare patterns (depend on currentPosition), this carries all three
   * components and resolves independently. French and English word orders
   * both supported. Must run BEFORE bare patterns to avoid duplicate
   * commands (the bare patterns' lookbehinds will suppress their own
   * redundant matches when this one fires first).
   */
  | { readonly kind: "goto-book-chapter-verse"; readonly book: string; readonly chapter: number; readonly verse: number }
  /** Phase 2 (ARCHITECTURE.md section 65.4): a spoken display-mode switch. */
  | { readonly kind: "goto-display-mode"; readonly mode: DisplayMode }

export interface NavigationCommandDetector {
  detect(text: string): NavigationCommand[]
}

/**
 * Bible Browser (audit-notes/bible-browser.md): an OPTIONAL capability a
 * VerseSource may offer, same pattern as getTranslationId()/setMode(): read a
 * whole chapter in one request instead of N single-verse lookups. A source
 * without it is still usable (resolveChapter assembles the chapter verse by
 * verse). Returns the verses the source actually has, in verse order, or null
 * when the chapter is confirmed absent; a thrown error is a source failure.
 */
export interface ChapterCapableSource {
  getChapter(book: string, chapter: number): Promise<readonly Verse[] | null>
}

/** One verse of a browsed chapter (the Bible Browser's wire shape, bounded). */
export type BibleChapterVerse = {
  readonly verse: number
  readonly text: string
  /** Bilingual mode only: the secondary-language text of the same verse. */
  readonly secondary?: string
}

/** bible:chapter (operator -> server). `seq` lets the dashboard drop stale answers. */
export type BibleChapterRequestPayload = {
  readonly seq: number
  readonly book: string
  readonly chapter: number
}

/** bible:chapter-result (server -> operators only). verses is null with a reason when there is nothing to show. */
export type BibleChapterResultPayload = {
  readonly seq: number
  readonly book: string
  readonly chapter: number
  readonly verses: readonly BibleChapterVerse[] | null
  readonly translation?: string
  readonly secondaryTranslation?: string
  readonly source?: string
  readonly reason?: "not-found" | "unavailable"
  /** Verse numbers of the chapter the source did not provide (a gappy or differently versified source): the reader says so. */
  readonly missing?: readonly number[]
}

/** bible:search (operator -> server). */
export type BibleSearchRequestPayload = {
  readonly seq: number
  readonly query: string
}

export type BibleSearchHit = {
  readonly reference: VerseReference
  readonly text: string
  readonly translation: string
  readonly score: number
}

/**
 * bible:search-result (server -> operators only). `coverage` says honestly what was searched:
 * the bundled French text (always, once indexed) and how many chapters of other text were
 * already loaded this session (the only English text there is).
 */
export type BibleSearchResultPayload = {
  readonly seq: number
  readonly query: string
  readonly hits: readonly BibleSearchHit[]
  readonly total: number
  readonly coverage: {
    readonly french: "offline" | "indexing" | "unavailable"
    readonly loadedChapters: number
  }
  readonly reason?: "too-short"
}

export type VerseNavigateDirection = "next-verse" | "previous-verse" | "next-chapter" | "previous-chapter"

/** verse:navigate (operator -> server): step from the SERVER's current position (section 61.4). */
export type VerseNavigatePayload = {
  readonly direction: VerseNavigateDirection
}

/**
 * verse:navigate-result (server -> operators only): sent ONLY when a verse:navigate did not put a
 * verse on screen, so "Next verse" never silently does nothing.
 */
export type VerseNavigateResultPayload = {
  readonly direction: VerseNavigateDirection
  readonly reason: "no-position" | "boundary" | "unavailable"
}
