export type TranscriptFragment = {
  readonly text: string
  readonly timestamp: number
}

export type TranscriptAssemblerOptions = {
  /** Short window: any recent fragments with a digit and a chapter/verse word are joined. */
  readonly windowMs?: number
  readonly maxFragments?: number
  /**
   * Enables the long window. A preacher often says the book and chapter, goes
   * on for several seconds, then says "verse 2" (or the ASR simply cut the
   * sentence there). Fragments older than windowMs are only joined when the
   * older one is genuinely an OPEN reference (it ends on a book name, with or
   * without a chapter) and the new one opens with the missing part. Needs a
   * book-name test; without it the long window stays off.
   */
  readonly isBookWord?: (word: string) => boolean
  readonly extendedWindowMs?: number
  /** A bare trailing number ("2.") may only complete an open reference this recently. */
  readonly bareNumberWindowMs?: number
}

const VERSE_WORDS = new Set(["verset", "versets", "verse", "verses", "v"])
const CHAPTER_WORDS = new Set(["chapitre", "chapitres", "chapter", "chapters", "chap"])
/** Small words that sit between a book/chapter and its number, or before a completion. */
const FILLER_WORDS = new Set([
  "le", "la", "les", "au", "aux", "du", "de", "des", "dans", "en", "et", "puis", "donc", "alors", "euh", "ah",
  "the", "in", "at", "and", "then", "so", "uh", "um", "numero", "number", "n",
])

/** Lower-case, accent-free words, punctuation dropped. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

const isNumberToken = (word: string) => /^\d{1,3}$/.test(word)

type OpenKind = "book-chapter" | "book"

/**
 * Does this fragment END on an unfinished reference? "livre de Genesis 5",
 * "Corinthiens chapitre 5" (book + chapter, verse missing) or "dans le livre
 * de Corinthiens" (book only). A fragment that already carries a verse
 * ("Genesis 5 verset 2") is complete, not open.
 */
export function openReferenceKind(text: string, isBookWord: (word: string) => boolean): OpenKind | null {
  const words = wordsOf(text)
  // Only the last few words matter: a book name earlier in the sentence was followed by other talk.
  const start = Math.max(0, words.length - 6)
  for (let i = words.length - 1; i >= start; i--) {
    const word = words[i] as string
    if (!isBookWord(word)) continue
    const after = words.slice(i + 1)
    if (after.some((w) => VERSE_WORDS.has(w))) return null
    const core = after.filter((w) => !FILLER_WORDS.has(w) && !CHAPTER_WORDS.has(w))
    if (core.length === 0) return "book"
    if (core.length === 1 && isNumberToken(core[0] as string)) return "book-chapter"
    return null
  }
  return null
}

/** The part of a later fragment that can complete an open reference, if it opens with one. */
function completionKind(text: string): "verse" | "chapter" | "bare-number" | null {
  const words = wordsOf(text)
  let i = 0
  while (i < words.length && i < 3 && FILLER_WORDS.has(words[i] as string)) i++
  const first = words[i]
  if (first === undefined) return null
  if (VERSE_WORDS.has(first) && words.slice(i + 1, i + 3).some(isNumberToken)) return "verse"
  if (CHAPTER_WORDS.has(first) && words.slice(i + 1, i + 3).some(isNumberToken)) return "chapter"
  if (isNumberToken(first) && words.length === 1) return "bare-number"
  return null
}

/**
 * Keeps only a tiny, final-transcript window for references split by batch ASR.
 * It never authorizes a verse; callers still run the assembled text through
 * the normal detector, index, and Bible-source validation path.
 */
export class TranscriptAssembler {
  private readonly windowMs: number
  private readonly maxFragments: number
  private readonly isBookWord: ((word: string) => boolean) | undefined
  private readonly extendedWindowMs: number
  private readonly bareNumberWindowMs: number
  private fragments: TranscriptFragment[] = []

  constructor(options: TranscriptAssemblerOptions = {}) {
    this.windowMs = options.windowMs ?? 4000
    this.isBookWord = options.isBookWord
    this.extendedWindowMs = options.isBookWord ? (options.extendedWindowMs ?? 25_000) : 0
    this.bareNumberWindowMs = options.bareNumberWindowMs ?? 12_000
    // Room for a few chatty fragments between an open reference and its completion.
    this.maxFragments = options.maxFragments ?? (this.extendedWindowMs > 0 ? 8 : 3)
  }

  push(fragment: TranscriptFragment): string | null {
    const text = fragment.text.trim()
    if (!text) return null
    const horizon = Math.max(this.windowMs, this.extendedWindowMs)
    this.fragments = this.fragments.filter((item) => fragment.timestamp - item.timestamp <= horizon)
    const previous = this.fragments
    this.fragments = [...previous, { text, timestamp: fragment.timestamp }]
    while (this.fragments.length > this.maxFragments) this.fragments.shift()

    // The open-reference join is the specific one, so it goes first: the loose
    // short-window rule would otherwise return "chatter + verse 7" (no book) and
    // hide the real book said a few seconds earlier.
    return this.joinOpenReference(previous, text, fragment.timestamp) ?? this.joinShortWindow(fragment.timestamp)
  }

  reset(): void {
    this.fragments = []
  }

  /** The original behaviour: the last few fragments inside windowMs, if they look like a reference. */
  private joinShortWindow(now: number): string | null {
    const recent = this.fragments.filter((item) => now - item.timestamp <= this.windowMs).slice(-3)
    if (recent.length < 2) return null
    const combined = recent.map((item) => item.text).join(" ")
    if (!/\d/.test(combined)) return null
    if (!/(chapitre|chapter|verset|verse|:)/i.test(combined)) return null
    return combined
  }

  /** The long window: an older OPEN reference plus the new fragment that completes it. */
  private joinOpenReference(previous: readonly TranscriptFragment[], text: string, now: number): string | null {
    const isBookWord = this.isBookWord
    if (!isBookWord || this.extendedWindowMs <= 0) return null
    const completion = completionKind(text)
    if (!completion) return null
    // Newest open reference first: the closest one is the one the preacher means.
    for (let i = previous.length - 1; i >= 0; i--) {
      const older = previous[i] as TranscriptFragment
      const age = now - older.timestamp
      if (age > this.extendedWindowMs) break
      const kind = openReferenceKind(older.text, isBookWord)
      if (!kind) continue
      // "Genesis 5" + "verse 2" and "Corinthiens" + "chapter 5 verse 2" are unambiguous.
      if (completion === "verse" && kind !== "book-chapter") continue
      if (completion === "chapter" && kind !== "book") continue
      // A bare "2." after "Corentin 5": only soon after, and only after a book+chapter.
      if (completion === "bare-number" && (kind !== "book-chapter" || age > this.bareNumberWindowMs)) continue
      // Join just the open fragment and its completion, not the chatter in between.
      return `${older.text} ${text}`
    }
    return null
  }
}
