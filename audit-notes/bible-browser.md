# Bible Browser + search by words (architecture note, written BEFORE the code)

Status: scope change approved by the product owner in chat ("change verses and chapters,
display the whole Bible in the app, search by the words of a verse when you forget the
reference"). Bounded: no new Bible dataset, no offline English Bible, no multi-verse display.

## 1. What and why
Operator-only dashboard view ("Bible" in the sidebar): book list (66, names in the UI language)
-> chapter grid -> verse list with full text; click/Enter sends a verse to the overlay;
previous/next verse and chapter (buttons + keys); a word search box (French or English).

## 2. Ownership (AGENTS.md section 5)
- Server: `apps/server/verse/` (new `resolve-chapter.ts`, `chapter-cache.ts`, `bible-word-search.ts`,
  `bible-browser-service.ts`) + optional `getChapter()` capability on the existing sources.
  Detector untouched. Overlay untouched (it only ever sees ordinary `verse:show`).
- Renderer: new `apps/desktop/renderer/bible-browser.js` + `bible-browser.css`; thin hooks in
  `dashboard.js` (WS bridge) and `index.html` (nav button, view container, script tags).

## 3. Wire protocol (operator-only commands, server-only events)
| type | kind | payload |
|---|---|---|
| `bible:chapter` | command | `{ seq, book, chapter }` |
| `bible:chapter-result` | event (operators only) | `{ seq, book, chapter, verses: [{verse,text,secondary?}] \| null, translation?, secondaryTranslation?, source?, reason? }` |
| `bible:search` | command | `{ seq, query }` (query <= 120 chars) |
| `bible:search-result` | event (operators only) | `{ seq, query, hits: [{reference,text,translation,score}] (<= 20), total, coverage, reason? }` |
| `verse:navigate` | command | `{ direction: next-verse \| previous-verse \| next-chapter \| previous-chapter }` |

Same token auth / role check as every command (`allowedSenders: ["operator"]`); the existing per
connection command limiter (100/s) applies; chapter and search requests additionally coalesce
(one in flight, newest wins, like `verse:preview` section 131) so a typing burst or a buggy
client cannot flood the Bible source or its circuit breaker. Responses are bounded
(<= 200 verses, <= 4000 chars per verse, <= 20 hits).

## 4. Hallucination guard (never bypassed)
- Chapter: the reference `{book, chapter, 1}` must pass `KnownValidVerseIndex.exists()` before any
  source call; returned verses are re-validated (numbers within the catalog's verse count for that
  chapter, non-empty text, reference matches the request); a malformed source answer is a source
  failure, never displayed.
- Showing a verse from the browser is an ordinary `verse:override` (index + resolveVerse + intent
  tickets + `broadcastVerse`), or `verse:navigate`, which resolves against the SERVER's
  `currentVersePosition` with `resolveNavigationCommand()` (section 61.4) and then the same
  `resolveVerse()` path as voice navigation (trigger `"navigation"`). Search results only ever carry
  references that exist in the shipped data; sending one is a `verse:override`.
- Browsing/searching never calls `beginDisplayIntent()` or any `broadcast*Verse()`: the screen
  cannot change by reading.

## 5. Chapter text through the VerseSource chain
`resolveChapter()` mirrors `resolveVerse()`: chapter cache (LRU, bounded, 24 h) -> negative cache
(confirmed-not-found only, short TTL) -> shared circuit breaker -> `source.getChapter()` (optional
capability, implemented by GetBible/FreeApi/Offline/OfflineFallback/Localized sources; a source
without it is assembled verse by verse through `resolveVerse`). Success also warms the verse
cache so a following override is instant. French keeps the section 77 offline fallback; English
has none (existing limitation) so an English chapter is "unavailable" while offline.

## 6. Search by words: what data exists, and the honest limits
- Data: only `apps/server/verse/data/fra_lsg.json` (Louis Segond 1910, public domain, ~4.5 MB,
  already shipped for section 77 and the quote matcher). No English text ships.
- French: `BibleWordSearch`, an in-memory inverted index built once, asynchronously in time slices
  (same pattern as `QuoteMatcher.buildAsync`), from the SAME loaded `OfflineBibleData`. The quote
  matcher itself cannot be reused for this: it fingerprints runs of 5 consecutive words and needs
  >= 8 verbatim words, which is useless for "a few words I remember". Ranking: IDF-weighted word
  matches + bonus for words in the right order, last word may be a prefix (typing), accents/case/
  apostrophes folded. Pure data lookup, no model, no network, works offline.
- English: no offline English corpus, so (a) hits from chapters already opened this session
  (chapter cache) are searched, (b) the dashboard says so explicitly when an English query finds
  nothing. Not done (proposal): "search this book" that loads every chapter of a book on demand
  (up to 150 live requests for Psalms); a vetted public-domain English dataset would be a new
  scope decision.
- Search hits show Louis Segond text (labelled); the verse that reaches the overlay follows the
  current display mode as always.

## 7. Dashboard
Mode "Browse" (default: nothing changes on screen until Show / Enter / double-click) or "Live"
(clicks and steps go on screen; steps use `verse:navigate`; the reader follows `verse:show`,
including voice-detected verses). Shift-click extends a highlighted range for reading; a range is
shown one verse at a time (multi-verse display is explicitly not done, ARCHITECTURE.md "verse
ranges"). Keys (Bible view, not typing): Left/Right = verse, PageUp/PageDown or Shift+Left/Right =
chapter, Enter = show, "/" is left to the global handler.

## 8. Proposed ARCHITECTURE.md section (to paste, number to be chosen by the lead)
"Phase 2 Feature Note — Bible Browser and word search": sections 1-7 above condensed; correctness
invariants: (1) browsing never changes the screen; (2) every reference sent from the browser
passes KnownValidVerseIndex on the server; (3) chapter text always comes through the VerseSource
chain with cache/negative cache/breaker; (4) search results are references that exist in shipped
data; (5) all browser commands are operator-only and bounded; (6) the phone remote does not get
these commands (proposal below). Tests required: chapter resolve (hit, cache, negative cache,
breaker open, malformed source), registry validation (each new type, role, bounds), search ranking
and folding, app-core handlers (override unchanged, navigate no-op without position), renderer
logic (book table equals BOOK_CATALOG, i18n parity).

## 9. Phone remote
Not exposed: the remote token is a second operator surface and these commands are cheap to add to
its allow-list, but the remote UI is a separate page (`apps/remote/public`) and a 66-book browser
does not fit a phone without its own design. Proposal: a "search by words" box only (the most
useful part on a phone), reusing `bible:search` unchanged.

## 10. Implementation status and verification (final)
Built: contracts (verse.ts, ws.ts), getChapter() on GetBible/FreeApi/Offline/OfflineFallback/Localized sources, chapter-cache.ts, resolve-chapter.ts, bible-word-search.ts, bible-browser-service.ts, ws/bible-browser-payloads.ts, app-core hooks (bible:chapter, bible:search, verse:navigate), main/web wiring, renderer bible-browser.js/.css, nav + view + bridge hooks, FR/EN strings, Ctrl+7 shortcut.
Verified: tsc clean, lint clean, ~60 new tests; UI exercised in a browser harness against a real AppCore (French live chapter, word search, show to screen, on-air chip).
Not verified: inside real Electron; Live-mode keyboard stepping and English/bilingual chapters in the browser; phone remote (not exposed).
