import { BOOK_CATALOG } from "../verse/book-catalog"
import { CATALOG_IDS, isCatalogBookWord, normalizeBookName, stripAccents } from "./regex-detector"
import { normalizeSpokenReferences } from "./spoken-reference-normalizer"

/**
 * The book and chapter a speaker has just ANNOUNCED, with or without a verse:
 * "Dans Esaïe 4, le verset 8" announces Isaiah 4. Pure and deterministic (no
 * APIs, cache, filesystem or WebSocket, AGENTS.md section 12).
 *
 * Why it exists: NavigationCommandDetector reads that sentence as a bare
 * "verset 8", which resolveNavigationCommand resolves against whatever verse was
 * LAST displayed. With John 3 on screen it would show John 3:8, a verse nobody
 * asked for. AppCore uses this to resolve a bare verse against the chapter the
 * speaker actually named. It is only context: it never produces a reference on
 * its own, and every reference computed from it still goes through the
 * known-valid index and the verse source.
 *
 * Only a real catalog book followed by an in-range chapter number counts. A
 * reference with a verse already attached ("Jean 3:16") is not an announcement;
 * the detector handles that.
 */

export type AnnouncedChapter = { readonly book: string; readonly chapter: number }

const ANNOUNCED_CHAPTER_PATTERN =
  /(?<![\p{L}\d])((?:[123]\s+)?\p{L}[\p{L}]+)[\s,]+(chapitre|chapter)?[\s,]*(\d{1,3})(?![\p{L}\d]|\s*[.,:]\s*\d)/giu

// Everyday words that are also (mis)heard book names: they only count with an explicit "chapitre"/"chapter".
const KEYWORD_REQUIRED_WORDS = new Set(["nombre"])

/** The most recent announced chapter in `text`, or null. */
export function extractAnnouncedChapter(rawText: string): AnnouncedChapter | null {
  const text = normalizeSpokenReferences(rawText, isCatalogBookWord)
  let found: AnnouncedChapter | null = null
  const pattern = new RegExp(ANNOUNCED_CHAPTER_PATTERN.source, ANNOUNCED_CHAPTER_PATTERN.flags)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const candidate = toAnnouncedChapter(match)
    if (candidate) {
      found = candidate
    } else {
      // A rejected candidate ("dans 1" before "1 Jean 4") must not swallow the text a real
      // one starts in: rescan from just after where it began instead of after where it ended.
      pattern.lastIndex = match.index + 1
    }
  }
  return found
}

function toAnnouncedChapter(match: RegExpExecArray): AnnouncedChapter | null {
  const [, rawBook, keyword, rawChapter] = match
  if (!rawBook || !rawChapter) return null
  if (!keyword && KEYWORD_REQUIRED_WORDS.has(stripAccents(rawBook).toLowerCase())) return null
  const book = normalizeBookName(rawBook)
  if (!CATALOG_IDS.has(book)) return null
  const chapters = BOOK_CATALOG.find((entry) => entry.id === book)?.chapters.length ?? 0
  const chapter = Number.parseInt(rawChapter, 10)
  if (chapter < 1 || chapter > chapters) return null
  return { book, chapter }
}
