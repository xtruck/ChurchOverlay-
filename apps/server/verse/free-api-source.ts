import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"

/**
 * v1 VerseSource implementation (ARCHITECTURE.md section 16, section 50
 * third extension seam). Fetches verse text from bible-api.com — chosen
 * because it is genuinely free and requires no API key/registration
 * (verified directly against the live service, not assumed), which keeps
 * this seam usable without depending on a secret this codebase has no way
 * to obtain right now.
 *
 * Uses the "kjv" translation specifically because book-catalog.ts's
 * chapter/verse-count dataset is King James Version-based — using a
 * different default translation here could otherwise validate a
 * reference against one numbering scheme and fetch text under a subtly
 * different one.
 *
 * Every response is schema-validated before becoming a Verse
 * (ARCHITECTURE.md section 18: "HTTP success does not imply a valid verse
 * response... never render arbitrary fields from an external response").
 * Observed directly against the live API (not assumed): a bad reference
 * can come back as either a JSON `{"error": "..."}` body or a bare HTML
 * 404 page depending on the failure mode, so any non-OK status, and any
 * OK response whose body does not parse into the expected shape, is
 * treated as "no verse" rather than trusted.
 *
 * `fetchImpl` is injectable so unit tests never make a real network call
 * (AGENTS.md sections 32-33): only a dedicated integration test may hit
 * the live API.
 */
const DEFAULT_BASE_URL = "https://bible-api.com"
const V1_TRANSLATION = "kjv"

export class FreeApiSource implements VerseSource {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(fetchImpl: typeof fetch = fetch, baseUrl: string = DEFAULT_BASE_URL) {
    this.fetchImpl = fetchImpl
    this.baseUrl = baseUrl
  }

  async getVerse(reference: VerseReference): Promise<Verse | null> {
    const url = buildRequestUrl(this.baseUrl, reference)

    let response: Response
    try {
      response = await this.fetchImpl(url)
    } catch {
      // Network failure (offline, DNS, timeout, ...): no verse, not a crash.
      // The caller decides retry/circuit-breaker policy, not this class.
      return null
    }

    if (!response.ok) {
      return null
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      // HTTP 200 with a body that isn't even valid JSON: never trust it.
      return null
    }

    return parseVerseResponse(body, reference)
  }
}

function buildRequestUrl(baseUrl: string, reference: VerseReference): string {
  const book = encodeURIComponent(reference.book.trim())
  return `${baseUrl}/${book}+${reference.chapter}:${reference.verse}?translation=${V1_TRANSLATION}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseVerseResponse(body: unknown, reference: VerseReference): Verse | null {
  if (!isPlainObject(body)) return null

  const text = body.text
  const translation = body.translation_id

  if (typeof text !== "string" || text.trim().length === 0) return null
  if (typeof translation !== "string" || translation.trim().length === 0) return null

  return {
    reference,
    text: text.trim(),
    translation,
    source: "bible-api.com",
  }
}
