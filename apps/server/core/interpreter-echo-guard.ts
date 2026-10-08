import type { VerseReference } from "../../../packages/contracts"

/**
 * Consecutive interpretation: an English preacher speaks and an interpreter
 * repeats it in French a few seconds later. The same verse is therefore
 * detected twice, in two languages. The first detection is the fast one and
 * must win; the interpreter's echo must not re-show (and re-start the
 * auto-clear timer of) a verse that was just displayed.
 *
 * Pure and clock-injectable: it only decides. AppCore stays the single place
 * that displays or suppresses (ARCHITECTURE.md section 120).
 *
 * The worst failure is hiding a verse the congregation should see, so every
 * ambiguity resolves to "show it".
 */

export type SpokenLanguage = "fr" | "en" | "unknown"

export type EchoDecision =
  | { readonly suppress: false }
  | { readonly suppress: true; readonly reason: "interpreter-echo" | "repeat"; readonly ageMs: number }

// Function words that exist in only one of the two languages. Words that are
// common in both ("a", "on", "in", "an", "to", "est", "par", "sur", "ce") are
// deliberately absent: "on a lu" is French, "a" and "on" are English.
const FRENCH_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "sont", "que", "qui", "dans", "pour",
  "avec", "nous", "vous", "ils", "au", "aux", "chapitre", "verset", "lisons", "ouvrons", "dit", "dieu",
  "seigneur", "mes", "ton", "votre", "notre", "cette", "ces",
])
const ENGLISH_WORDS = new Set([
  "the", "and", "of", "is", "are", "that", "who", "for", "with", "we", "you", "they",
  "chapter", "verse", "let", "read", "open", "says", "god", "lord", "my", "your", "our", "this",
  "these", "turn", "look",
])
// Book names that differ between the languages: a bare "Jean 3:16" has no
// other tell. They count double because they are the strongest signal.
const FRENCH_BOOKS = new Set([
  "jean", "psaume", "psaumes", "genèse", "matthieu", "apocalypse", "romains", "éphésiens", "galates",
  "hébreux", "jacques", "pierre", "ésaïe", "esaïe", "jérémie", "proverbes", "deutéronome", "exode",
  "lévitique", "nombres",
])
const ENGLISH_BOOKS = new Set([
  "john", "psalm", "psalms", "genesis", "matthew", "revelation", "romans", "ephesians", "galatians",
  "hebrews", "james", "peter", "isaiah", "jeremiah", "proverbs", "deuteronomy", "exodus", "leviticus",
  "numbers",
])
const BOOK_WEIGHT = 2
/** A language is only declared when it wins by at least this many votes. */
const MIN_MARGIN = 2

/**
 * A deliberately tiny weighted vote — enough to tell an English sentence from
 * a French one around a spoken reference. "unknown" (a bare number, a tie, a
 * narrow win) never counts as a language change, so ambiguity can only lead
 * to showing the verse, never to hiding one.
 */
export function guessSpokenLanguage(text: string): SpokenLanguage {
  let fr = 0
  let en = 0
  for (const word of text.toLowerCase().split(/[^a-zàâçéèêëîïôûùüÿœ']+/)) {
    if (!word) continue
    if (FRENCH_WORDS.has(word)) fr++
    if (ENGLISH_WORDS.has(word)) en++
    if (FRENCH_BOOKS.has(word)) fr += BOOK_WEIGHT
    if (ENGLISH_BOOKS.has(word)) en += BOOK_WEIGHT
  }
  if (Math.abs(fr - en) < MIN_MARGIN) return "unknown"
  return fr > en ? "fr" : "en"
}

type Seen = { time: number; language: SpokenLanguage }

export type InterpreterEchoGuardOptions = {
  readonly now?: () => number
  /** Window in which a different-language repeat is treated as the interpreter's echo, until the delay has been learned. */
  readonly initialEchoWindowMs?: number
  /** Same-language repeats (overlapping chunks, assembler recombination) inside this window are dropped. */
  readonly repeatWindowMs?: number
}

// Real interpreter delay is 5-20 s: keep the window tight so a deliberate
// return to the same verse is not hidden for long.
const MIN_ECHO_WINDOW_MS = 15_000
const MAX_ECHO_WINDOW_MS = 45_000
/** A "lag" longer than this is a deliberate return, not an echo: never learn from it. */
const MAX_LEARNABLE_LAG_MS = 30_000
const LEARNED_LAGS = 5

export class InterpreterEchoGuard {
  private readonly now: () => number
  private readonly repeatWindowMs: number
  private echoWindowMs: number
  private readonly seen = new Map<string, Seen>()
  private readonly lags: number[] = []

  constructor(options: InterpreterEchoGuardOptions = {}) {
    this.now = options.now ?? Date.now
    this.echoWindowMs = options.initialEchoWindowMs ?? 30_000
    this.repeatWindowMs = options.repeatWindowMs ?? 8_000
  }

  /** The current echo window, which tightens or widens to twice the slowest recently observed interpreter delay. */
  currentEchoWindowMs(): number {
    return this.echoWindowMs
  }

  /**
   * Forget everything seen. Called when the operator deliberately takes
   * control (manual show, manual clear, navigation): what they do next is
   * intentional and must never be mistaken for an echo.
   */
  forget(): void {
    this.seen.clear()
  }

  /**
   * Decide for a freshly detected verse. A non-suppressed verse is recorded
   * (it is about to be shown); a suppressed one leaves the original record
   * untouched, so a long run of echoes cannot keep a stale entry alive.
   */
  check(reference: VerseReference, transcriptText: string): EchoDecision {
    const now = this.now()
    const key = `${reference.book}|${reference.chapter}|${reference.verse}`
    const language = guessSpokenLanguage(transcriptText)
    const previous = this.seen.get(key)

    if (previous) {
      const ageMs = now - previous.time
      const differentLanguage =
        language !== "unknown" && previous.language !== "unknown" && language !== previous.language
      if (differentLanguage && ageMs <= this.echoWindowMs) {
        this.learn(ageMs)
        return { suppress: true, reason: "interpreter-echo", ageMs }
      }
      if (ageMs <= this.repeatWindowMs) {
        return { suppress: true, reason: "repeat", ageMs }
      }
    }

    this.seen.set(key, { time: now, language })
    this.prune(now)
    return { suppress: false }
  }

  private learn(lagMs: number): void {
    if (lagMs > MAX_LEARNABLE_LAG_MS) return
    this.lags.push(lagMs)
    if (this.lags.length > LEARNED_LAGS) this.lags.shift()
    const slowest = Math.max(...this.lags)
    this.echoWindowMs = Math.min(MAX_ECHO_WINDOW_MS, Math.max(MIN_ECHO_WINDOW_MS, slowest * 2))
  }

  private prune(now: number): void {
    for (const [key, entry] of this.seen) {
      if (now - entry.time > MAX_ECHO_WINDOW_MS) this.seen.delete(key)
    }
  }
}
