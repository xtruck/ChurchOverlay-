import type { ChapterCapableSource, Verse, VerseSource } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { ChapterCache } from "./chapter-cache"
import { CircuitBreaker } from "./circuit-breaker"
import { resolveVerse } from "./resolve-verse"
import { VerseCache } from "./verse-cache"

export type ChapterResolution =
  | { readonly kind: "ok"; readonly verses: readonly Verse[]; readonly missing: readonly number[] }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" }

/**
 * Bible Browser (audit-notes/bible-browser.md): the chapter twin of resolveVerse(), the
 * sanctioned way to read a whole chapter. Same rules (ARCHITECTURE.md sections 16-21):
 *  - chapter cache first, then its negative side (confirmed-absent only);
 *  - the shared circuit breaker is consulted before any request and told the real outcome;
 *  - a thrown error is a source failure (never cached), a resolved null is "confirmed absent";
 *  - the answer is validated, not trusted: every verse must belong to the requested book and
 *    chapter, have a number >= 1 and text; numbers past the catalog's verse count for that
 *    chapter are dropped (they could never pass the index, so they could never be sent).
 *    A malformed answer is a failure, never shown;
 *  - a successful read warms the verse cache, so sending one of these verses to the overlay
 *    afterwards is instant and identical to what resolveVerse() would have returned.
 *
 * The caller must already have validated {book, chapter} with the KnownValidVerseIndex and
 * pass that chapter's verse count; this function never decides what exists.
 *
 * A source without getChapter() (a test double, a future provider) is read verse by verse
 * through resolveVerse(); a chapter assembled that way with gaps is returned but not cached.
 */
export async function resolveChapter(
  book: string,
  chapter: number,
  verseCount: number,
  source: VerseSource,
  chapterCache: ChapterCache,
  verseCache: VerseCache,
  circuitBreaker: CircuitBreaker,
  translation: string,
  logger?: Logger
): Promise<ChapterResolution> {
  const cached = chapterCache.get(book, chapter, translation)
  if (cached) return okResult(cached, verseCount)
  if (chapterCache.isNegativelyCached(book, chapter, translation)) return { kind: "not-found" }

  const capable = source as Partial<ChapterCapableSource>
  if (typeof capable.getChapter !== "function") {
    return resolveChapterVerseByVerse(book, chapter, verseCount, source, chapterCache, verseCache, circuitBreaker, translation, logger)
  }

  if (!circuitBreaker.canProceed()) {
    logger?.warn({ component: "chapter-resolver", event: "circuit-open", metadata: { book, chapter, translation } })
    return { kind: "unavailable" }
  }

  let raw: readonly Verse[] | null
  try {
    raw = await capable.getChapter(book, chapter)
  } catch (err) {
    // A genuine source or network failure: the only thing allowed to count against the shared breaker.
    circuitBreaker.recordFailure()
    logger?.error({
      component: "chapter-resolver",
      event: "source-failed",
      metadata: { book, chapter, translation },
      error: err instanceof Error ? err.message : String(err),
    })
    return { kind: "unavailable" }
  }
  // The source answered, so for the breaker this is a healthy exchange. Whether the answer is
  // usable is judged below and must never trip the breaker live verse display shares.
  circuitBreaker.recordSuccess()

  let verses: Verse[] | null
  try {
    verses = raw === null ? null : validateChapter(raw, book, chapter, verseCount)
  } catch (err) {
    logger?.error({
      component: "chapter-resolver",
      event: "invalid-chapter-answer",
      metadata: { book, chapter, translation },
      error: err instanceof Error ? err.message : String(err),
    })
    return { kind: "unavailable" }
  }
  if (verses === null) {
    chapterCache.setNotFound(book, chapter, translation)
    return { kind: "not-found" }
  }
  chapterCache.set(book, chapter, translation, verses)
  for (const verse of verses) verseCache.setVerse(verse.reference, translation, verse)
  return okResult(verses, verseCount)
}

/** Verse numbers of 1..verseCount the answer does not contain (versification differences, a gappy source). */
function okResult(verses: readonly Verse[], verseCount: number): ChapterResolution {
  const have = new Set(verses.map((verse) => verse.reference.verse))
  const missing: number[] = []
  for (let number = 1; number <= verseCount; number++) if (!have.has(number)) missing.push(number)
  return { kind: "ok", verses, missing }
}

const MAX_VERSE_TEXT_CHARS = 4000

/** Throws on anything a trustworthy source would not send. Returns the verses sorted, de-duplicated. */
function validateChapter(raw: readonly Verse[], book: string, chapter: number, verseCount: number): Verse[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("source returned an empty chapter")
  const byNumber = new Map<number, Verse>()
  for (const verse of raw) {
    const ref = verse?.reference
    if (
      !ref ||
      ref.book !== book ||
      ref.chapter !== chapter ||
      !Number.isInteger(ref.verse) ||
      ref.verse < 1 ||
      typeof verse.text !== "string" ||
      verse.text.trim().length === 0 ||
      verse.text.length > MAX_VERSE_TEXT_CHARS
    ) {
      throw new Error("source returned a chapter containing a verse that does not belong or has no text")
    }
    // A verse number past the catalog's count (translations versify differently) could never
    // pass the KnownValidVerseIndex, so it is not offered: browsing never shows what cannot be sent.
    if (ref.verse <= verseCount && !byNumber.has(ref.verse)) byNumber.set(ref.verse, verse)
  }
  if (byNumber.size === 0) throw new Error("source returned no verse inside the known verse range")
  return [...byNumber.values()].sort((a, b) => a.reference.verse - b.reference.verse)
}

async function resolveChapterVerseByVerse(
  book: string,
  chapter: number,
  verseCount: number,
  source: VerseSource,
  chapterCache: ChapterCache,
  verseCache: VerseCache,
  circuitBreaker: CircuitBreaker,
  translation: string,
  logger?: Logger
): Promise<ChapterResolution> {
  const verses: Verse[] = []
  for (let number = 1; number <= verseCount; number++) {
    const verse = await resolveVerse({ book, chapter, verse: number }, source, verseCache, circuitBreaker, translation, logger)
    if (verse) verses.push(verse)
  }
  if (verses.length === 0) return { kind: "unavailable" }
  if (verses.length === verseCount) chapterCache.set(book, chapter, translation, verses)
  return okResult(verses, verseCount)
}
