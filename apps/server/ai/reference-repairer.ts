import type { TextCompleter } from "./claude-client"

/**
 * AI helper 1 (ARCHITECTURE.md section 121): when the deterministic detector
 * finds nothing in a sentence that clearly talks about a passage (a near-miss:
 * "Jean trois, euh, seize" mangled by ASR), ask the model what reference was
 * probably meant.
 *
 * The answer is a CANDIDATE, never a fact: AppCore feeds it back through the
 * same detector, KnownValidVerseIndex and VerseSource as any spoken reference,
 * and the result is always a pending suggestion, never shown automatically
 * (ARCHITECTURE.md section 15: an LLM-proposed reference is never trusted).
 */

export type RepairedReference = { readonly book: string; readonly chapter: number; readonly verse: number }

const SYSTEM_PROMPT = [
  "You repair Bible references in noisy speech-to-text from a church service (French and English).",
  "Given one transcript sentence, decide whether the speaker announced ONE specific Bible verse that the transcript garbled.",
  "Answer with JSON only, no prose: {\"book\":\"<book name in French or English>\",\"chapter\":<int>,\"verse\":<int>}",
  "If the sentence does not announce a specific verse, or you are not confident, answer exactly {\"none\":true}.",
  "Never guess a verse from its content or from a quotation: only repair a reference the speaker actually announced.",
].join("\n")

export class ReferenceRepairer {
  constructor(private readonly completer: TextCompleter) {}

  async repair(text: string, onScreenBook?: string | null): Promise<RepairedReference | null> {
    const hint = onScreenBook ? `\nThe book currently on screen is: ${onScreenBook}.` : ""
    const answer = await this.completer.complete({
      system: SYSTEM_PROMPT,
      user: `Sentence: ${text.slice(0, 400)}${hint}`,
      maxTokens: 60,
      timeoutMs: 6_000,
    })
    return parseRepairedReference(answer)
  }
}

export function parseRepairedReference(answer: string): RepairedReference | null {
  const match = answer.match(/\{[^{}]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>
    if (parsed.none === true) return null
    const { book, chapter, verse } = parsed
    if (typeof book !== "string" || !book.trim() || book.length > 40) return null
    if (!Number.isInteger(chapter) || !Number.isInteger(verse)) return null
    if ((chapter as number) < 1 || (chapter as number) > 150 || (verse as number) < 1 || (verse as number) > 176) return null
    return { book: book.trim(), chapter: chapter as number, verse: verse as number }
  } catch {
    return null
  }
}
