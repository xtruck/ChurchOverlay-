import type { TextCompleter } from "./claude-client"

/**
 * AI helper 2 (ARCHITECTURE.md section 121): live sermon notes in BOTH
 * languages. Implements the same minimal `summarize(text)` surface AppCore
 * already uses for the Groq notes generator (section 65.7), so it simply
 * replaces it when an Anthropic key is configured. Read-only observer of the
 * final-transcript stream: it never feeds the guarded verse pipeline.
 */

const SYSTEM_PROMPT = [
  "You take live notes for a church service. The speaker may be English with a French interpreter, or French, or mixed.",
  "From the transcript below write concise bullet-point notes of the key points made.",
  "Write each point in French first, then the same point in English after ' / ', on one line starting with '- '.",
  "List any Bible verses cited at the end under a line 'Versets / Verses:'.",
  "Ignore filler, repetition (the interpreter repeating the preacher) and transcription noise. Do not invent content.",
].join("\n")

export class ClaudeSermonNotes {
  constructor(private readonly completer: TextCompleter) {}

  async summarize(transcriptText: string): Promise<string> {
    return this.completer.complete({
      system: SYSTEM_PROMPT,
      user: transcriptText.slice(-6_000),
      maxTokens: 500,
      timeoutMs: 20_000,
    })
  }
}
