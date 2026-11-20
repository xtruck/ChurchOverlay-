/**
 * Deepgram keyterm list building (architecture note
 * `architecture-notes/keyterms-follow-sermon.md`). Deepgram-only knowledge,
 * kept beside the adapter: nothing in the core imports this.
 *
 * Checked against developers.deepgram.com/docs/keyterm (2026-11):
 *  - a mid-stream `{"type":"Configure","keyterms":[...]}` REPLACES the whole
 *    list (Nova-3 on /v1/listen, monolingual and multilingual);
 *  - 500 tokens per list, up to 100 terms, 20-50 recommended;
 *  - an over-limit update is answered with `ConfigureFailure`
 *    (`CONFIGURE_KEYTERM_LIMIT_EXCEEDED`) and the stream keeps its old list;
 *  - commas or weights inside a keyterm do not error, they silently boost
 *    nothing (documented for the query string; assumed for Configure too).
 */

/** Deepgram's hard limit is 100 terms; this stays well inside it. */
export const MAX_KEYTERMS = 80
/** Deepgram's limit is 500 tokens per list; the estimate below is conservative, this leaves margin on top. */
export const MAX_KEYTERM_TOKENS = 400
/** A Bible book name or structural word is short; anything longer is not a term this app sends. */
export const MAX_KEYTERM_CHARS = 40

/**
 * Conservative token estimate for one keyterm: about 3 characters per token
 * for accented French/English names, plus one for the separator. Deepgram
 * does not publish its tokenizer; this over-counts rather than under-counts.
 */
export function estimateKeytermTokens(term: string): number {
  return Math.ceil(term.length / 3) + 1
}

/**
 * One keyterm made safe: NFC, no comma/semicolon/colon (a colon reads as a
 * weight, `term:2`, which nova-3 treats as a literal that boosts nothing),
 * no control characters or line breaks, whitespace collapsed, trimmed, and
 * at most MAX_KEYTERM_CHARS (an over-long term is rejected whole, never cut
 * mid-word). Returns null when nothing usable is left.
 */
export function sanitizeKeyterm(raw: string): string | null {
  if (typeof raw !== "string") return null
  const cleaned = raw
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length === 0 || cleaned.length > MAX_KEYTERM_CHARS) return null
  return cleaned
}

/**
 * The final list, in the order given (callers pass MOST relevant first, so
 * the budget drops the least relevant): sanitized, deduplicated
 * case-insensitively (first spelling kept), at most MAX_KEYTERMS terms and
 * MAX_KEYTERM_TOKENS estimated tokens. Deterministic.
 */
export function boundedKeyterms(candidates: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  let tokens = 0
  for (const candidate of candidates) {
    if (terms.length >= MAX_KEYTERMS) break
    const term = sanitizeKeyterm(candidate)
    if (term === null) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    const cost = estimateKeytermTokens(term)
    if (tokens + cost > MAX_KEYTERM_TOKENS) continue
    seen.add(key)
    terms.push(term)
    tokens += cost
  }
  return terms
}

/** Same SET of terms (Deepgram gives order no meaning, so a mere reorder is not a change worth a Configure). */
export function sameKeyterms(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((term) => set.has(term))
}
