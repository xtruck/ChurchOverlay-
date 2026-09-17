import type { NavigationCommand, VerseIndex, VerseReference } from "../../../packages/contracts"
import { BOOK_CATALOG } from "./book-catalog"

export type NavigationResolution =
  | { readonly kind: "reference"; readonly reference: VerseReference }
  | { readonly kind: "cancel" }
  | { readonly kind: "no-op" }

/**
 * ARCHITECTURE.md section 61.4: computes the target reference for a
 * navigation command from the current position, using BOOK_CATALOG's
 * existing order and chapter/verse-count data — no new dataset. "no-op"
 * (nothing broadcasts, nothing changes) is the correct failure direction
 * at every boundary (Genesis 1:1 has no previous, Revelation's last verse
 * has no next) and when there is no current position to navigate from at
 * all — the safe direction is nothing happening, not something incorrect
 * appearing, the same principle MediaCueDetector's exact-match-only
 * design already applies (section 60.3).
 *
 * Invariant 17: every computed reference is still validated through
 * `index.exists()` before being returned as `{ kind: "reference" }` —
 * never skipped, even though it was computed from the same catalog. This
 * is not redundant defensiveness; it is the same "never bypass the
 * hallucination guard for any code path that produces a VerseReference"
 * rule invariant 7 already establishes, applied consistently here too.
 */
export function resolveNavigationCommand(
  command: NavigationCommand,
  currentPosition: VerseReference | null,
  index: VerseIndex
): NavigationResolution {
  if (command.kind === "cancel") {
    return { kind: "cancel" }
  }

  if (command.kind === "goto-chapter") {
    const candidate: VerseReference = { book: command.book, chapter: command.chapter, verse: 1 }
    return index.exists(candidate) ? { kind: "reference", reference: candidate } : { kind: "no-op" }
  }

  // ARCHITECTURE.md section 65.4: never produces a VerseReference at all —
  // AppCore intercepts this kind directly and never calls resolveVerse()
  // for it. This branch only exists so the function stays total/defensive
  // rather than throwing if it's ever reached anyway.
  if (command.kind === "goto-display-mode") {
    return { kind: "no-op" }
  }

  if (!currentPosition) {
    return { kind: "no-op" }
  }

  // ARCHITECTURE.md section 65.1: elliptical/continuation references,
  // resolved against currentPosition rather than a stated book (and, for
  // goto-bare-verse, chapter too) — still validated through
  // KnownValidVerseIndex.exists() exactly like every other computed
  // reference (invariant 17), no exception for a "simpler" case.
  if (command.kind === "goto-bare-verse") {
    const candidate: VerseReference = {
      book: currentPosition.book,
      chapter: currentPosition.chapter,
      verse: command.verse,
    }
    return index.exists(candidate) ? { kind: "reference", reference: candidate } : { kind: "no-op" }
  }

  if (command.kind === "goto-bare-chapter-verse") {
    const candidate: VerseReference = { book: currentPosition.book, chapter: command.chapter, verse: command.verse }
    return index.exists(candidate) ? { kind: "reference", reference: candidate } : { kind: "no-op" }
  }

  const candidate = computeCandidate(command.kind, currentPosition)
  if (!candidate) {
    return { kind: "no-op" }
  }
  return index.exists(candidate) ? { kind: "reference", reference: candidate } : { kind: "no-op" }
}

function computeCandidate(
  kind: "next-verse" | "previous-verse" | "next-chapter" | "previous-chapter",
  current: VerseReference
): VerseReference | null {
  switch (kind) {
    case "next-verse":
      return nextVerse(current)
    case "previous-verse":
      return previousVerse(current)
    case "next-chapter":
      return nextChapter(current)
    case "previous-chapter":
      return previousChapter(current)
  }
}

function findBookIndex(bookId: string): number {
  return BOOK_CATALOG.findIndex((book) => book.id === bookId)
}

function nextVerse(current: VerseReference): VerseReference | null {
  const bookIndex = findBookIndex(current.book)
  const book = BOOK_CATALOG[bookIndex]
  if (!book) return null

  const versesInChapter = book.chapters[current.chapter - 1]
  if (versesInChapter === undefined) return null

  if (current.verse < versesInChapter) {
    return { book: current.book, chapter: current.chapter, verse: current.verse + 1 }
  }
  if (current.chapter < book.chapters.length) {
    return { book: current.book, chapter: current.chapter + 1, verse: 1 }
  }
  const nextBook = BOOK_CATALOG[bookIndex + 1]
  return nextBook ? { book: nextBook.id, chapter: 1, verse: 1 } : null // Revelation 22:21 — no next
}

function previousVerse(current: VerseReference): VerseReference | null {
  const bookIndex = findBookIndex(current.book)
  const book = BOOK_CATALOG[bookIndex]
  if (!book) return null

  if (current.verse > 1) {
    return { book: current.book, chapter: current.chapter, verse: current.verse - 1 }
  }
  if (current.chapter > 1) {
    const versesInPreviousChapter = book.chapters[current.chapter - 2]
    if (versesInPreviousChapter === undefined) return null
    return { book: current.book, chapter: current.chapter - 1, verse: versesInPreviousChapter }
  }
  const previousBook = BOOK_CATALOG[bookIndex - 1]
  if (!previousBook) return null // Genesis 1:1 — no previous
  const lastChapter = previousBook.chapters.length
  const lastVerse = previousBook.chapters[lastChapter - 1]
  if (lastVerse === undefined) return null
  return { book: previousBook.id, chapter: lastChapter, verse: lastVerse }
}

function nextChapter(current: VerseReference): VerseReference | null {
  const bookIndex = findBookIndex(current.book)
  const book = BOOK_CATALOG[bookIndex]
  if (!book) return null

  if (current.chapter < book.chapters.length) {
    return { book: current.book, chapter: current.chapter + 1, verse: 1 }
  }
  const nextBook = BOOK_CATALOG[bookIndex + 1]
  return nextBook ? { book: nextBook.id, chapter: 1, verse: 1 } : null
}

function previousChapter(current: VerseReference): VerseReference | null {
  const bookIndex = findBookIndex(current.book)
  if (bookIndex === -1) return null

  if (current.chapter > 1) {
    return { book: current.book, chapter: current.chapter - 1, verse: 1 }
  }
  const previousBook = BOOK_CATALOG[bookIndex - 1]
  return previousBook ? { book: previousBook.id, chapter: previousBook.chapters.length, verse: 1 } : null
}
