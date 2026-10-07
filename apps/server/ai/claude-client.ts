import { scrubSecrets } from "../../../packages/shared/logger"

/**
 * The single place that knows how to talk to Anthropic's Messages API
 * (ARCHITECTURE.md section 121). A thin fetch adapter, no SDK: the three AI
 * helpers (reference repair, bilingual notes, translation) depend on the
 * small `TextCompleter` interface below, never on this class or on Anthropic.
 *
 * Every call is bounded (timeout, max tokens) and fails soft: a rejected
 * promise is the helper's problem to ignore, never the live pipeline's.
 */

export interface TextCompleter {
  complete(request: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<string>
}

export type ClaudeClientOptions = {
  readonly apiKey: string
  /** Fast and cheap by default: these calls sit next to live speech. */
  readonly model?: string
  readonly url?: string
  readonly fetchImpl?: typeof fetch
}

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const DEFAULT_URL = "https://api.anthropic.com/v1/messages"
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_TOKENS = 300

export class ClaudeClient implements TextCompleter {
  private readonly apiKey: string
  private readonly model: string
  private readonly url: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ClaudeClientOptions) {
    if (!options.apiKey.trim()) throw new Error("ClaudeClient requires an apiKey")
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL
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
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Claude request failed (${response.status})`)
      const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> }
      const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
      return text.trim()
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Claude request timed out")
      throw new Error(scrubSecrets(error instanceof Error ? error.message : String(error)))
    } finally {
      clearTimeout(timer)
    }
  }
}

/** A calls-per-minute ceiling so an AI helper can never run away on cost or rate limits. */
export class CallBudget {
  private readonly stamps: number[] = []
  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {}

  tryTake(): boolean {
    const cutoff = this.now() - 60_000
    while (this.stamps.length > 0 && (this.stamps[0] as number) < cutoff) this.stamps.shift()
    if (this.stamps.length >= this.perMinute) return false
    this.stamps.push(this.now())
    return true
  }
}
