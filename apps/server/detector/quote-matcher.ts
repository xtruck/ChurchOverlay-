import type { VerseReference } from "../../../packages/contracts"
import type { OfflineBibleData } from "../verse/offline-verse-source"
import { OFFLINE_BIBLE_BOOK_KEYS } from "../verse/offline-bible-book-keys"

/**
 * Recognizes a verse READ ALOUD without its reference being announced —
 * the gap real service recordings showed most often ("quote without an
 * explicit reference"). Deterministic word-sequence fingerprinting against
 * the bundled Louis Segond 1910 text; no model, no network.
 *
 * How: every verse is cut into overlapping runs of SHINGLE words (after
 * lower-casing, accent- and punctuation-stripping), each run hashed to a
 * 32-bit key. A transcript is cut the same way; a verse is a candidate
 * when enough of its runs appear, in order, and it clearly beats every
 * other verse. Because the output is always an existing verse's own
 * reference, it cannot hallucinate a reference — but it CAN recognise a
 * quotation the preacher did not intend to display, which is why AppCore
 * only ever offers a quote match as a pending suggestion for the operator
 * to confirm, never an automatic display.
 *
 * Only matches readings close to LSG 1910 wording; a paraphrase or another
 * translation (Semeur, Darby) is simply not recognised — a miss, never a
 * wrong verse.
 */
export type QuoteMatch = {
  readonly reference: VerseReference
  /** Distinct matched runs — each adds one more word of verbatim overlap. */
  readonly matchedRuns: number
  /** Fraction of the verse's own runs that were heard, 0..1. */
  readonly coverage: number
}

export type QuoteMatcherOptions = {
  /** Words per fingerprint run. 5 is long enough to be distinctive in the Bible's repetitive style. */
  readonly shingle?: number
  /** Minimum distinct runs heard (runs = SHINGLE + runs - 1 consecutive words). */
  readonly minRuns?: number
  /** Minimum share of the verse heard (short verses need most of their words). */
  readonly minCoverage?: number
  /** The winner must have at least this many times the runs of the runner-up. */
  readonly dominance?: number
}

const DEFAULT_SHINGLE = 5
const DEFAULT_MIN_RUNS = 4 // 8 consecutive verbatim words
const DEFAULT_MIN_COVERAGE = 0.35
const DEFAULT_DOMINANCE = 2

/** book key in fra_lsg.json -> catalog id (inverse of OFFLINE_BIBLE_BOOK_KEYS) */
const CATALOG_ID_BY_OFFLINE_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(OFFLINE_BIBLE_BOOK_KEYS).map(([catalogId, offlineKey]) => [offlineKey, catalogId])
)

export function quoteTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "") // "qu'il" and ASR's apostrophe-less "quil" fold to the same token
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

function hashRun(tokens: readonly string[], start: number, length: number): number {
  // FNV-1a over the joined run; collisions only ever add noise to a vote,
  // they can never produce a reference that does not exist.
  let hash = 0x811c9dc5
  for (let t = start; t < start + length; t++) {
    const word = tokens[t] as string
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 32
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export class QuoteMatcher {
  private readonly shingle: number
  private readonly minRuns: number
  private readonly minCoverage: number
  private readonly dominance: number
  /** run hash -> verse ids (one number, or an array when the run occurs in several verses) */
  private readonly index = new Map<number, number | number[]>()
  private readonly references: VerseReference[] = []
  private readonly runCounts: number[] = []

  constructor(data: OfflineBibleData, options: QuoteMatcherOptions = {}) {
    this.shingle = options.shingle ?? DEFAULT_SHINGLE
    this.minRuns = options.minRuns ?? DEFAULT_MIN_RUNS
    this.minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE
    this.dominance = options.dominance ?? DEFAULT_DOMINANCE
    for (const [offlineKey, chapters] of Object.entries(data)) {
      const book = CATALOG_ID_BY_OFFLINE_KEY[offlineKey]
      if (!book) continue
      for (const [chapter, verses] of Object.entries(chapters)) {
        for (const [verse, text] of Object.entries(verses)) {
          this.addVerse({ book, chapter: Number(chapter), verse: Number(verse) }, text)
        }
      }
    }
  }

  /** Number of indexed verses (diagnostics). */
  get size(): number {
    return this.references.length
  }

  private addVerse(reference: VerseReference, text: string): void {
    const tokens = quoteTokens(text)
    const id = this.references.length
    this.references.push(reference)
    const runs = Math.max(0, tokens.length - this.shingle + 1)
    this.runCounts.push(runs)
    const seen = new Set<number>()
    for (let i = 0; i < runs; i++) {
      const key = hashRun(tokens, i, this.shingle)
      if (seen.has(key)) continue
      seen.add(key)
      const existing = this.index.get(key)
      if (existing === undefined) this.index.set(key, id)
      else if (typeof existing === "number") this.index.set(key, [existing, id])
      else existing.push(id)
    }
  }

  match(transcript: string): QuoteMatch | null {
    const tokens = quoteTokens(transcript)
    if (tokens.length < this.shingle + this.minRuns - 1) return null
    const votes = new Map<number, number>()
    const seen = new Set<number>()
    for (let i = 0; i + this.shingle <= tokens.length; i++) {
      const key = hashRun(tokens, i, this.shingle)
      if (seen.has(key)) continue
      seen.add(key)
      const hit = this.index.get(key)
      if (hit === undefined) continue
      // A run shared by many verses ("et l'Eternel dit à Moïse") carries no signal.
      const ids = typeof hit === "number" ? [hit] : hit.length <= 3 ? hit : []
      for (const id of ids) votes.set(id, (votes.get(id) ?? 0) + 1)
    }
    let best = -1
    let bestVotes = 0
    for (const [id, count] of votes) {
      if (count > bestVotes || (count === bestVotes && id < best)) {
        best = id
        bestVotes = count
      }
    }
    // A reading often runs over into the next verse: the neighbours of the
    // winner sharing votes is expected, not ambiguity. Dominance is judged
    // only against verses that are NOT adjacent to it.
    let secondVotes = 0
    const bestRef = best >= 0 ? (this.references[best] as VerseReference) : null
    for (const [id, count] of votes) {
      if (id === best || !bestRef) continue
      const ref = this.references[id] as VerseReference
      const adjacent = ref.book === bestRef.book && ref.chapter === bestRef.chapter && Math.abs(ref.verse - bestRef.verse) <= 1
      if (!adjacent && count > secondVotes) secondVotes = count
    }
    if (best < 0 || bestVotes < this.minRuns) return null
    if (secondVotes > 0 && bestVotes < secondVotes * this.dominance) return null
    const coverage = bestVotes / Math.max(1, this.runCounts[best] as number)
    if (coverage < this.minCoverage) return null
    return { reference: this.references[best] as VerseReference, matchedRuns: bestVotes, coverage: Math.min(1, coverage) }
  }
}
