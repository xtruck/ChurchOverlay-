import { scrubSecrets } from "../../../packages/shared/logger"
import type { TextCompleter } from "./claude-client"

/**
 * The free-tier alternative to ClaudeClient (ARCHITECTURE.md section 128): the
 * same `TextCompleter` interface over Groq's OpenAI-compatible chat endpoint, so
 * the AI helpers cannot tell the two apart. It reuses the Groq API key the app
 * already holds for transcription; no second account is needed.
 *
 * A thin fetch adapter, no SDK. Every call is bounded (timeout, max tokens) and
 * fails soft: a rejected promise is the helper's problem to ignore, never the
 * live pipeline's. Errors never carry the key (scrubSecrets).
 *
 * Quality note: small free models are weaker than Claude at strict JSON. That
 * costs suggestions, never correctness: every parser is strict and every
 * proposal still goes through the detector, the known-valid index and the verse
 * source before it can even be offered.
 */

export type GroqTextClientOptions = {
  readonly apiKey: string
  /** Small and fast by default: these calls sit next to live speech and share a free quota. */
  readonly model?: string
  readonly url?: string
  readonly fetchImpl?: typeof fetch
}

export const DEFAULT_GROQ_TEXT_MODEL = "llama-3.1-8b-instant"
const DEFAULT_URL = "https://api.groq.com/openai/v1/chat/completions"
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_TOKENS = 300

export class GroqTextClient implements TextCompleter {
  private readonly apiKey: string
  private readonly model: string
  private readonly url: string
  private readonly fetchImpl: typeof fetch

  constructor(options: GroqTextClientOptions) {
    if (!options.apiKey.trim()) throw new Error("GroqTextClient requires an apiKey")
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_GROQ_TEXT_MODEL
    this.url = options.url ?? DEFAULT_URL
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async complete(request: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          // Corrections and proposals must be repeatable, not creative.
          temperature: 0,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Groq text request failed (${response.status})`)
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = body.choices?.[0]?.message?.content
      return typeof content === "string" ? content.trim() : ""
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Groq text request timed out")
      throw new Error(scrubSecrets(error instanceof Error ? error.message : String(error)))
    } finally {
      clearTimeout(timer)
    }
  }
}
