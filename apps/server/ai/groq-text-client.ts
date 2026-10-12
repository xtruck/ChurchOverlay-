import { scrubSecrets } from "../../../packages/shared/logger"
import type { TextCompleter } from "./claude-client"
import type { AiAvailability } from "./guarded-text-completer"

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

// Same model as SermonNotesGenerator. The Llama production entries on Groq's
// Supported Models page are enterprise-gated; on a normal developer key they
// answer 404 ("does not exist or you do not have access"), which silently
// disabled every AI helper (live log 2026-10-12). gpt-oss-20b has published
// developer-plan limits.
export const DEFAULT_GROQ_TEXT_MODEL = "openai/gpt-oss-20b"
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

  /**
   * One-time startup check that this key can use the configured model: it lists the
   * models the key may use and looks for ours. Spends no completion. Only a definitive
   * answer counts: a network error, a timeout or an unexpected body is "unknown", never
   * a failure, so a flaky connection at startup cannot switch the helpers off.
   */
  async checkAvailability(): Promise<AiAvailability> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(this.url.replace(/\/chat\/completions$/, "/models"), {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403) return "auth"
      if (!response.ok) return "unknown"
      const body = (await response.json()) as { data?: unknown }
      if (!Array.isArray(body.data)) return "unknown"
      const ids = body.data.flatMap((entry) =>
        typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
          ? [(entry as { id: string }).id]
          : []
      )
      if (ids.length === 0) return "unknown"
      return ids.includes(this.model) ? "ok" : "model-unavailable"
    } catch {
      // Documented: any failure to ask is "could not tell", reported as unknown to the caller.
      return "unknown"
    } finally {
      clearTimeout(timer)
    }
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
