import type { VerseReference, VerseSource } from "../../../packages/contracts/verse"

export type CrossReferenceEntry = {
  readonly reference: VerseReference
  readonly theme: string
  readonly relevanceScore: number // 1 to 10
}

/**
 * Curated biblical cross-reference network for foundational theological scriptures.
 * Keyed by canonical canonical reference "book:chapter:verse".
 */
export const THEMATIC_CROSS_REFERENCES: Record<string, CrossReferenceEntry[]> = {
  // John 3:16 - God's Love and Salvation
  "john:3:16": [
    { reference: { book: "romans", chapter: 5, verse: 8 }, theme: "God's Love for Sinners", relevanceScore: 10 },
    { reference: { book: "1 john", chapter: 4, verse: 9 }, theme: "Manifestation of Love", relevanceScore: 10 },
    { reference: { book: "ephesians", chapter: 2, verse: 8 }, theme: "Saved by Grace through Faith", relevanceScore: 9 },
    { reference: { book: "titus", chapter: 3, verse: 5 }, theme: "Regeneration by Mercy", relevanceScore: 8 },
  ],
  // Psalm 23:1 - The Lord is My Shepherd
  "psalm:23:1": [
    { reference: { book: "john", chapter: 10, verse: 11 }, theme: "The Good Shepherd", relevanceScore: 10 },
    { reference: { book: "isaiah", chapter: 40, verse: 11 }, theme: "Tending the Flock", relevanceScore: 9 },
    { reference: { book: "philippians", chapter: 4, verse: 19 }, theme: "God Supplies All Needs", relevanceScore: 9 },
    { reference: { book: "ezekiel", chapter: 34, verse: 11 }, theme: "Searching for the Sheep", relevanceScore: 8 },
  ],
  // Romans 8:28 - God's Sovereign Purpose
  "romans:8:28": [
    { reference: { book: "jeremiah", chapter: 29, verse: 11 }, theme: "Plans for Peace and Hope", relevanceScore: 10 },
    { reference: { book: "genesis", chapter: 50, verse: 20 }, theme: "God Meant it for Good", relevanceScore: 9 },
    { reference: { book: "philippians", chapter: 1, verse: 6 }, theme: "Completing the Good Work", relevanceScore: 9 },
    { reference: { book: "proverbs", chapter: 3, verse: 5 }, theme: "Trusting the Lord", relevanceScore: 8 },
  ],
  // Philippians 4:13 - Strength in Christ
  "philippians:4:13": [
    { reference: { book: "isaiah", chapter: 40, verse: 29 }, theme: "Power to the Faint", relevanceScore: 9 },
    { reference: { book: "2 corinthians", chapter: 12, verse: 9 }, theme: "Grace is Sufficient", relevanceScore: 10 },
    { reference: { book: "ephesians", chapter: 6, verse: 10 }, theme: "Strong in the Lord", relevanceScore: 8 },
  ],
  // Matthew 28:19 - The Great Commission
  "matthew:28:19": [
    { reference: { book: "acts", chapter: 1, verse: 8 }, theme: "Witnesses to the End of the Earth", relevanceScore: 10 },
    { reference: { book: "mark", chapter: 16, verse: 15 }, theme: "Preach the Gospel", relevanceScore: 9 },
    { reference: { book: "2 timothy", chapter: 4, verse: 2 }, theme: "Preach the Word", relevanceScore: 8 },
  ],
  // 1 Corinthians 13:4 - Love
  "1 corinthians:13:4": [
    { reference: { book: "colossians", chapter: 3, verse: 14 }, theme: "Bond of Perfection", relevanceScore: 9 },
    { reference: { book: "1 peter", chapter: 4, verse: 8 }, theme: "Love Covers Sins", relevanceScore: 9 },
    { reference: { book: "1 john", chapter: 4, verse: 7 }, theme: "Love is of God", relevanceScore: 10 },
  ],
  // Hebrews 11:1 - Faith
  "hebrews:11:1": [
    { reference: { book: "romans", chapter: 10, verse: 17 }, theme: "Faith Comes by Hearing", relevanceScore: 10 },
    { reference: { book: "2 corinthians", chapter: 5, verse: 7 }, theme: "Walk by Faith", relevanceScore: 9 },
    { reference: { book: "james", chapter: 2, verse: 17 }, theme: "Faith and Works", relevanceScore: 8 },
  ],
}

/**
 * Standardizes a VerseReference into a canonical lookup key.
 */
export function canonicalReferenceKey(ref: VerseReference): string {
  return `${ref.book.trim().toLowerCase()}:${ref.chapter}:${ref.verse}`
}

/**
 * Retrieves the thematic and theological cross-references for a given Bible verse.
 */
export function getCrossReferences(ref: VerseReference): CrossReferenceEntry[] {
  const key = canonicalReferenceKey(ref)
  return THEMATIC_CROSS_REFERENCES[key] ?? []
}

/**
 * Predictively pre-fetches and warms up the verse cache for likely next scriptures.
 * Returns the count of successfully pre-fetched passages.
 */
export async function prefetchCrossReferences(
  ref: VerseReference,
  source: VerseSource
): Promise<number> {
  const crossRefs = getCrossReferences(ref)
  if (crossRefs.length === 0) return 0

  const fetchPromises = crossRefs.map(async (entry) => {
    try {
      const verse = await source.getVerse(entry.reference)
      return verse !== null ? 1 : 0
    } catch {
      return 0
    }
  })

  const results = await Promise.all(fetchPromises)
  return results.reduce<number>((sum, val) => sum + val, 0)
}
