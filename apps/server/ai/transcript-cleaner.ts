import type { TextCompleter } from "./claude-client"

/**
 * AI feature 1 (ARCHITECTURE.md section 123): correct ASR recognition errors in
 * one FINAL sentence (book names, numbers, accents, French/English confusions)
 * so the deterministic detector gets a second chance at it.
 *
 * The result is a CANDIDATE only. AppCore feeds it through RegexDetector,
 * KnownValidVerseIndex and the verse source, and anything found only because of
 * the correction is a pending suggestion, never shown by itself. The original
 * transcript stays the source of truth: the cleaned text is never broadcast.
 */

export const CLEANUP_TIMEOUT_MS = 3_000
const MAX_INPUT_CHARS = 400

const SYSTEM_PROMPT = [
  "You correct speech-to-text errors in one sentence from a church service (French and English, sometimes mixed).",
  "Fix ONLY recognition mistakes: misheard Bible book names (e.g. 'Corentin' -> 'Corinthiens'), numbers, accents and spelling, and words that were recognised in the wrong language.",
  "Never add, remove, reorder or translate content. Never add a Bible reference, chapter or verse that the speaker did not say.",
  "If the sentence is already correct, repeat it unchanged.",
  "Output the corrected sentence only: one line, no quotes, no notes.",
].join("\n")

export class TranscriptCleaner {
  constructor(private readonly completer: TextCompleter, private readonly timeoutMs: number = CLEANUP_TIMEOUT_MS) {}

  /** Returns the corrected sentence, or null when there is nothing usable (unchanged, timed out, implausible). */
  async clean(text: string): Promise<string | null> {
    const original = text.trim().slice(0, MAX_INPUT_CHARS)
    if (!original) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("transcript cleanup timed out")), this.timeoutMs)
    })
    try {
      // The race (not only the client's abort) guarantees the bound for any completer.
      const call = this.completer.complete({ system: SYSTEM_PROMPT, user: original, maxTokens: 160, timeoutMs: this.timeoutMs })
      // If the timeout wins, a late rejection of the abandoned call must not become an unhandled rejection.
      call.catch(() => undefined)
      const answer = await Promise.race([call, timeout])
      return acceptCleanedText(original, answer)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** Sanity checks on the model's answer; anything doubtful is treated as "no correction". */
export function acceptCleanedText(original: string, answer: string): string | null {
  const cleaned = answer.trim().replace(/^["'«“]\s*|\s*["'»”]$/g, "").trim()
  if (!cleaned || /[\r\n]/.test(cleaned)) return null
  if (cleaned === original.trim()) return null
  const before = original.trim().split(/\s+/).length
  const after = cleaned.split(/\s+/).length
  if (after < before * 0.5 || after > before * 1.6 + 1) return null
  return cleaned
}

/** Cheap gate: only a sentence that could carry a reference is worth a model call. */
export function looksReferenceRelated(text: string, containsBookName: (text: string) => boolean): boolean {
  return /chapitre|chapter|verset|verse|\d/i.test(text) || containsBookName(text)
}
