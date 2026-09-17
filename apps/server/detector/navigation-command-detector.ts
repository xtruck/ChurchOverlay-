import type { NavigationCommand, NavigationCommandDetector as INavigationCommandDetector } from "../../../packages/contracts"
import { normalizeBookName } from "./regex-detector"

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

const SUBSTRING_RULES: readonly SubstringRule[] = [
  { phrase: "next verse", command: { kind: "next-verse" } },
  { phrase: "previous verse", command: { kind: "previous-verse" } },
  { phrase: "go back", command: { kind: "previous-verse" } },
  { phrase: "next chapter", command: { kind: "next-chapter" } },
  { phrase: "previous chapter", command: { kind: "previous-chapter" } },
  { phrase: "clear the screen", command: { kind: "cancel" } },
  // ARCHITECTURE.md section 65.4 — a spoken display-mode switch. Longer,
  // specific phrases match as a substring, same reasoning as every other
  // substring rule above.
  { phrase: "switch to english", command: { kind: "goto-display-mode", mode: "english" } },
  { phrase: "english only", command: { kind: "goto-display-mode", mode: "english" } },
  { phrase: "switch to french", command: { kind: "goto-display-mode", mode: "french" } },
  { phrase: "french only", command: { kind: "goto-display-mode", mode: "french" } },
  { phrase: "switch to bilingual", command: { kind: "goto-display-mode", mode: "bilingual" } },
]

const WHOLE_UTTERANCE_RULES: readonly WholeUtteranceRule[] = [
  { phrase: "next", command: { kind: "next-verse" } },
  { phrase: "previous", command: { kind: "previous-verse" } },
  { phrase: "cancel", command: { kind: "cancel" } },
  { phrase: "clear", command: { kind: "cancel" } },
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
// case-SENSITIVE for that check to mean anything; only the literal word
// "chapter" itself needs to tolerate case, so it's spelled out instead of
// relying on a pattern-wide /i.
const GOTO_CHAPTER_PATTERN =
  /\b((?:[123]\s+)?[A-Z][A-Za-z]+)\s+[Cc]hapter\s+(\d{1,3})\b(?!:\d)(?!\s*,?\s*[Vv]erse\b)/g

// ARCHITECTURE.md section 65.1: elliptical/continuation references —
// "verse 16" or "chapter 9, verse 3" said after a book/chapter was already
// established, resolved against currentPosition (resolveNavigationCommand)
// rather than a stated book. Deliberately NOT case-insensitive as a whole
// pattern (unlike GOTO_CHAPTER_PATTERN): the negative lookbehind needs
// `[A-Z]` to mean "an actual capitalized word" (a real book-name
// candidate), which an /i flag would defeat by also matching lowercase —
// so the command words themselves are spelled out in both cases instead.
//
// The lookbehind requires NO capitalized book-like word (optionally
// numeral-prefixed, matching GOTO_CHAPTER_PATTERN's own book-name shape)
// immediately before "chapter" — otherwise "Romans chapter 9, verse 3"
// would be wrongly captured as a bare continuation using whatever book
// happens to be current, silently discarding the book the speaker
// actually said.
const BARE_CHAPTER_VERSE_PATTERN =
  /(?<!\b(?:[123]\s+)?[A-Z][A-Za-z]+\s)\b[Cc]hapter\s+(\d{1,3})[,]?\s+[Vv]erse\s+(\d{1,3})\b/g

// The lookbehind here excludes a "verse M" that is really the tail of a
// "chapter N, verse M" phrase already claimed by the pattern above —
// without it, one utterance like "chapter 9, verse 3" would produce BOTH
// a goto-bare-chapter-verse AND a redundant goto-bare-verse command for
// the same resolved reference.
const BARE_VERSE_PATTERN = /(?<!\b[Cc]hapter\s+\d{1,3}[,]?\s)\b[Vv]erse\s+(\d{1,3})\b/g

function normalizeUtterance(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
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
      commands.push({
        kind: "goto-chapter",
        book: normalizeBookName(rawBook),
        chapter: Number.parseInt(rawChapter, 10),
      })
    }

    for (const match of text.matchAll(BARE_CHAPTER_VERSE_PATTERN)) {
      const rawChapter = match[1]
      const rawVerse = match[2]
      if (!rawChapter || !rawVerse) continue
      commands.push({
        kind: "goto-bare-chapter-verse",
        chapter: Number.parseInt(rawChapter, 10),
        verse: Number.parseInt(rawVerse, 10),
      })
    }

    for (const match of text.matchAll(BARE_VERSE_PATTERN)) {
      const rawVerse = match[1]
      if (!rawVerse) continue
      commands.push({ kind: "goto-bare-verse", verse: Number.parseInt(rawVerse, 10) })
    }

    return commands
  }
}
