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
 *
 * CORRECTIF (found while adding French voice-command support — the app's
 * primary deployment target is a French-speaking church): the book-name
 * group used `[A-Z][A-Za-z]+`, which only matches plain ASCII letters.
 * French book names routinely start with an accented capital ("Ésaïe",
 * "Éphésiens"), and JS's `\b` word-boundary is defined in terms of `\w`
 * (`[A-Za-z0-9_]` only) — it does NOT treat an accented letter as a "word"
 * character, so a leading `\b` before "É" simply fails to find a boundary
 * there at all, silently rejecting the ENTIRE reference before
 * normalizeBookName() ever runs. Fixed with `\p{L}`/`\p{Lu}` (Unicode
 * "letter"/"uppercase letter" properties, requiring the `u` flag) for the
 * book-name group, and manual Unicode-aware boundary assertions
 * (`(?<![\p{L}\d])` / `(?![\p{L}\d])`) in place of `\b`, verified against
 * both plain-ASCII and accented book names before shipping — not assumed
 * to "just work" from adding the `u` flag alone.
 */
const REFERENCE_PATTERN =
  /(?<![\p{L}\d])((?:[123]\s+)?\p{Lu}[\p{L}]+)\s+(\d{1,3}):(\d{1,3})(?![\p{L}\d])/gu

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
 * Strips combining diacritical marks (accents) via Unicode NFD
 * decomposition — "Ésaïe" -> "esaie". Used so ASR output that may or may
 * not preserve accents correctly still normalizes to the same lookup key
 * either way. Exported for reuse by NavigationCommandDetector's own
 * French phrase matching (ARCHITECTURE.md section 65 French support).
 */
export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/**
 * French book-name aliases, mapping an accent-stripped, lowercased French
 * name to BOOK_CATALOG's existing English-based canonical id — no new
 * dataset (BOOK_CATALOG's ids/chapter-verse-counts are unchanged), just a
 * second way to name the same 66 entries. Added because the app's primary
 * deployment target is a French-speaking church (confirmed explicitly):
 * without this, a French sermon's spoken references ("Jean 3:16",
 * "Romains 8:28") would never resolve at all, since normalizeBookName()
 * previously only trimmed/lowercased without translating.
 */
const FRENCH_BOOK_ALIASES: Readonly<Record<string, string>> = {
  genese: "genesis",
  exode: "exodus",
  levitique: "leviticus",
  nombres: "numbers",
  deuteronome: "deuteronomy",
  josue: "joshua",
  juges: "judges",
  ruth: "ruth",
  "1 samuel": "1 samuel",
  "2 samuel": "2 samuel",
  "1 rois": "1 kings",
  "2 rois": "2 kings",
  "1 chroniques": "1 chronicles",
  "2 chroniques": "2 chronicles",
  esdras: "ezra",
  nehemie: "nehemiah",
  esther: "esther",
  job: "job",
  psaumes: "psalm",
  psaume: "psalm",
  proverbes: "proverbs",
  ecclesiaste: "ecclesiastes",
  "cantique des cantiques": "song of solomon",
  esaie: "isaiah",
  jeremie: "jeremiah",
  lamentations: "lamentations",
  ezechiel: "ezekiel",
  daniel: "daniel",
  osee: "hosea",
  joel: "joel",
  amos: "amos",
  abdias: "obadiah",
  jonas: "jonah",
  michee: "micah",
  nahum: "nahum",
  habacuc: "habakkuk",
  sophonie: "zephaniah",
  aggee: "haggai",
  zacharie: "zechariah",
  malachie: "malachi",
  matthieu: "matthew",
  marc: "mark",
  luc: "luke",
  jean: "john",
  actes: "acts",
  romains: "romans",
  "1 corinthiens": "1 corinthians",
  "2 corinthiens": "2 corinthians",
  galates: "galatians",
  ephesiens: "ephesians",
  philippiens: "philippians",
  colossiens: "colossians",
  "1 thessaloniciens": "1 thessalonians",
  "2 thessaloniciens": "2 thessalonians",
  "1 timothee": "1 timothy",
  "2 timothee": "2 timothy",
  tite: "titus",
  philemon: "philemon",
  hebreux: "hebrews",
  jacques: "james",
  "1 pierre": "1 peter",
  "2 pierre": "2 peter",
  "1 jean": "1 john",
  "2 jean": "2 john",
  "3 jean": "3 john",
  jude: "jude",
  apocalypse: "revelation",
}

/**
 * Normalizes captured book text to a stable lookup key: trimmed, internal
 * whitespace collapsed to a single space, lowercased, accents stripped,
 * then translated through FRENCH_BOOK_ALIASES if it names a book in
 * French — otherwise returned as-is (already the correct id for an
 * English name, e.g. "john" needs no translation). This is the same key
 * shape the Known-Valid Verse Index expects (see book-catalog.ts).
 */
export function normalizeBookName(rawBook: string): string {
  const normalized = stripAccents(rawBook.trim().replace(/\s+/g, " ").toLowerCase())
  return FRENCH_BOOK_ALIASES[normalized] ?? normalized
}
