import type {
  BibleChapterRequestPayload,
  BibleChapterResultPayload,
  BibleSearchRequestPayload,
  BibleSearchResultPayload,
  VerseIndex,
  VerseSource,
  WsMessage,
} from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { BOOK_CATALOG } from "./book-catalog"
import {
  MAX_SEARCH_RESULTS,
  MIN_QUERY_LENGTH,
  searchLoadedChapters,
  searchTokens,
  type BibleWordSearch,
} from "./bible-word-search"
import { ChapterCache } from "./chapter-cache"
import { CircuitBreaker } from "./circuit-breaker"
import { resolveChapter } from "./resolve-chapter"
import { VerseCache } from "./verse-cache"

export type BibleBrowserDeps = {
  readonly index: VerseIndex
  readonly source: VerseSource
  readonly verseCache: VerseCache
  readonly chapterCache: ChapterCache
  readonly circuitBreaker: CircuitBreaker
  readonly logger: Logger
  /** The translation identity the verse cache is keyed by right now (display mode + translation). */
  readonly translationId: () => string
  /** Same book-id normalization as verse:override (quick entry, trim, lowercase). */
  readonly normalizeBook: (raw: string) => string
  /** Absent: this build has no bundled Bible to search. `current()` is null while the index is still being built. */
  readonly wordSearch?: { current(): BibleWordSearch | null; failed?(): boolean }
  /** Delivers an event to operator connections only (never viewers). */
  readonly reply: (type: "bible:chapter-result" | "bible:search-result", payload: unknown, correlationId?: string) => void
}

/**
 * Bible Browser server side (audit-notes/bible-browser.md). Read-only by construction: nothing
 * here can change what the congregation sees (no display ticket, no broadcast of verse:show).
 *
 * Each request kind coalesces like verse:preview (ARCHITECTURE.md section 131): one lookup in
 * flight, only the newest waiting request is kept, the rest are superseded and never answered
 * (the dashboard drops stale answers by `seq` anyway). That bounds the load a typing burst or a
 * buggy client can put on the Bible source and its circuit breaker, which real verses share.
 */
export function createBibleBrowser(deps: BibleBrowserDeps): {
  handleChapter(message: WsMessage): Promise<void>
  handleSearch(message: WsMessage): Promise<void>
} {
  async function answerChapter(message: WsMessage): Promise<void> {
    const { seq, book: typedBook, chapter } = message.payload as BibleChapterRequestPayload
    const book = deps.normalizeBook(typedBook)
    const reply = (rest: Omit<BibleChapterResultPayload, "seq" | "book" | "chapter">): void =>
      deps.reply("bible:chapter-result", { seq, book: typedBook, chapter, ...rest }, message.correlationId)

    // The hallucination guard first: a chapter that is not in the known-valid catalog never reaches a source.
    const entry = BOOK_CATALOG.find((candidate) => candidate.id === book)
    const verseCount = entry?.chapters[chapter - 1]
    if (!entry || verseCount === undefined || !deps.index.exists({ book, chapter, verse: 1 })) {
      reply({ verses: null, reason: "not-found" })
      return
    }

    const resolution = await resolveChapter(
      book,
      chapter,
      verseCount,
      deps.source,
      deps.chapterCache,
      deps.verseCache,
      deps.circuitBreaker,
      deps.translationId(),
      deps.logger
    )
    if (resolution.kind !== "ok") {
      reply({ verses: null, reason: resolution.kind === "not-found" ? "not-found" : "unavailable" })
      return
    }
    const first = resolution.verses[0]
    const secondary = resolution.verses.find((verse) => verse.secondary)?.secondary
    reply({
      verses: resolution.verses.map((verse) => ({
        verse: verse.reference.verse,
        text: verse.text,
        ...(verse.secondary ? { secondary: verse.secondary.text } : {}),
      })),
      ...(first ? { translation: first.translation, source: first.source } : {}),
      ...(secondary ? { secondaryTranslation: secondary.translation } : {}),
      ...(resolution.missing.length > 0 ? { missing: resolution.missing } : {}),
    })
  }

  function answerSearch(message: WsMessage): Promise<void> {
    const { seq, query: typed } = message.payload as BibleSearchRequestPayload
    const query = typed.trim()
    const loaded = deps.chapterCache.loadedChapters()
    const search = deps.wordSearch?.current() ?? null
    const french: BibleSearchResultPayload["coverage"]["french"] =
      !deps.wordSearch || deps.wordSearch.failed?.() ? "unavailable" : search ? "offline" : "indexing"
    const coverage = { french, loadedChapters: loaded.length }
    const respond = (payload: Omit<BibleSearchResultPayload, "seq" | "query" | "coverage">): void =>
      deps.reply("bible:search-result", { seq, query: typed, coverage, ...payload }, message.correlationId)

    if (query.length < MIN_QUERY_LENGTH || searchTokens(query).length === 0) {
      respond({ hits: [], total: 0, reason: "too-short" })
      return Promise.resolve()
    }
    const startedAt = performance.now()
    const fromFrench = search ? search.search(query, MAX_SEARCH_RESULTS) : { hits: [], total: 0 }
    const fromLoaded = searchLoadedChapters(query, loaded, MAX_SEARCH_RESULTS)
    const hits = [...fromFrench.hits, ...fromLoaded.hits].sort((a, b) => b.score - a.score).slice(0, MAX_SEARCH_RESULTS)
    deps.logger.debug({
      component: "bible-browser",
      event: "search.answered",
      correlationId: message.correlationId,
      durationMs: Math.round(performance.now() - startedAt),
      // The query text is operator input about Scripture, not private data, but it is still not logged: only sizes.
      metadata: { queryLength: query.length, hits: hits.length, total: fromFrench.total + fromLoaded.total, french },
    })
    respond({ hits, total: fromFrench.total + fromLoaded.total })
    return Promise.resolve()
  }

  return {
    handleChapter: latestWins(answerChapter, deps.logger, "chapter"),
    handleSearch: latestWins(answerSearch, deps.logger, "search"),
  }
}

/** One run at a time; while it runs only the newest request is kept. A throw never leaves a stale one queued. */
function latestWins(
  run: (message: WsMessage) => Promise<void>,
  logger: Logger,
  label: string
): (message: WsMessage) => Promise<void> {
  let running = false
  let queued: WsMessage | null = null
  return async (message) => {
    if (running) {
      queued = message
      return
    }
    running = true
    try {
      let next: WsMessage | null = message
      while (next !== null) {
        try {
          await run(next)
        } catch (err) {
          logger.warn({
            component: "bible-browser",
            event: `${label}.failed`,
            correlationId: next.correlationId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        next = queued
        queued = null
      }
    } finally {
      queued = null
      running = false
    }
  }
}
