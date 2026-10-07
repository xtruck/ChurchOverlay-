import type { TextCompleter } from "./claude-client"
import { coerceReference, type RepairedReference } from "./reference-repairer"

/**
 * AI feature 2 (ARCHITECTURE.md section 124): propose the verse a speaker is
 * quoting or paraphrasing when no reference was cited. The asynchronous
 * counterpart of the deterministic detectors (VerseDetector is synchronous and
 * may not call APIs), kept next to ReferenceRepairer.
 *
 * The answer is a CANDIDATE: AppCore validates it with RegexDetector,
 * KnownValidVerseIndex and the verse source, and only ever offers it as a
 * pending suggestion, never as a displayed verse.
 */

export type SemanticProposal = RepairedReference & { readonly confidence: "high" }

const SYSTEM_PROMPT = [
  "You help a church operator who runs Bible verse slides. The text is a recent stretch of a live sermon (French or English) transcribed by speech-to-text.",
  "Decide whether the speaker is quoting or closely paraphrasing ONE specific Bible verse, without having named its reference.",
  "Answer with JSON only, no prose: {\"book\":\"<book name in French or English>\",\"chapter\":<int>,\"verse\":<int>,\"confidence\":\"high\"|\"medium\"|\"low\"}",
  "Use \"high\" only when the wording clearly matches that exact verse. If the speaker only discusses a theme, tells a story, gives an opinion, or you are unsure, answer exactly {\"none\":true}.",
  "Never answer because a topic merely sounds biblical.",
].join("\n")

export class SemanticVerseProposer {
  constructor(private readonly completer: TextCompleter) {}

  async propose(windowText: string, onScreenBook?: string | null): Promise<SemanticProposal | null> {
    const hint = onScreenBook ? `\nThe book currently on screen is: ${onScreenBook}.` : ""
    const answer = await this.completer.complete({
      system: SYSTEM_PROMPT,
      user: `Recent sermon text: ${windowText.slice(-900)}${hint}`,
      maxTokens: 80,
      timeoutMs: 8_000,
    })
    return parseSemanticProposal(answer)
  }
}

/** Strict: only an explicit "high" confidence on a plausible reference is a proposal at all. */
export function parseSemanticProposal(answer: string): SemanticProposal | null {
  const match = answer.match(/\{[^{}]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>
    if (parsed.none === true || parsed.confidence !== "high") return null
    const reference = coerceReference(parsed)
    return reference ? { ...reference, confidence: "high" } : null
  } catch {
    return null
  }
}
