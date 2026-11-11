import type { Verse } from "../../../packages/contracts"
import { LruTtlCache } from "./lru-ttl-cache"

const DEFAULT_MAX_CHAPTERS = 40
// Same reasoning as VerseCache: verse text is static, but every cache is bounded (AGENTS.md section 16).
const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000
// A confirmed "no such chapter" is remembered briefly, like VerseCache's negative side (section 20).
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_NEGATIVE_ENTRIES = 50

export type ChapterCacheOptions = {
  readonly maxChapters?: number
  readonly positiveTtlMs?: number
  readonly negativeTtlMs?: number
  readonly now?: () => number
}

/** Normalized key: translation identity included even though a deployment may only ever use one. */
export function buildChapterCacheKey(book: string, chapter: number, translation: string): string {
  return `${book.trim().replace(/\s+/g, " ").toLowerCase()}:${chapter}:${translation.trim().toLowerCase()}`
}

/**
 * Bible Browser (audit-notes/bible-browser.md): whole-chapter counterpart of VerseCache.
 * Bounded LRU with a TTL on both sides: chapters that were read (positive) and chapters the
 * source CONFIRMED absent (negative, shorter life). A failed lookup is never cached either way,
 * so a transient outage cannot hide a chapter. Also what the English word search reads from
 * (the only English text that exists offline is whatever the operator already opened).
 */
export class ChapterCache {
  private readonly positive: LruTtlCache<readonly Verse[]>
  private readonly negative: LruTtlCache<true>
  private readonly positiveTtlMs: number
  private readonly negativeTtlMs: number

  constructor(options: ChapterCacheOptions = {}) {
    const now = options.now ?? Date.now
    this.positive = new LruTtlCache<readonly Verse[]>(options.maxChapters ?? DEFAULT_MAX_CHAPTERS, now)
    this.negative = new LruTtlCache<true>(DEFAULT_MAX_NEGATIVE_ENTRIES, now)
    this.positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
  }

  get(book: string, chapter: number, translation: string): readonly Verse[] | undefined {
    return this.positive.get(buildChapterCacheKey(book, chapter, translation))
  }

  set(book: string, chapter: number, translation: string, verses: readonly Verse[]): void {
    const key = buildChapterCacheKey(book, chapter, translation)
    this.positive.set(key, verses, this.positiveTtlMs)
    this.negative.delete(key)
  }

  isNegativelyCached(book: string, chapter: number, translation: string): boolean {
    return this.negative.get(buildChapterCacheKey(book, chapter, translation)) === true
  }

  setNotFound(book: string, chapter: number, translation: string): void {
    const key = buildChapterCacheKey(book, chapter, translation)
    this.negative.set(key, true, this.negativeTtlMs)
    this.positive.delete(key)
  }

  /** Every chapter currently loaded (any translation), for the word search. Read-only. */
  loadedChapters(): ReadonlyArray<readonly Verse[]> {
    return this.positive.values()
  }
}
