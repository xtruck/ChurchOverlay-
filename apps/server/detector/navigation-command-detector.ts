import type { NavigationCommand, NavigationCommandDetector as INavigationCommandDetector } from "../../../packages/contracts"
import { normalizeBookName, stripAccents } from "./regex-detector"
import { BOOK_CATALOG } from "../verse/book-catalog"

/**
 * ARCHITECTURE.md section 61.2-61.3: voice-driven verse navigation, a
 * sibling to RegexDetector, not an extension of it — this recognizes
 * command phrases ("next verse", "cancel"), never Bible references.
 * Deliberately NOT part of VerseDetector (see NavigationCommand's own
 * doc comment in packages/contracts/verse.ts): resolving a command
 * needs the current position, which this detector has no access to and
 * needs none of — it only answers "what was asked for," never "what
 * reference does that resolve to" (that's resolveNavigationCommand()).
 *
 * Confirmed explicitly, not assumed: a small, fixed synonym list per
 * command, not exact-single-phrase-only and not fuzzy/semantic matching.
 * Short synonyms ("next", "clear") must be the transcript's ENTIRE
 * trimmed text to trigger — a real, accepted false-positive tradeoff
 * (section 61.3): a one-word utterance is far less likely to appear
 * embedded in an unrelated sentence than as a genuine command. Longer,
 * more specific phrases ("next verse", "clear the screen") match as a
 * substring, the same way MediaCueDetector's title matching does.
 */
type SubstringRule = { readonly phrase: string; readonly command: NavigationCommand }
type WholeUtteranceRule = { readonly phrase: string; readonly command: NavigationCommand }

// French phrases (ARCHITECTURE.md section 65 — confirmed explicitly: the
// app's primary deployment target is a French-speaking church, so French
// voice commands are not a "someday" nice-to-have but core coverage,
// added alongside English rather than after it). Phrases are written
// already accent-stripped ("precedent", not "précédent") since
// normalizeUtterance() strips accents from the transcript before matching
// — ASR output may or may not preserve accents correctly, and this way
// both forms normalize to the same comparison.
const SUBSTRING_RULES: readonly SubstringRule[] = [
  { phrase: "next verse", command: { kind: "next-verse" } },
  { phrase: "verset suivant", command: { kind: "next-verse" } },
  // ARCHITECTURE.md section 72: confirmed live-testing gap — French
  // naturally allows "next X" as either "X suivant" (noun-first) or
  // "prochain X" (adjective-first), and only the former was covered.
  // A speaker saying "le prochain verset" got no match at all.
  { phrase: "prochain verset", command: { kind: "next-verse" } },
  { phrase: "previous verse", command: { kind: "previous-verse" } },
  { phrase: "verset precedent", command: { kind: "previous-verse" } },
  { phrase: "go back", command: { kind: "previous-verse" } },
  { phrase: "next chapter", command: { kind: "next-chapter" } },
  { phrase: "chapitre suivant", command: { kind: "next-chapter" } },
  { phrase: "prochain chapitre", command: { kind: "next-chapter" } },
  { phrase: "previous chapter", command: { kind: "previous-chapter" } },
  { phrase: "chapitre precedent", command: { kind: "previous-chapter" } },
  { phrase: "clear the screen", command: { kind: "cancel" } },
  { phrase: "effacer l'ecran", command: { kind: "cancel" } },
  { phrase: "efface l'ecran", command: { kind: "cancel" } },
  // ARCHITECTURE.md section 65.4 — a spoken display-mode switch. Longer,
  // specific phrases match as a substring, same reasoning as every other
  // substring rule above. French phrases deliberately avoid a conjugated
  // verb ("passer"/"passons"/"passez"/"passe" would each need their own
  // entry to catch real spoken commands) — "en français"/"en anglais" is
  // conjugation-independent and matches all of them ("passons en
  // français", "mets en français", "passe en français", ...).
  { phrase: "switch to english", command: { kind: "goto-display-mode", mode: "english" } },
  { phrase: "english only", command: { kind: "goto-display-mode", mode: "english" } },
  { phrase: "en anglais", command: { kind: "goto-display-mode", mode: "english" } },
  { phrase: "anglais seulement", command: { kind: "goto-display-mode", mode: "english" } },
  { phrase: "switch to french", command: { kind: "goto-display-mode", mode: "french" } },
  { phrase: "french only", command: { kind: "goto-display-mode", mode: "french" } },
  { phrase: "en francais", command: { kind: "goto-display-mode", mode: "french" } },
  { phrase: "francais seulement", command: { kind: "goto-display-mode", mode: "french" } },
  { phrase: "switch to bilingual", command: { kind: "goto-display-mode", mode: "bilingual" } },
  { phrase: "en bilingue", command: { kind: "goto-display-mode", mode: "bilingual" } },
  { phrase: "mode bilingue", command: { kind: "goto-display-mode", mode: "bilingual" } },
]

const WHOLE_UTTERANCE_RULES: readonly WholeUtteranceRule[] = [
  { phrase: "next", command: { kind: "next-verse" } },
  { phrase: "suivant", command: { kind: "next-verse" } },
  { phrase: "previous", command: { kind: "previous-verse" } },
  { phrase: "precedent", command: { kind: "previous-verse" } },
  { phrase: "cancel", command: { kind: "cancel" } },
  { phrase: "annuler", command: { kind: "cancel" } },
  { phrase: "clear", command: { kind: "cancel" } },
  { phrase: "effacer", command: { kind: "cancel" } },
]

// "<book> chapter <number>" — e.g. "go to Romans chapter 8". Requires the
// literal word "chapter" and no trailing verse indicator (neither
// ":<verse>" nor ", verse <verse>"), so it never fires on RegexDetector's
// own territory ("Romans 8:16") NOR on section 65.1's own territory
// ("Romans chapter 9, verse 3" — a full reference in prose form, which
// must not be misread as "jump to chapter 9's verse 1", silently
// discarding the actually-spoken verse 3).
//
// CORRECTIF (found via section 65.1's own test suite): the original
// pattern used a whole-pattern /i flag, which — since JS character
// classes ignore case under /i — made `[A-Z]` match ANY letter, not just
// an actually-capitalized one. "Let's turn to chapter 8" was silently
// matching book="to" (a lowercase word immediately before "chapter"),
// producing a bogus goto-chapter command a real book-name check would
// never have allowed. Book-name capitalization must stay genuinely
// case-SENSITIVE for that check to mean anything; only the literal
// command words ("chapter"/"chapitre") need to tolerate case, so they're
// spelled out instead of relying on a pattern-wide /i.
//
// `\p{Lu}[\p{L}]+` (Unicode letter properties, /u flag) and manual
// `(?<![\p{L}\d])`/`(?![\p{L}\d])` boundaries in place of `\b` — same
// reasoning as RegexDetector.REFERENCE_PATTERN's own fix: `\b` doesn't
// recognize an accented letter as a "word" character at all, which would
// silently reject an accented French book name ("Ésaïe") outright.
//
// CORRECTIF (TASK 2): relaxed book-name group from \p{Lu} (uppercase only)
// to \p{L} (any case) and added catalog validation via normalizeBookName()
// — this allows lowercase-transcribed real book names ("jean") while still
// rejecting non-books ("to") via BOOK_CATALOG lookup.
// CORRECTIF (2026-09-23, live-observed): the same comma-tolerance gap
// found and fixed in RegexDetector's SPOKEN_REFERENCE_PATTERN also existed
// here — a real service reading references aloud produces a comma at
// every spoken pause ("Abacuc, 1, 2, 3,"), and this pattern's plain `\s+`
// separators rejected that outright. Also widened the trailing
// verse-exclusion lookahead to recognize "le verset"/"the verse" (not
// just bare "verset"/"verse"), matching SPOKEN_REFERENCE_PATTERN's own
// keyword alternation — without it, "chapitre 1, le verset 2" could be
// misread as a chapter-only goto instead of correctly falling through to
// the full BOOK_CHAPTER_VERSE_PATTERN.
const GOTO_CHAPTER_PATTERN =
  /(?<![\p{L}\d])((?:[123]\s+)?\p{L}[\p{L}]+)[\s,]+(?:[Cc]hapter|[Cc]hapitre)[\s,]+(\d{1,3})(?![\p{L}\d])(?!:\d)(?!\s*,?\s*(?:le\s+|the\s+)?(?:[Vv]erse|[Vv]erset)\b)/gu

// TASK 1 + TASK 2: "<book> chapter|chapitre N[,] verse|verset M" — full
// prose-form reference with all three components. Unlike goto-chapter (no
// verse) and bare patterns (depend on currentPosition), this resolves
// independently. Must run BEFORE bare patterns so the bare patterns'
// lookbehinds (which exclude a capitalized book-like word) don't
// incorrectly suppress it. Book-name group uses \p{L} (any case) instead of
// \p{Lu} (uppercase only) — TASK 2 relaxes the capitalization heuristic
// and validates against BOOK_CATALOG via normalizeBookName() instead.
// Accented letters are handled via \p{L}/\p{Lu} and Unicode boundaries.
// CORRECTIF (2026-09-23, live-observed): comma-tolerant separators
// (matching SPOKEN_REFERENCE_PATTERN's own fix) plus "le verset"/"the
// verse" tolerance — "Jean chapitre 1, le verset 2" is exactly as real and
// common in spoken French as "Jean chapitre 1, verset 2".
const BOOK_CHAPTER_VERSE_PATTERN =
  /(?<![\p{L}\d])((?:[123]\s+)?\p{L}[\p{L}]+)[\s,]+(?:[Cc]hapter|[Cc]hapitre)[\s,]+(\d{1,3})[\s,]+(?:le\s+|the\s+)?(?:[Vv]erse|[Vv]erset)[\s,]+(\d{1,3})(?![\p{L}\d])/gu

// ARCHITECTURE.md section 65.1: elliptical/continuation references —
// "verse 16" or "chapter 9, verse 3" said after a book/chapter was already
// established, resolved against currentPosition (resolveNavigationCommand)
// rather than a stated book. Deliberately NOT case-insensitive as a whole
// pattern (unlike GOTO_CHAPTER_PATTERN): the negative lookbehind uses
// \p{Lu} (uppercase) to exclude capitalized book-like words — this correctly
// rejects "Romans chapter 9, verse 3" (full reference) but passes
// "Turn to chapter 9" (lowercase "to" is not a book). TASK 2: the new
// BOOK_CHAPTER_VERSE_PATTERN runs first and handles lowercase books with
// catalog validation, so this lookbehind correctly stays \p{Lu} (uppercase
// heuristic) — "jean" is caught by the new pattern first, "to" in
// "Turn to chapter 9" is lowercase and passes through.
// CORRECTIF (2026-09-23, live-observed): comma-tolerant separators plus
// "le verset"/"the verse" tolerance, same reasoning as the two patterns
// above.
const BARE_CHAPTER_VERSE_PATTERN =
  /(?<!(?:[123]\s+)?\p{Lu}[\p{L}]+\s)\b(?:[Cc]hapter|[Cc]hapitre)[\s,]+(\d{1,3})[\s,]+(?:le\s+|the\s+)?(?:[Vv]erse|[Vv]erset)[\s,]+(\d{1,3})\b/gu

// The lookbehind here excludes a "verse M"/"verset M" that is really the
// tail of a "chapter N, verse M" phrase already claimed by the pattern
// above — without it, one utterance like "chapter 9, verse 3" would
// produce BOTH a goto-bare-chapter-verse AND a redundant goto-bare-verse
// command for the same resolved reference. Comma-tolerant, same reasoning
// as every pattern above; "le verset"/"the verse" needs no explicit
// handling here — the keyword match itself has no anchor to the start of
// the phrase, so "le "/"the " before it was already ignored harmlessly.
const BARE_VERSE_PATTERN =
  /(?<!\b(?:[Cc]hapter|[Cc]hapitre)[\s,]+\d{1,3}[,]?\s)\b(?:[Vv]erse|[Vv]erset)[\s,]+(\d{1,3})\b/gu

// PROD AUDIT 2026-09: "<Book> N" without any "chapitre"/"chapter" keyword —
// e.g. the production case "Daniel 8", repeated 3 times and previously
// invisible even to the near-miss log (no keyword in the text). Must NOT
// collide with RegexDetector's "Book N:M" reference pattern: the (?!\s*:) /
// (?![\p{L}\d]) guards ensure "Daniel 8:1" is left to RegexDetector. The
// number alone must not be a bare chapter/verse continuation (a following
// "verset M" would be claimed by BOOK_CHAPTER_VERSE_PATTERN / BARE_VERSE).
// CORRECTIF (2026-09-23, live-observed): comma-tolerant book/number
// separator, plus "le verset"/"the verse" in the trailing exclusion — same
// reasoning as every pattern above.
const BOOK_BARE_CHAPTER_PATTERN =
  /(?<![\p{L}\d])((?:[123]\s+)?\p{L}[\p{L}]+)[\s,]+(\d{1,3})(?!\s*:)(?![\p{L}\d])(?!\s*,?\s*(?:le\s+|the\s+)?(?:[Vv]erse|[Vv]erset)\b)/gu

// PROD AUDIT 2026-09: near-miss guard helper for AppCore. True if any word
// in the text normalizes to a catalog book name — lets the near-miss log
// fire for book mentions with NO chapitre/verset keyword at all ("Daniel 8"
// before the pattern above existed). Lives here (not inlined in AppCore)
// so all book-name knowledge stays inside the detector module.
export function containsCatalogBookName(text: string): boolean {
  const words = text.split(/[^\p{L}\d]+/u).filter(Boolean)
  return words.some((w) => {
    const book = normalizeBookName(w)
    return BOOK_CATALOG.some((b: { readonly id: string }) => b.id === book)
  })
}

function normalizeUtterance(text: string): string {
  return stripAccents(text.trim().replace(/\s+/g, " ").toLowerCase())
}

// Real ASR transcripts punctuate short spoken commands ("Cancel.", "Next!"),
// so the whole-utterance exact-match needs to tolerate trailing
// sentence-ending punctuation. Substring matching doesn't need this — a
// trailing period after "next verse" is already inside a longer string
// that .includes() matches regardless.
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?,;:]+$/, "")
}

export class NavigationCommandDetector implements INavigationCommandDetector {
  detect(text: string): NavigationCommand[] {
    const commands: NavigationCommand[] = []
    const normalized = normalizeUtterance(text)
    const normalizedWhole = stripTrailingPunctuation(normalized)

    for (const rule of SUBSTRING_RULES) {
      if (normalized.includes(rule.phrase)) commands.push(rule.command)
    }
    for (const rule of WHOLE_UTTERANCE_RULES) {
      if (normalizedWhole === rule.phrase) commands.push(rule.command)
    }

    for (const match of text.matchAll(GOTO_CHAPTER_PATTERN)) {
      const rawBook = match[1]
      const rawChapter = match[2]
      if (!rawBook || !rawChapter) continue
      const book = normalizeBookName(rawBook)
      // TASK 2: only accept if the normalized book name exists in the catalog.
      // This replaces the \p{Lu} capitalization check — "jean" passes because
      // normalizeBookName("jean") -> "john" which is in BOOK_CATALOG; "to" fails
      // because "to" is not a book. STOPWORDS from RegexDetector are NOT reused
      // here because the catalog itself is the authority.
      if (!BOOK_CATALOG.some((b: { readonly id: string }) => b.id === book)) continue
      commands.push({
        kind: "goto-chapter",
        book,
        chapter: Number.parseInt(rawChapter, 10),
      })
    }

    // TASK 1: book + chapter + verse in prose form ("Jean chapitre 3 verset 16",
    // "John chapter 3 verse 16"). Runs before bare patterns so the bare patterns'
    // negative lookbehinds (which exclude a capitalized book-like word) don't
    // suppress it. Book name is validated via normalizeBookName() which checks
    // BOOK_CATALOG (TASK 2) — this replaces the fragile \p{Lu} capitalization
    // heuristic with a real catalog lookup.
    type MatchSpan = { start: number; end: number }
    const usedSpans: MatchSpan[] = []

    function spanOverlaps(newSpan: MatchSpan, existingSpans: MatchSpan[]): boolean {
      return existingSpans.some(s => newSpan.start < s.end && s.start < newSpan.end)
    }

    for (const match of text.matchAll(BOOK_CHAPTER_VERSE_PATTERN)) {
      const rawBook = match[1]
      const rawChapter = match[2]
      const rawVerse = match[3]
      if (!rawBook || !rawChapter || !rawVerse) continue
      const book = normalizeBookName(rawBook)
      // TASK 2: only accept if the normalized book name exists in the catalog.
      // This replaces the \p{Lu} capitalization check — "jean" passes because
      // normalizeBookName("jean") -> "john" which is in BOOK_CATALOG; "to" fails
      // because "to" is not a book. STOPWORDS from RegexDetector are NOT reused
      // here because the catalog itself is the authority.
      if (!BOOK_CATALOG.some((b: { readonly id: string }) => b.id === book)) continue
      const span: MatchSpan = { start: match.index!, end: match.index! + match[0].length }
      if (spanOverlaps(span, usedSpans)) continue
      usedSpans.push(span)
      commands.push({
        kind: "goto-book-chapter-verse",
        book,
        chapter: Number.parseInt(rawChapter, 10),
        verse: Number.parseInt(rawVerse, 10),
      })
    }

    for (const match of text.matchAll(BARE_CHAPTER_VERSE_PATTERN)) {
      const rawChapter = match[1]
      const rawVerse = match[2]
      if (!rawChapter || !rawVerse) continue
      const chapter = Number.parseInt(rawChapter, 10)
      const verse = Number.parseInt(rawVerse, 10)
      // De-duplicate by span overlap, not value equality — a repeated utterance
      // of the same reference later in the transcript is a distinct occurrence
      // and should produce a separate command (Task 0 regression).
      const span: MatchSpan = { start: match.index!, end: match.index! + match[0].length }
      if (spanOverlaps(span, usedSpans)) continue
      usedSpans.push(span)
      commands.push({
        kind: "goto-bare-chapter-verse",
        chapter,
        verse,
      })
    }

    for (const match of text.matchAll(BARE_VERSE_PATTERN)) {
      const rawVerse = match[1]
      if (!rawVerse) continue
      const verse = Number.parseInt(rawVerse, 10)
      // De-duplicate by span overlap, not value equality.
      const span: MatchSpan = { start: match.index!, end: match.index! + match[0].length }
      if (spanOverlaps(span, usedSpans)) continue
      usedSpans.push(span)
      commands.push({ kind: "goto-bare-verse", verse })
    }

    // PROD AUDIT 2026-09: "<Book> N" without "chapitre" — the production
    // case "Daniel 8". Runs LAST so keyword-bearing patterns claim their
    // spans first, and so its spans can't suppress them. Catalog-validated
    // like every other book pattern here.
    for (const match of text.matchAll(BOOK_BARE_CHAPTER_PATTERN)) {
      const rawBook = match[1]
      const rawChapter = match[2]
      if (!rawBook || !rawChapter) continue
      const book = normalizeBookName(rawBook)
      if (!BOOK_CATALOG.some((b: { readonly id: string }) => b.id === book)) continue
      const span: MatchSpan = { start: match.index!, end: match.index! + match[0].length }
      if (spanOverlaps(span, usedSpans)) continue
      usedSpans.push(span)
      commands.push({
        kind: "goto-chapter",
        book,
        chapter: Number.parseInt(rawChapter, 10),
      })
    }

    return commands
  }
}
