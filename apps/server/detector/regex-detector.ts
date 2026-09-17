import type { VerseDetector, VerseReference } from "../../../packages/contracts"

/**
 * v1 VerseDetector implementation (ARCHITECTURE.md section 12, section 50).
 *
 * Recognizes the explicit "Book Chapter:Verse" pattern: a single
 * capitalized word (optionally prefixed by 1/2/3, e.g. "1 Corinthians"),
 * followed by "chapter:verse" digits.
 *
 * CORRECTIF (found via resolve-transcript-verses.test.ts, a sentence
 * starting with a capitalized word right before the reference — "Read
 * John 3:16..."): an earlier version of this pattern allowed the book
 * group to greedily consume *any* run of consecutive capitalized words
 * (`(?:\s+[A-Z][A-Za-z]+)*`), intended to support multi-word book names.
 * Regex greediness doesn't backtrack away from a longer match that still
 * lets the rest of the pattern succeed, so "Read John 3:16" parsed as
 * book="Read John" instead of book="John" — a real, silent misdetection,
 * not a hallucination-guard case (KnownValidVerseIndex correctly rejects
 * "read john", but the real, intended reference was lost along with it).
 * The book group is now exactly one optionally-numeral-prefixed word;
 * this only ever supported numeral-prefixed multi-word names like
 * "1 Corinthians" in the first place (a true multi-word, non-numeral name
 * like "Song of Solomon" was never correctly handled either way — see the
 * module-level limitation noted in earlier sessions), so this is a strict
 * correctness improvement with no coverage loss.
 *
 * This detector is purely syntactic. It does NOT know which book names are
 * real, and it does not check whether a chapter/verse combination actually
 * exists — that is the Known-Valid Verse Index's job (ARCHITECTURE.md
 * section 15), applied downstream. Per AGENTS.md section 12, this detector
 * never calls APIs, accesses the filesystem/cache, or sends WebSocket
 * messages, and it never fetches or renders anything.
 */
const REFERENCE_PATTERN = /\b((?:[123]\s+)?[A-Z][A-Za-z]+)\s+(\d{1,3}):(\d{1,3})\b/g

export class RegexDetector implements VerseDetector {
  detect(text: string): VerseReference[] {
    const references: VerseReference[] = []

    for (const match of text.matchAll(REFERENCE_PATTERN)) {
      const rawBook = match[1]
      const rawChapter = match[2]
      const rawVerse = match[3]
      if (!rawBook || !rawChapter || !rawVerse) continue

      references.push({
        book: normalizeBookName(rawBook),
        chapter: Number.parseInt(rawChapter, 10),
        verse: Number.parseInt(rawVerse, 10),
      })
    }

    return references
  }
}

/**
 * Normalizes captured book text to a stable lookup key: trimmed, internal
 * whitespace collapsed to a single space, lowercased. This is the same key
 * shape the Known-Valid Verse Index expects (see book-catalog.ts).
 */
export function normalizeBookName(rawBook: string): string {
  return rawBook.trim().replace(/\s+/g, " ").toLowerCase()
}
