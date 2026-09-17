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
  /** Phase 2 (ARCHITECTURE.md section 65.4): a spoken display-mode switch. */
  | { readonly kind: "goto-display-mode"; readonly mode: DisplayMode }

export interface NavigationCommandDetector {
  detect(text: string): NavigationCommand[]
}
