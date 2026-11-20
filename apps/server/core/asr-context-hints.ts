import type { AsrContextHints } from "../../../packages/contracts"
import { BOOK_CATALOG } from "../verse/book-catalog"

/**
 * Core-side owner of the provider-neutral AsrContextHints (architecture note
 * `architecture-notes/keyterms-follow-sermon.md`). It knows books, never a
 * provider: turning a book into keyterms or a prompt is the adapter's job.
 *
 * Bounded by construction: at most MAX_FOCUS_BOOKS focus books, and the plan
 * can never hold more than the 66 canonical ids (unknown ids are dropped,
 * never forwarded).
 */
export const MAX_FOCUS_BOOKS = 2

const KNOWN_BOOK_IDS: ReadonlySet<string> = new Set(BOOK_CATALOG.map((book) => book.id))

export class AsrContextHintsTracker {
  private focus: readonly string[] = []
  private planned: readonly string[] = []

  /**
   * The operator is in `bookId` now (a verse of it was displayed, or a final
   * transcript announced it). It becomes the most relevant focus book.
   * Returns true when the hints changed (so the caller pushes them).
   */
  noteFocusBook(bookId: string): boolean {
    if (!KNOWN_BOOK_IDS.has(bookId)) return false
    if (this.focus[0] === bookId) return false
    this.focus = [bookId, ...this.focus.filter((id) => id !== bookId)].slice(0, MAX_FOCUS_BOOKS)
    return true
  }

  /** The service plan (rundown then sermon prep). Returns true when it changed. */
  setPlannedBooks(bookIds: readonly string[]): boolean {
    const next = [...new Set(bookIds.filter((id) => KNOWN_BOOK_IDS.has(id)))]
    if (sameList(next, this.planned)) return false
    this.planned = next
    return true
  }

  /** A fresh, immutable snapshot: focus most-relevant first, plan without the focus books. */
  current(): AsrContextHints {
    const focus = [...this.focus]
    return Object.freeze({
      focusBooks: Object.freeze(focus),
      plannedBooks: Object.freeze(this.planned.filter((id) => !focus.includes(id))),
    })
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}
