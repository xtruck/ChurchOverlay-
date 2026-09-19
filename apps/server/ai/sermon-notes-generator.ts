const DEFAULT_URL = "https://api.groq.com/openai/v1/chat/completions"
// ARCHITECTURE.md section 71: live testing surfaced a real
// "does not exist or you do not have access to it" error from Groq for
// llama-3.3-70b-versatile on a real API key, even though Groq's own docs
// still list it as a current production model — consistent with
// account/key-tier gating on the larger model, not a wrong or deprecated
// model id. Defaulting to the smallest production Llama model instead:
// far more likely to be available on any Groq key regardless of tier,
// and more than capable for a 3-5 bullet-point summarization task, which
// doesn't need a 70B model's capacity.
const DEFAULT_MODEL = "llama-3.1-8b-instant"

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
      throw new Error(
        extractGroqErrorMessage(errorBody) ?? `Groq chat completion failed with status ${response.status}`
      )
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
