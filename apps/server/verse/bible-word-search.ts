import type { BibleSearchHit, Verse, VerseReference } from "../../../packages/contracts"
import type { OfflineBibleData } from "./offline-verse-source"
import { OFFLINE_BIBLE_BOOK_KEYS } from "./offline-bible-book-keys"
import { BOOK_CATALOG } from "./book-catalog"

/**
 * Search a verse by a few of its words (audit-notes/bible-browser.md, section 6). Operator
 * tool: "I only remember part of the text". Pure data lookup over the bundled Louis Segond
 * 1910 text (apps/server/verse/data/fra_lsg.json, public domain) the app already loads for the
 * offline fallback (ARCHITECTURE.md section 77) and the quote matcher: no model, no network,
 * no new dataset.
 *
 * Why not QuoteMatcher: that index fingerprints runs of 5 consecutive words and needs about 8
 * verbatim words to vote, deliberately strict because it listens to a live sermon. A person
 * typing "dieu a tant aimé" needs a plain inverted index with ranking.
 *
 * Output is always an existing verse's own reference, so a hit can be sent to the overlay as an
 * ordinary verse:override (which still goes through the KnownValidVerseIndex).
 */

export const FRENCH_SEARCH_TRANSLATION = "ls1910"
export const MAX_QUERY_LENGTH = 120
export const MIN_QUERY_LENGTH = 2
export const MAX_SEARCH_RESULTS = 20

const MAX_QUERY_TERMS = 12
const MAX_PREFIX_EXPANSION = 40
/** A word in more than this share of verses ("de", "et", "le") is only used to rank, never to find candidates. */
const COMMON_WORD_RATIO = 0.12

/**
 * Same folding as the quote matcher (accents and case removed) with one difference that matters
 * for search: an apostrophe SPLITS a word ("l'amour" -> "l", "amour"), so typing "amour" finds
 * "l'amour"; the quote matcher glues them because it compares speech to speech. One-letter
 * fragments are dropped (l, d, qu, j are noise).
 */
export function searchTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1)
}

export type WordSearchResult = {
  readonly hits: readonly BibleSearchHit[]
  readonly total: number
}

type QueryTerm = {
  /** vocabulary ids this term stands for (exact word, or the prefix expansion of the last word) */
  readonly ids: readonly number[]
  readonly idf: number
}

export class BibleWordSearch {
  private readonly vocab = new Map<string, number>()
  private readonly words: string[] = []
  /** vocabulary id -> verse ids containing it (ascending, distinct) */
  private readonly postings: number[][] = []
  private readonly references: VerseReference[] = []
  private readonly texts: string[] = []
  /** all verses' token ids back to back; verse i spans tokenStart[i] .. tokenStart[i+1] */
  private tokenIds: number[] = []
  private readonly tokenStart: number[] = [0]

  /** `populate: false` leaves it empty so buildAsync() can fill it in time slices. */
  constructor(private readonly data: OfflineBibleData, populate = true) {
    if (populate) for (const [reference, text] of BibleWordSearch.versesOf(data)) this.addVerse(reference, text)
  }

  /** Canonical order (BOOK_CATALOG, then chapter, then verse) so ties rank deterministically. */
  private static *versesOf(data: OfflineBibleData): Generator<[VerseReference, string]> {
    for (const book of BOOK_CATALOG) {
      const key = OFFLINE_BIBLE_BOOK_KEYS[book.id]
      const chapters = key ? data[key] : undefined
      if (!chapters) continue
      for (let chapter = 1; chapter <= book.chapters.length; chapter++) {
        const verses = chapters[String(chapter)]
        if (!verses) continue
        const numbers = Object.keys(verses)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1)
          .sort((a, b) => a - b)
        for (const verse of numbers) {
          const text = verses[String(verse)]
          if (typeof text === "string" && text.length > 0) yield [{ book: book.id, chapter, verse }, text]
        }
      }
    }
  }

  /** Same index as the constructor, but yields to the event loop every `sliceMs` (never stalls audio or WS). */
  static async buildAsync(data: OfflineBibleData, sliceMs = 15): Promise<BibleWordSearch> {
    const search = new BibleWordSearch(data, false)
    let sliceStart = performance.now()
    for (const [reference, text] of BibleWordSearch.versesOf(data)) {
      search.addVerse(reference, text)
      if (performance.now() - sliceStart >= sliceMs) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        sliceStart = performance.now()
      }
    }
    return search
  }

  /** Number of indexed verses (diagnostics). */
  get size(): number {
    return this.references.length
  }

  private addVerse(reference: VerseReference, text: string): void {
    const id = this.references.length
    this.references.push(reference)
    this.texts.push(text)
    const seen = new Set<number>()
    for (const token of searchTokens(text)) {
      let wordId = this.vocab.get(token)
      if (wordId === undefined) {
        wordId = this.words.length
        this.vocab.set(token, wordId)
        this.words.push(token)
        this.postings.push([])
      }
      this.tokenIds.push(wordId)
      if (!seen.has(wordId)) {
        seen.add(wordId)
        ;(this.postings[wordId] as number[]).push(id)
      }
    }
    this.tokenStart.push(this.tokenIds.length)
  }

  search(query: string, limit: number = MAX_SEARCH_RESULTS): WordSearchResult {
    const queryTokens = [...new Set(searchTokens(query.slice(0, MAX_QUERY_LENGTH)))].slice(0, MAX_QUERY_TERMS)
    if (queryTokens.length === 0 || this.references.length === 0) return { hits: [], total: 0 }
    const verseCount = this.references.length
    const unknownIdf = Math.log(1 + verseCount)

    const terms: QueryTerm[] = queryTokens.map((token, index) => {
      const exact = this.vocab.get(token)
      const ids: number[] = exact !== undefined ? [exact] : []
      // The word being typed right now: accept any word that starts with it.
      if (ids.length === 0 && index === queryTokens.length - 1 && token.length >= 3) {
        for (const [word, id] of this.vocab) {
          if (word.startsWith(token)) {
            ids.push(id)
            if (ids.length >= MAX_PREFIX_EXPANSION) break
          }
        }
      }
      if (ids.length === 0) return { ids: [], idf: unknownIdf }
      const df = ids.reduce((sum, id) => sum + (this.postings[id] as number[]).length, 0)
      return { ids, idf: Math.log(1 + verseCount / Math.max(1, df)) }
    })
    const findable = terms.filter((term) => term.ids.length > 0)
    if (findable.length === 0) return { hits: [], total: 0 }

    // Candidates come from the rare terms; common words only rank.
    let seeds = findable.filter((term) => this.docFrequency(term) <= COMMON_WORD_RATIO * verseCount)
    if (seeds.length === 0) seeds = [findable.reduce((best, term) => (this.docFrequency(term) < this.docFrequency(best) ? term : best))]
    const candidates = new Set<number>()
    for (const term of seeds) for (const id of term.ids) for (const verseId of this.postings[id] as number[]) candidates.add(verseId)

    const termsOfWord = new Map<number, number[]>()
    terms.forEach((term, termIndex) => {
      for (const id of term.ids) {
        const list = termsOfWord.get(id)
        if (list) list.push(termIndex)
        else termsOfWord.set(id, [termIndex])
      }
    })
    const totalIdf = terms.reduce((sum, term) => sum + term.idf, 0)
    const minMatched = Math.max(1, Math.ceil(terms.length * 0.5))

    const scored: Array<{ id: number; score: number }> = []
    for (const id of candidates) {
      const matched = new Set<number>()
      let previousTerm = -2
      let run = 0
      let longestRun = 0
      for (let i = this.tokenStart[id] as number; i < (this.tokenStart[id + 1] as number); i++) {
        const hitTerms = termsOfWord.get(this.tokenIds[i] as number)
        if (!hitTerms) {
          previousTerm = -2
          run = 0
          continue
        }
        for (const t of hitTerms) matched.add(t)
        const next = hitTerms.find((t) => t === previousTerm + 1)
        if (next !== undefined) {
          run += 1
          previousTerm = next
        } else {
          run = 1
          previousTerm = hitTerms[0] as number
        }
        longestRun = Math.max(longestRun, run)
      }
      if (matched.size < minMatched) continue
      let matchedIdf = 0
      for (const t of matched) matchedIdf += (terms[t] as QueryTerm).idf
      scored.push({ id, score: round(0.7 * (matchedIdf / totalIdf) + 0.3 * (longestRun / terms.length)) })
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id)

    const hits = scored.slice(0, Math.max(0, limit)).map<BibleSearchHit>(({ id, score }) => ({
      reference: this.references[id] as VerseReference,
      text: this.texts[id] as string,
      translation: FRENCH_SEARCH_TRANSLATION,
      score,
    }))
    return { hits, total: scored.length }
  }

  private docFrequency(term: QueryTerm): number {
    return term.ids.reduce((sum, id) => sum + (this.postings[id] as number[]).length, 0)
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * The only English text the app can search offline is whatever chapters were already read from
 * the live source this session (nothing English ships with the app). Same scoring scale (0..1) as
 * BibleWordSearch so results can be merged. French Louis Segond is skipped: the full-Bible index
 * above already covers it, and reporting it twice would only duplicate hits.
 */
export function searchLoadedChapters(
  query: string,
  chapters: ReadonlyArray<readonly Verse[]>,
  limit: number = MAX_SEARCH_RESULTS
): WordSearchResult {
  const queryTokens = [...new Set(searchTokens(query.slice(0, MAX_QUERY_LENGTH)))].slice(0, MAX_QUERY_TERMS)
  if (queryTokens.length === 0) return { hits: [], total: 0 }
  const weights = queryTokens.map((token) => 1 + Math.min(token.length, 8) / 8)
  const totalWeight = weights.reduce((sum, w) => sum + w, 0)
  const minMatched = Math.max(1, Math.ceil(queryTokens.length * 0.5))
  const lastIndex = queryTokens.length - 1

  const found: BibleSearchHit[] = []
  for (const chapter of chapters) {
    for (const verse of chapter) {
      const candidates: Array<{ text: string; translation: string }> = []
      if (verse.translation.toLowerCase() !== FRENCH_SEARCH_TRANSLATION) candidates.push({ text: verse.text, translation: verse.translation })
      if (verse.secondary && verse.secondary.translation.toLowerCase() !== FRENCH_SEARCH_TRANSLATION) {
        candidates.push({ text: verse.secondary.text, translation: verse.secondary.translation })
      }
      for (const candidate of candidates) {
        const words = searchTokens(candidate.text)
        const matched = new Set<number>()
        let previousTerm = -2
        let run = 0
        let longestRun = 0
        for (const word of words) {
          const term = queryTokens.findIndex((token, index) => word === token || (index === lastIndex && token.length >= 3 && word.startsWith(token)))
          if (term < 0) {
            previousTerm = -2
            run = 0
            continue
          }
          matched.add(term)
          run = term === previousTerm + 1 ? run + 1 : 1
          previousTerm = term
          longestRun = Math.max(longestRun, run)
        }
        if (matched.size < minMatched) continue
        let matchedWeight = 0
        for (const t of matched) matchedWeight += weights[t] as number
        found.push({
          reference: verse.reference,
          text: candidate.text,
          translation: candidate.translation,
          score: round(0.7 * (matchedWeight / totalWeight) + 0.3 * (longestRun / queryTokens.length)),
        })
      }
    }
  }
  found.sort((a, b) => b.score - a.score || compareReferences(a.reference, b.reference))
  return { hits: found.slice(0, Math.max(0, limit)), total: found.length }
}

const BOOK_ORDER = new Map(BOOK_CATALOG.map((book, index) => [book.id, index]))

function compareReferences(a: VerseReference, b: VerseReference): number {
  return (
    (BOOK_ORDER.get(a.book) ?? 99) - (BOOK_ORDER.get(b.book) ?? 99) || a.chapter - b.chapter || a.verse - b.verse
  )
}

/**
 * Builds the shared French index once per loaded data object, in the background (mirrors the
 * dashboard's lazyQuoteMatcher in apps/desktop/main): until it is ready `current()` is null and
 * the caller says "indexing" instead of "no results".
 */
export function createLazyBibleWordSearch(
  data: OfflineBibleData,
  onReady?: (info: { verses: number; durationMs: number }) => void,
  onError?: (error: unknown) => void
): LazyBibleWordSearch {
  // The bundled Bible never changes during the process: one index per data object, reused by service restarts.
  const existing = lazyIndexes.get(data)
  if (existing) return existing
  let ready: BibleWordSearch | null = null
  let failed = false
  let building = false
  let failedAt = 0
  const build = (): void => {
    if (building) return
    building = true
    failed = false
    const startedAt = performance.now()
    BibleWordSearch.buildAsync(data)
      .then((search) => {
        ready = search
        onReady?.({ verses: search.size, durationMs: Math.round(performance.now() - startedAt) })
      })
      .catch((err: unknown) => {
        failed = true
        failedAt = Date.now()
        onError?.(err)
      })
      .finally(() => {
        building = false
      })
  }
  const handle: LazyBibleWordSearch = {
    current: () => {
      if (!ready && !building && (!failed || Date.now() - failedAt >= RETRY_AFTER_FAILURE_MS)) {
        // A failed build is retried by a later search (at most once per cooldown), never forever in a loop.
        build()
      }
      return ready
    },
    failed: () => failed && !building,
  }
  lazyIndexes.set(data, handle)
  return handle
}

const RETRY_AFTER_FAILURE_MS = 30_000

/** `failed()` is true after a build error until a retry succeeds: the caller reports "unavailable", not "indexing". */
export type LazyBibleWordSearch = { current(): BibleWordSearch | null; failed(): boolean }

const lazyIndexes = new WeakMap<object, LazyBibleWordSearch>()
