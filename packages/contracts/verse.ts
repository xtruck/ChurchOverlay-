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
