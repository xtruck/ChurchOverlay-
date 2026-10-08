import type { TextCompleter } from "./claude-client"

/**
 * AI helper 3 (ARCHITECTURE.md section 121): a French<->English translation of
 * what was just said, for the operator's "Heard" strip and the stage monitor.
 * Display text only: nothing downstream reads it, and it never reaches the
 * verse detector or the congregation overlay.
 */

export type TranslationLanguage = "fr" | "en"

const NAME: Record<TranslationLanguage, string> = { fr: "French", en: "English" }

export class LiveTranslator {
  constructor(private readonly completer: TextCompleter) {}

  async translate(text: string, from: TranslationLanguage, to: TranslationLanguage): Promise<string | null> {
    if (from === to) return null
    const answer = await this.completer.complete({
      system: [
        `Translate church-service speech from ${NAME[from]} to ${NAME[to]}.`,
        "Output only the translation, one short sentence or two, no quotes, no notes.",
        "Keep Bible book names and chapter/verse numbers in their usual form in the target language.",
        "If the input is not meaningful speech, output nothing.",
      ].join("\n"),
      user: text.slice(0, 600),
      maxTokens: 200,
      timeoutMs: 6_000,
    })
    const cleaned = answer.trim()
    return cleaned.length > 0 && cleaned.length <= 800 ? cleaned : null
  }
}
