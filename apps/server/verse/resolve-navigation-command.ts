import type { NavigationCommand, VerseIndex, VerseReference } from "../../../packages/contracts"
import { BOOK_CATALOG } from "./book-catalog"

export type NavigationResolution =
  | { readonly kind: "reference"; readonly reference: VerseReference; readonly fallback?: boolean }
  | { readonly kind: "cancel" }
  | { readonly kind: "no-op"; readonly reason: "chapter_out_of_range" | "verse_out_of_range" | "no_current_position" | "unknown_book" }

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
    if (index.exists(candidate)) {
      return { kind: "reference", reference: candidate }
    }
    // TASK 5: out-of-range chapter — instead of no-op, fall back to the
    // book's last valid chapter (verse 1) so that subsequent bare-verse
    // commands ("verset 16") have a valid currentPosition to resolve against.
    // This matches the observed live sequence: "Jean chapitre 23" (John has 21
    // chapters) -> falls back to John 21:1 -> "verset 16" resolves to John 21:16.
    // The caller (AppCore) should broadcast a warning for the dashboard.
    const bookIndex = BOOK_CATALOG.findIndex((b) => b.id === command.book)
    if (bookIndex < 0) {
      return { kind: "no-op", reason: "unknown_book" }
    }
    const book = BOOK_CATALOG[bookIndex]!
    const lastChapter = book.chapters.length
    const fallback: VerseReference = { book: command.book, chapter: lastChapter, verse: 1 }
    if (index.exists(fallback)) {
      return { kind: "reference", reference: fallback, fallback: true as const }
    }
    return { kind: "no-op", reason: "chapter_out_of_range" }
  }

  // TASK 1: explicit "<book> chapitre|chapter N[,] verset|verse M" — full
  // reference with all three components. Resolves independently of
  // currentPosition (unlike the bare patterns). Still validated through
  // index.exists() per Invariant 17.
  if (command.kind === "goto-book-chapter-verse") {
    const candidate: VerseReference = { book: command.book, chapter: command.chapter, verse: command.verse }
    if (index.exists(candidate)) {
      return { kind: "reference", reference: candidate }
    }
    // PROD AUDIT 2026-09: this branch used to always no-op even though it
    // computed the precise reason. Two exact production cases:
    //   "Daniel chapitre 13 verset 14" — Daniel has 12 chapters
    //   "Esaïe chapitre 4, verset 18" — Isaiah 4 has 22 verses
    // Same fallback mechanism as goto-chapter above: an out-of-range
    // chapter falls back to the book's LAST VALID chapter; a verse beyond
    // a valid chapter's end is clamped to that chapter's LAST VERSE (not
    // verse:1 — the speaker clearly wanted the end of the chapter they
    // named). Always validated through index.exists() (invariant 17);
    // fallback:true lets AppCore broadcast a dashboard warning.
    const bookIndex = BOOK_CATALOG.findIndex((b) => b.id === command.book)
    if (bookIndex < 0) {
      return { kind: "no-op", reason: "unknown_book" }
    }
    const book = BOOK_CATALOG[bookIndex]!
    const lastChapter = book.chapters.length
    if (command.chapter < 1 || command.chapter > lastChapter) {
      const lastChapterRef: VerseReference = {
        book: command.book,
        chapter: lastChapter,
        verse: book.chapters[lastChapter - 1]!,
      }
      if (index.exists(lastChapterRef)) {
        return { kind: "reference", reference: lastChapterRef, fallback: true as const }
      }
      return { kind: "no-op", reason: "chapter_out_of_range" }
    }
    const versesInChapter = book.chapters[command.chapter - 1]!
    if (command.verse < 1 || command.verse > versesInChapter) {
      const clampedRef: VerseReference = {
        book: command.book,
        chapter: command.chapter,
        verse: versesInChapter,
      }
      if (index.exists(clampedRef)) {
        return { kind: "reference", reference: clampedRef, fallback: true as const }
      }
      return { kind: "no-op", reason: "verse_out_of_range" }
    }
    return { kind: "no-op", reason: "verse_out_of_range" }
  }

  // ARCHITECTURE.md section 65.4: never produces a VerseReference at all —
  // AppCore intercepts this kind directly and never calls resolveVerse()
  // for it. This branch only exists so the function stays total/defensive
  // rather than throwing if it's ever reached anyway.
  if (command.kind === "goto-display-mode") {
    return { kind: "no-op", reason: "no_current_position" }
  }

  if (!currentPosition) {
    return { kind: "no-op", reason: "no_current_position" }
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
    if (index.exists(candidate)) {
      return { kind: "reference", reference: candidate }
    }
    // Verse doesn't exist in the current chapter
    return { kind: "no-op", reason: "verse_out_of_range" }
  }

  if (command.kind === "goto-bare-chapter-verse") {
    const candidate: VerseReference = { book: currentPosition.book, chapter: command.chapter, verse: command.verse }
    if (index.exists(candidate)) {
      return { kind: "reference", reference: candidate }
    }
    // Check if chapter is out of range for the current book
    const bookIndex = BOOK_CATALOG.findIndex((b) => b.id === currentPosition.book)
    if (bookIndex >= 0) {
      const book = BOOK_CATALOG[bookIndex]!
      if (command.chapter < 1 || command.chapter > book.chapters.length) {
        return { kind: "no-op", reason: "chapter_out_of_range" }
      }
    }
    return { kind: "no-op", reason: "verse_out_of_range" }
  }

  const candidate = computeCandidate(command.kind, currentPosition)
  if (!candidate) {
    // computeCandidate returns null at Bible boundaries (Genesis 1:1, Revelation 22:21)
    return { kind: "no-op", reason: "verse_out_of_range" }
  }
  if (!index.exists(candidate)) {
    return { kind: "no-op", reason: "verse_out_of_range" }
  }
  return { kind: "reference", reference: candidate }
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
