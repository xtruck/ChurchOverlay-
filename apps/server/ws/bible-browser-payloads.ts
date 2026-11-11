import type {
  BibleChapterRequestPayload,
  BibleChapterResultPayload,
  BibleSearchRequestPayload,
  BibleSearchResultPayload,
  VerseNavigatePayload,
  VerseNavigateResultPayload,
} from "../../../packages/contracts"
import { isPlainObject } from "../../../packages/shared/type-guards"
import { MAX_QUERY_LENGTH, MAX_SEARCH_RESULTS } from "../verse/bible-word-search"

/**
 * Payload validators for the Bible Browser commands and events (audit-notes/bible-browser.md,
 * ARCHITECTURE.md sections 27 and 30). Shape only, with explicit bounds on every string and list
 * so neither a client nor a server bug can push an unbounded message through the registry.
 * Kept out of action-registry.ts to leave that shared file with a handful of one-line entries.
 */

export const MAX_BOOK_ID_LENGTH = 40
export const MAX_CHAPTER_NUMBER = 150
export const MAX_CHAPTER_VERSES = 200
export const MAX_VERSE_TEXT_LENGTH = 4000
const MAX_LABEL_LENGTH = 40

const NAVIGATE_DIRECTIONS = new Set(["next-verse", "previous-verse", "next-chapter", "previous-chapter"])

function hasOnlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(payload).every((key) => allowed.includes(key))
}

function isSeq(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isInt(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function isBoundedString(value: unknown, max: number, minLength = 0): boolean {
  return typeof value === "string" && value.length >= minLength && value.length <= max
}

function isOptionalLabel(value: unknown): boolean {
  return value === undefined || isBoundedString(value, MAX_LABEL_LENGTH, 1)
}

function isReference(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isBoundedString(value.book, MAX_BOOK_ID_LENGTH, 1) &&
    isInt(value.chapter, 1, MAX_CHAPTER_NUMBER) &&
    isInt(value.verse, 1, MAX_CHAPTER_VERSES)
  )
}

/** bible:chapter */
export function isBibleChapterRequestPayload(payload: unknown): payload is BibleChapterRequestPayload {
  return (
    isPlainObject(payload) &&
    hasOnlyKeys(payload, ["seq", "book", "chapter"]) &&
    isSeq(payload.seq) &&
    isBoundedString(payload.book, MAX_BOOK_ID_LENGTH, 1) &&
    isInt(payload.chapter, 1, MAX_CHAPTER_NUMBER)
  )
}

/** bible:chapter-result */
export function isBibleChapterResultPayload(payload: unknown): payload is BibleChapterResultPayload {
  if (!isPlainObject(payload)) return false
  if (
    !isSeq(payload.seq) ||
    !isBoundedString(payload.book, MAX_BOOK_ID_LENGTH, 1) ||
    !isInt(payload.chapter, 1, MAX_CHAPTER_NUMBER) ||
    !isOptionalLabel(payload.translation) ||
    !isOptionalLabel(payload.secondaryTranslation) ||
    !isOptionalLabel(payload.source) ||
    !(payload.reason === undefined || payload.reason === "not-found" || payload.reason === "unavailable")
  ) {
    return false
  }
  const missing = payload.missing
  if (
    !(
      missing === undefined ||
      (Array.isArray(missing) && missing.length <= MAX_CHAPTER_VERSES && missing.every((n: unknown) => isInt(n, 1, MAX_CHAPTER_VERSES)))
    )
  ) {
    return false
  }
  if (payload.verses === null) return payload.reason !== undefined
  if (!Array.isArray(payload.verses) || payload.verses.length === 0 || payload.verses.length > MAX_CHAPTER_VERSES) return false
  return payload.verses.every(
    (entry: unknown) =>
      isPlainObject(entry) &&
      isInt(entry.verse, 1, MAX_CHAPTER_VERSES) &&
      isBoundedString(entry.text, MAX_VERSE_TEXT_LENGTH, 1) &&
      (entry.secondary === undefined || isBoundedString(entry.secondary, MAX_VERSE_TEXT_LENGTH, 1))
  )
}

/** bible:search */
export function isBibleSearchRequestPayload(payload: unknown): payload is BibleSearchRequestPayload {
  return (
    isPlainObject(payload) &&
    hasOnlyKeys(payload, ["seq", "query"]) &&
    isSeq(payload.seq) &&
    isBoundedString(payload.query, MAX_QUERY_LENGTH)
  )
}

/** bible:search-result */
export function isBibleSearchResultPayload(payload: unknown): payload is BibleSearchResultPayload {
  if (!isPlainObject(payload)) return false
  if (
    !isSeq(payload.seq) ||
    !isBoundedString(payload.query, MAX_QUERY_LENGTH) ||
    !isInt(payload.total, 0, 1_000_000) ||
    !(payload.reason === undefined || payload.reason === "too-short")
  ) {
    return false
  }
  const coverage = payload.coverage
  if (
    !isPlainObject(coverage) ||
    !(coverage.french === "offline" || coverage.french === "indexing" || coverage.french === "unavailable") ||
    !isInt(coverage.loadedChapters, 0, 10_000)
  ) {
    return false
  }
  return (
    Array.isArray(payload.hits) &&
    payload.hits.length <= MAX_SEARCH_RESULTS &&
    payload.hits.every(
      (hit: unknown) =>
        isPlainObject(hit) &&
        isReference(hit.reference) &&
        isBoundedString(hit.text, MAX_VERSE_TEXT_LENGTH, 1) &&
        isBoundedString(hit.translation, MAX_LABEL_LENGTH, 1) &&
        typeof hit.score === "number" &&
        Number.isFinite(hit.score) &&
        hit.score >= 0 &&
        hit.score <= 2
    )
  )
}

/** verse:navigate */
export function isVerseNavigatePayload(payload: unknown): payload is VerseNavigatePayload {
  return (
    isPlainObject(payload) &&
    hasOnlyKeys(payload, ["direction"]) &&
    typeof payload.direction === "string" &&
    NAVIGATE_DIRECTIONS.has(payload.direction)
  )
}

/** verse:navigate-result */
export function isVerseNavigateResultPayload(payload: unknown): payload is VerseNavigateResultPayload {
  return (
    isPlainObject(payload) &&
    hasOnlyKeys(payload, ["direction", "reason"]) &&
    typeof payload.direction === "string" &&
    NAVIGATE_DIRECTIONS.has(payload.direction) &&
    (payload.reason === "no-position" || payload.reason === "boundary" || payload.reason === "unavailable")
  )
}
