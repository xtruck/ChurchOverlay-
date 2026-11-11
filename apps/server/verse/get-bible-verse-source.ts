import type { ChapterCapableSource, Verse, VerseReference, VerseSource } from "../../../packages/contracts"
import { BOOK_CATALOG } from "./book-catalog"
import { isPlainObject } from "../../../packages/shared/type-guards"

/**
 * French VerseSource (ARCHITECTURE.md section 63.1, section 50 third
 * extension seam — a second implementation, sibling to FreeApiSource).
 * Fetches Louis Segond (1910) — the standard French Protestant
 * translation — from api.getbible.net, a real, free, no-API-key service
 * verified directly against the live endpoint before writing this class
 * (not assumed): `GET /v2/ls1910/{book_nr}/{chapter}.json` returns a
 * whole chapter, `{ ..., verses: [{ chapter, verse, name, text }, ...] }`.
 *
 * `book_nr` uses standard canonical numbering (Genesis=1 .. Revelation=66)
 * — verified directly against BOOK_CATALOG's own array order (not
 * assumed): John is book_nr 43 there and index 42 in BOOK_CATALOG, an
 * exact match, so book_nr is simply BOOK_CATALOG's index + 1.
 *
 * Same null-vs-throw contract as FreeApiSource: a book/chapter genuinely
 * absent from this API (HTTP 404) or a verse number genuinely absent from
 * the chapter's own verses array both resolve `null` (confirmed not
 * found, not a failure) — a network error, non-2xx status, or malformed
 * body throws (a real failure for the circuit breaker to see).
 *
 * A real, non-obvious case this deliberately treats as "not found" rather
 * than a failure: versification can differ between translations (section
 * 63.1) — a verse number valid in the English KJV-based numbering
 * KnownValidVerseIndex validates against is not guaranteed to exist at
 * that same number in this API's own "Segond versification." That is
 * indistinguishable from an ordinary out-of-range request here, and both
 * are handled identically (null), which is the correct, safe behavior
 * either way.
 *
 * CORRECTIF (ARCHITECTURE.md section 107 — French translation choice):
 * `translation` was originally baked into `DEFAULT_BASE_URL` itself
 * ("https://api.getbible.net/v2/ls1910"), making this class permanently
 * Louis Segond 1910-only. getbible.net serves every translation from the
 * same host under `/v2/{translation}/{book_nr}/{chapter}.json` — verified
 * directly against the live API for a second, public-domain French
 * translation (J.N. Darby, abbreviation `darby`) before adding this
 * parameter: same JSON shape, same book_nr numbering, confirmed with a
 * real request (Jean 3:16 under `darby`) before this class was changed to
 * trust it. `translation` now selects both the request path and the
 * `Verse.translation` field on the result, so a Darby-sourced verse is
 * never mislabeled as `ls1910` downstream.
 */
const DEFAULT_BASE_URL = "https://api.getbible.net/v2"
const DEFAULT_TRANSLATION = "ls1910"

export class GetBibleVerseSource implements VerseSource, ChapterCapableSource {
  private readonly fetchImpl: typeof fetch
  private readonly translation: string
  private readonly baseUrl: string

  constructor(
    fetchImpl: typeof fetch = fetch,
    translation: string = DEFAULT_TRANSLATION,
    baseUrl: string = DEFAULT_BASE_URL
  ) {
    this.fetchImpl = fetchImpl
    this.translation = translation
    this.baseUrl = baseUrl
  }

  async getVerse(reference: VerseReference): Promise<Verse | null> {
    const body = await this.fetchChapterBody(reference.book, reference.chapter)
    if (body === null) return null
    return parseChapterResponse(body, reference, this.translation)
  }

  /**
   * Bible Browser (audit-notes/bible-browser.md): the same single request getVerse()
   * makes, but every verse of the chapter is returned (the API always sends the whole
   * chapter anyway). Same null-vs-throw contract; a malformed entry fails the whole
   * chapter rather than showing a partially trusted one.
   */
  async getChapter(book: string, chapter: number): Promise<readonly Verse[] | null> {
    const body = await this.fetchChapterBody(book, chapter)
    if (body === null) return null
    return parseWholeChapter(body, book, chapter, this.translation)
  }

  /** null = confirmed not found (unknown book, HTTP 404); throws on any real failure. */
  private async fetchChapterBody(book: string, chapter: number): Promise<unknown> {
    const bookNr = bookNumberFor(book)
    if (bookNr === null) return null // not a book this catalog knows — same as any other "not found"

    const url = `${this.baseUrl}/${this.translation}/${bookNr}/${chapter}.json`

    let response: Response
    try {
      response = await this.fetchImpl(url)
    } catch (err) {
      throw new Error(
        `GetBibleVerseSource: network request failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(`GetBibleVerseSource: unexpected HTTP status ${response.status}`)
    }

    try {
      return await response.json()
    } catch {
      throw new Error("GetBibleVerseSource: response body was not valid JSON")
    }
  }
}

function parseWholeChapter(body: unknown, book: string, chapter: number, translation: string): Verse[] {
  if (!isPlainObject(body)) {
    throw new Error("GetBibleVerseSource: response was not a JSON object")
  }
  const verses = body.verses
  if (!Array.isArray(verses)) {
    throw new Error("GetBibleVerseSource: response was missing a verses array")
  }
  const result: Verse[] = []
  for (const entry of verses) {
    if (!isPlainObject(entry) || typeof entry.verse !== "number" || !Number.isInteger(entry.verse) || entry.verse < 1) {
      throw new Error("GetBibleVerseSource: chapter contained a malformed verse entry")
    }
    const text = entry.text
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("GetBibleVerseSource: chapter contained a verse without text")
    }
    result.push({ reference: { book, chapter, verse: entry.verse }, text: text.trim(), translation, source: "getbible.net" })
  }
  result.sort((a, b) => a.reference.verse - b.reference.verse)
  return result
}

function bookNumberFor(bookId: string): number | null {
  const index = BOOK_CATALOG.findIndex((entry) => entry.id === bookId)
  return index === -1 ? null : index + 1
}

function parseChapterResponse(body: unknown, reference: VerseReference, translation: string): Verse | null {
  if (!isPlainObject(body)) {
    throw new Error("GetBibleVerseSource: response was not a JSON object")
  }
  const verses = body.verses
  if (!Array.isArray(verses)) {
    throw new Error("GetBibleVerseSource: response was missing a verses array")
  }

  const match = verses.find(
    (entry) => isPlainObject(entry) && entry.verse === reference.verse
  ) as Record<string, unknown> | undefined

  if (!match) return null // verse number absent from this chapter — confirmed not found, section 63.1

  const text = match.text
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("GetBibleVerseSource: matched verse entry was missing text")
  }

  return {
    reference,
    text: text.trim(),
    translation,
    source: "getbible.net",
  }
}
