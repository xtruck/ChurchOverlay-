const DEFAULT_URL = "https://api.groq.com/openai/v1/chat/completions"
// AUDIT CORRECTION 2026-09: the earlier claim that llama-3.1-8b-instant was
// "decommissioned 2026-08-16" is FALSE and has been removed. Verified
// against Groq's own live docs: llama-3.1-8b-instant is still listed under
// Production Models, and the deprecations page's most recent entry is
// March 2025 — there is no August 2026 entry at all.
//
// The real, verified reason to prefer openai/gpt-oss-20b: on the current
// Supported Models page both Llama entries are now labelled "Enterprise"
// with "Contact Sales" pricing and no published rate limits
// (llama-3.1-8b-instant and llama-3.3-70b-versatile), whereas
// openai/gpt-oss-20b is a Production model with published developer-plan
// pricing ($0.075/$0.30 per 1M tokens) and rate limits (250K TPM / 1K RPM).
// That is consistent with the originally-observed real error on a normal
// API key — "does not exist or you do not have access to it" — which is an
// access/tier error on a contact-sales model, not a deprecation.
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
    // identical requests in ~9 minutes against an unavailable model — a
    // request storm AGENTS.md section 37 forbids. A model that does not
    // exist / is not accessible on this key can never succeed on retry, so
    // the first such error disables this generator for the rest of the
    // session (a restart re-enables it, e.g. after a model change).
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

// PROD AUDIT 2026-09: matches the error wordings Groq actually returns for
// a model that is unavailable to this key — "model_decommissioned" (the
// code Groq has used for retired models), "model ... does not exist", and
// the access/tier wording "does not exist or you do not have access to it"
// observed in production. Note: Groq's Error Codes page documents only HTTP
// statuses plus a generic {message, type} object — the individual error
// codes below are matched on message text, which is why the check is
// deliberately narrow and substring-based.
// Deliberately NOT tripped by transient failures: 429/5xx must keep
// retrying normally, so the message must mention the model or decommission.
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
