import type { VerseIndex, VerseReference } from "../../../packages/contracts"
import { BOOK_CATALOG, type BookEntry } from "./book-catalog"

/**
 * Alternate spellings that should resolve to the same catalog entry.
 * Keep this list small and explicit (AGENTS.md section 40) — add an entry
 * only when a real, common spelling is missing, never speculatively.
 */
const BOOK_ID_ALIASES: Readonly<Record<string, string>> = {
  psalms: "psalm",
}

/**
 * v1 VerseIndex implementation — the hallucination guard (ARCHITECTURE.md
 * section 15, section 50). Answers "does this reference exist?" using the
 * small static book/chapter/verse-count dataset in book-catalog.ts. It
 * never holds verse text and never calls an external API.
 */
export class KnownValidVerseIndex implements VerseIndex {
  private readonly booksById: ReadonlyMap<string, BookEntry>

  constructor(catalog: readonly BookEntry[] = BOOK_CATALOG) {
    const booksById = new Map<string, BookEntry>()
    for (const book of catalog) {
      booksById.set(book.id, book)
    }
    this.booksById = booksById
  }

  exists(reference: VerseReference): boolean {
    const book = this.findBook(reference.book)
    if (!book) return false

    if (!Number.isInteger(reference.chapter) || reference.chapter < 1) return false
    const verseCount = book.chapters[reference.chapter - 1]
    if (verseCount === undefined) return false

    if (!Number.isInteger(reference.verse) || reference.verse < 1) return false
    return reference.verse <= verseCount
  }

  private findBook(rawBookId: string): BookEntry | undefined {
    const id = normalizeBookId(rawBookId)
    const canonicalId = BOOK_ID_ALIASES[id] ?? id
    return this.booksById.get(canonicalId)
  }
}

/**
 * Defensive re-normalization: exists() should behave correctly even if a
 * caller passes book text that was not already normalized by the detector
 * (trim, collapse whitespace, lowercase — same rule as
 * RegexDetector#normalizeBookName).
 */
function normalizeBookId(rawBookId: string): string {
  return rawBookId.trim().replace(/\s+/g, " ").toLowerCase()
}
