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

export interface NavigationCommandDetector {
  detect(text: string): NavigationCommand[]
}
