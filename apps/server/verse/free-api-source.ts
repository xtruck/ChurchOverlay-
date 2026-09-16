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
 *
 * getVerse()'s contract (Promise<Verse | null>) only has room for two
 * outcomes, so this class draws a deliberate line matching the
 * conventional reading of that shape: `null` means "the service is
 * healthy and confirms this reference has no verse" (the CircuitBreaker
 * that will sit in front of this, per ARCHITECTURE.md section 21, must
 * never open just because a reference is legitimately missing) — a
 * *thrown* error means "something about the request or the service
 * itself failed," which the caller can feed to a CircuitBreaker as a real
 * failure. Concretely, observed directly against the live API (not
 * assumed): an unknown book reliably returns HTTP 404, which this class
 * treats as the "not found" case; a network failure, a non-404 error
 * status, or a 200 response whose body doesn't parse into the expected
 * shape are all treated as failures and thrown, not swallowed.
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
    } catch (err) {
      // Network failure (offline, DNS, timeout, ...): a real failure, not
      // "not found" — let the caller's circuit breaker see it.
      throw new Error(
        `FreeApiSource: network request failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (response.status === 404) {
      // The one status this API uses to mean "this reference has no
      // verse" — a healthy, confirmed negative, not a service failure.
      return null
    }
    if (!response.ok) {
      throw new Error(`FreeApiSource: unexpected HTTP status ${response.status}`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error("FreeApiSource: response body was not valid JSON")
    }

    const verse = parseVerseResponse(body, reference)
    if (!verse) {
      throw new Error("FreeApiSource: response was missing required verse fields")
    }
    return verse
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
