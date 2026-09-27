/**
 * Which ASR provider carries live audio, decided once from the configured
 * keys and the operator's preference. Pure, so every combination is
 * unit-tested — including the Deepgram-only setup, which the setup screen
 * has always accepted but which used to crash at startup because a
 * GroqProvider was constructed unconditionally.
 *
 * - batch-first: Groq (Whisper, batch chunks) primary; Deepgram opens only
 *   on sustained Groq 429s.
 * - streaming-first: Deepgram (streaming, sub-second finals) primary; Groq
 *   takes over on any Deepgram connection failure. The fast path — real
 *   service recordings measured the Groq batch round-trip at p90 ≈ 3.3 s.
 */
export type AsrStrategy = "batch-first" | "streaming-first"

export const ASR_STRATEGIES: readonly AsrStrategy[] = ["batch-first", "streaming-first"]

export type AsrPlan =
  | { readonly kind: "groq-only" }
  | { readonly kind: "deepgram-only" }
  | { readonly kind: "failover"; readonly primary: "groq" | "deepgram"; readonly strategy: AsrStrategy }

export type AsrPlanInput = {
  readonly groqApiKey?: string
  readonly deepgramApiKey?: string
  /** Absent → streaming-first whenever both keys exist. */
  readonly preferred?: AsrStrategy
}

export function planAsr(input: AsrPlanInput): AsrPlan {
  const hasGroq = Boolean(input.groqApiKey?.trim())
  const hasDeepgram = Boolean(input.deepgramApiKey?.trim())
  if (!hasGroq && !hasDeepgram) throw new Error("A Groq or Deepgram API key is required.")
  if (!hasDeepgram) return { kind: "groq-only" }
  if (!hasGroq) return { kind: "deepgram-only" }
  const strategy = input.preferred ?? "streaming-first"
  return { kind: "failover", primary: strategy === "streaming-first" ? "deepgram" : "groq", strategy }
}

export type AsrProviderId = "groq" | "deepgram" | "local"

/**
 * The ordered fallback chain for a plan: first entry carries audio, each
 * next one takes over when the previous fails. The offline engine, when
 * installed and enabled, is always the last resort — slower and less
 * accurate than either cloud service, but it works with no internet.
 */
export function asrChain(plan: AsrPlan, localAvailable: boolean): AsrProviderId[] {
  const chain: AsrProviderId[] =
    plan.kind === "groq-only"
      ? ["groq"]
      : plan.kind === "deepgram-only"
        ? ["deepgram"]
        : plan.primary === "deepgram"
          ? ["deepgram", "groq"]
          : ["groq", "deepgram"]
  if (localAvailable) chain.push("local")
  return chain
}

/**
 * Deepgram fixes the language per connection and, unlike Whisper, has no
 * useful auto-detect for French preaching: with no language it transcribes
 * as English. Bilingual display is French-primary (ARCHITECTURE.md
 * section 63), so bilingual listens in French.
 */
export function deepgramLanguageFor(mode: "english" | "french" | "bilingual"): "en" | "fr" {
  return mode === "english" ? "en" : "fr"
}
