import type { Verse, VerseReference } from "../../../packages/contracts"
import { LruTtlCache } from "./lru-ttl-cache"

const DEFAULT_MAX_POSITIVE_ENTRIES = 500
const DEFAULT_MAX_NEGATIVE_ENTRIES = 200
// Verse text is static, so a long TTL is reasonable — but AGENTS.md
// section 36 still requires every cache to be bounded, so this is a
// generous default, not an infinite one.
const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000
// Deliberately much shorter than the positive TTL (ARCHITECTURE.md
// section 20): a transient API hiccup must not permanently blacklist a
// reference that would actually resolve on retry.
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60 * 1000

export type VerseCacheOptions = {
  readonly maxPositiveEntries?: number
  readonly maxNegativeEntries?: number
  readonly positiveTtlMs?: number
  readonly negativeTtlMs?: number
  readonly now?: () => number
}

/**
 * Builds the cache key exactly as specified in ARCHITECTURE.md section 19:
 * "normalized book + chapter + verse + translation", e.g. "john:3:16:default".
 */
export function buildVerseCacheKey(reference: VerseReference, translation: string): string {
  const book = reference.book.trim().replace(/\s+/g, " ").toLowerCase()
  const normalizedTranslation = translation.trim().toLowerCase()
  return `${book}:${reference.chapter}:${reference.verse}:${normalizedTranslation}`
}

/**
 * ARCHITECTURE.md section 19 (LRU cache) + section 20 (negative cache).
 * Two independently bounded caches: successful lookups (long TTL, since
 * verse text does not change) and recent failures (short TTL, per
 * AGENTS.md section 16), so repeated invalid detections stop hammering
 * the Bible API without permanently poisoning a reference that later
 * succeeds. A result in one cache is never left stale in the other: a
 * fresh positive result clears any prior negative entry for the same
 * key, and vice versa.
 *
 * This cache holds only `Verse` values — the shape already validated
 * against an external API response by whatever calls setVerse(). It does
 * not itself talk to a Bible API (that is VerseSource's job, not yet
 * implemented — see ARCHITECTURE.md section 16).
 */
export class VerseCache {
  private readonly positive: LruTtlCache<Verse>
  private readonly negative: LruTtlCache<true>
  private readonly positiveTtlMs: number
  private readonly negativeTtlMs: number

  constructor(options: VerseCacheOptions = {}) {
    const now = options.now ?? Date.now
    this.positive = new LruTtlCache<Verse>(
      options.maxPositiveEntries ?? DEFAULT_MAX_POSITIVE_ENTRIES,
      now
    )
    this.negative = new LruTtlCache<true>(
      options.maxNegativeEntries ?? DEFAULT_MAX_NEGATIVE_ENTRIES,
      now
    )
    this.positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
  }

  getVerse(reference: VerseReference, translation: string): Verse | undefined {
    return this.positive.get(buildVerseCacheKey(reference, translation))
  }

  setVerse(reference: VerseReference, translation: string, verse: Verse): void {
    const key = buildVerseCacheKey(reference, translation)
    this.positive.set(key, verse, this.positiveTtlMs)
    this.negative.delete(key)
  }

  isNegativelyCached(reference: VerseReference, translation: string): boolean {
    return this.negative.get(buildVerseCacheKey(reference, translation)) === true
  }

  setNotFound(reference: VerseReference, translation: string): void {
    const key = buildVerseCacheKey(reference, translation)
    this.negative.set(key, true, this.negativeTtlMs)
    this.positive.delete(key)
  }
}
