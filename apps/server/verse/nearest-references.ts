import type { VerseIndex, VerseReference } from "../../../packages/contracts"
import { BOOK_CATALOG } from "./book-catalog"

/**
 * "Did you mean?" candidates for a reference the detector heard but the
 * known-valid index rejected. Pure and deterministic: it uses only
 * BOOK_CATALOG's chapter/verse counts and re-validates every candidate through
 * `index.exists()` (AGENTS.md section 13), so it can never offer a reference
 * that does not exist.
 *
 * The only case with an honest guess is a real chapter whose verse number runs
 * past its end (the speaker or ASR said 4:8, Isaiah 4 has 6 verses): the
 * chapter's LAST verse is offered. An unknown book or an out-of-range chapter
 * has no honest guess, so nothing is offered. Candidates are never displayed
 * on their own; the operator must pick one, which sends a normal verse:override.
 */
export function suggestNearestReferences(reference: VerseReference, index: VerseIndex): VerseReference[] {
  if (index.exists(reference)) return []
  const book = BOOK_CATALOG.find((entry) => entry.id === reference.book)
  if (!book) return []
  const versesInChapter = book.chapters[reference.chapter - 1]
  if (versesInChapter === undefined) return []
  if (reference.verse <= versesInChapter) return []
  const lastVerse: VerseReference = { book: reference.book, chapter: reference.chapter, verse: versesInChapter }
  return index.exists(lastVerse) ? [lastVerse] : []
}
