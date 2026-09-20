const DEFAULT_URL = "https://api.groq.com/openai/v1/chat/completions"
// PROD AUDIT 2026-09: llama-3.1-8b-instant was DECOMMISSIONED by Groq on
// 2026-08-16 (console.groq.com/docs/deprecations). Groq's recommended
// replacement is openai/gpt-oss-20b — more than capable for a 3-5
// bullet-point summarization task, and available on every key tier.
// (Previous comment justified llama-3.1-8b-instant as "most likely to be
// available" — that reasoning is now obsolete; the model no longer exists.)
const DEFAULT_MODEL = "openai/gpt-oss-20b"

// Verified directly against Groq's real, current API documentation before
// writing this (https://console.groq.com/docs/api-reference#chat-create),
// the same "verify, don't assume" discipline this codebase's other
// external-API integrations already follow (GroqProvider's transcription
// endpoint, GetBibleVerseSource): endpoint, headers, request/response
// shape all confirmed, not guessed from general familiarity with
// OpenAI-compatible APIs.
const SYSTEM_PROMPT =
  "You summarize a live sermon transcript into 3-5 short bullet points capturing the main topics or points made, in the SAME language as the transcript (do not translate). Output ONLY the bullet points, one per line, each starting with \"- \". No headers, no commentary, no added Bible references beyond what the transcript itself already mentions."

export type SermonNotesGeneratorOptions = {
  readonly apiKey: string
  readonly model?: string
  readonly fetchImpl?: typeof fetch
  readonly url?: string
}

/**
 * ARCHITECTURE.md section 65.7: a strictly separate, dashboard-only side
 * channel — this class only ever answers "summarize this text," it never
 * touches VerseReference, KnownValidVerseIndex, or any part of the
 * hallucination-guard pipeline, and nothing it returns is ever treated as
 * verified content. Uses Groq's chat-completion API (the same provider/
 * API-key relationship already established for ASR, not a second AI
 * vendor), confirmed explicitly with the user.
 */
export class SermonNotesGenerator {
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly url: string
  // Circuit-breaker state: set once on a permanent model error, checked
  // at the top of every summarize() call. `undefined` = still active.
  private disabledReason: string | undefined

  constructor(options: SermonNotesGeneratorOptions) {
    if (!options.apiKey) {
      throw new Error("SermonNotesGenerator requires an apiKey")
    }
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.url = options.url ?? DEFAULT_URL
  }

  async summarize(transcriptText: string): Promise<string> {
    // PROD AUDIT 2026-09 circuit breaker: the production journal showed 7
    // identical requests in ~9 minutes against a decommissioned model — a
    // request storm AGENTS.md section 37 forbids. A model_decommissioned /
    // model-not-found error is PERMANENT: retrying can never succeed, so
    // the first one disables this generator for the rest of the session
    // (a restart re-enables it, e.g. after a config/model change).
    // Transient errors (network, rate limit, 5xx) keep retrying normally.
    if (this.disabledReason) {
      throw new Error(`SermonNotesGenerator disabled for this session: ${this.disabledReason}`)
    }

    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: transcriptText },
        ],
      }),
    })

    if (!response.ok) {
      const errorBody = await safeReadJson(response)
      const message =
        extractGroqErrorMessage(errorBody) ?? `Groq chat completion failed with status ${response.status}`
      if (isPermanentModelError(message)) {
        this.disabledReason = message
      }
      throw new Error(message)
    }

    const body = await safeReadJson(response)
    const content = extractMessageContent(body)
    if (typeof content !== "string") {
      throw new Error("Groq chat completion response did not include message content")
    }
    return content.trim()
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractGroqErrorMessage(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined
  const error = body.error
  if (!isPlainObject(error)) return undefined
  return typeof error.message === "string" ? error.message : undefined
}

// PROD AUDIT 2026-09: matches Groq's real error shapes for a model that
// no longer exists — "model_decommissioned" (the documented error code
// for a post-deprecation-date model) and the two message wordings Groq
// actually returns ("model ... does not exist" / "decommissioned").
// Deliberately narrow: a transient 429/5xx must NOT trip the breaker.
export function isPermanentModelError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("model_decommissioned") ||
    (lower.includes("model") && lower.includes("does not exist")) ||
    lower.includes("decommissioned")
  )
}

function extractMessageContent(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined
  const choices = body.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (!isPlainObject(first)) return undefined
  const message = first.message
  if (!isPlainObject(message)) return undefined
  return typeof message.content === "string" ? message.content : undefined
}
