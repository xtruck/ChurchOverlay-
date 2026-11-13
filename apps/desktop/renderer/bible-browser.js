// Plain browser JS, no build step (same convention as dashboard.js).
// Bible Browser view (audit-notes/bible-browser.md): read any chapter, find a verse by a few of
// its words, and put a verse on the screen only when the operator chooses.
//
// Everything the server knows arrives over the operator WebSocket (through the small bridge
// dashboard.js exposes as window.ChurchOverlayBridge); this file never touches the filesystem,
// secrets or the network itself. Sending a verse is an ordinary `verse:override` (the server
// validates it against the known-valid index again), stepping live is `verse:navigate` (resolved
// from the SERVER's position), reading is `bible:chapter` / `bible:search`, which cannot change
// what the congregation sees. All text from the server is rendered with textContent only.
;(function (root) {
  "use strict"

  // [catalog id, English name, French name, number of chapters]. Kept in step with
  // apps/server/verse/book-catalog.ts by bible-browser.test.ts.
  const BOOKS = [
    ["genesis", "Genesis", "Genèse", 50],
    ["exodus", "Exodus", "Exode", 40],
    ["leviticus", "Leviticus", "Lévitique", 27],
    ["numbers", "Numbers", "Nombres", 36],
    ["deuteronomy", "Deuteronomy", "Deutéronome", 34],
    ["joshua", "Joshua", "Josué", 24],
    ["judges", "Judges", "Juges", 21],
    ["ruth", "Ruth", "Ruth", 4],
    ["1 samuel", "1 Samuel", "1 Samuel", 31],
    ["2 samuel", "2 Samuel", "2 Samuel", 24],
    ["1 kings", "1 Kings", "1 Rois", 22],
    ["2 kings", "2 Kings", "2 Rois", 25],
    ["1 chronicles", "1 Chronicles", "1 Chroniques", 29],
    ["2 chronicles", "2 Chronicles", "2 Chroniques", 36],
    ["ezra", "Ezra", "Esdras", 10],
    ["nehemiah", "Nehemiah", "Néhémie", 13],
    ["esther", "Esther", "Esther", 10],
    ["job", "Job", "Job", 42],
    ["psalm", "Psalms", "Psaumes", 150],
    ["proverbs", "Proverbs", "Proverbes", 31],
    ["ecclesiastes", "Ecclesiastes", "Ecclésiaste", 12],
    ["song of solomon", "Song of Solomon", "Cantique des Cantiques", 8],
    ["isaiah", "Isaiah", "Ésaïe", 66],
    ["jeremiah", "Jeremiah", "Jérémie", 52],
    ["lamentations", "Lamentations", "Lamentations", 5],
    ["ezekiel", "Ezekiel", "Ézéchiel", 48],
    ["daniel", "Daniel", "Daniel", 12],
    ["hosea", "Hosea", "Osée", 14],
    ["joel", "Joel", "Joël", 3],
    ["amos", "Amos", "Amos", 9],
    ["obadiah", "Obadiah", "Abdias", 1],
    ["jonah", "Jonah", "Jonas", 4],
    ["micah", "Micah", "Michée", 7],
    ["nahum", "Nahum", "Nahum", 3],
    ["habakkuk", "Habakkuk", "Habacuc", 3],
    ["zephaniah", "Zephaniah", "Sophonie", 3],
    ["haggai", "Haggai", "Aggée", 2],
    ["zechariah", "Zechariah", "Zacharie", 14],
    ["malachi", "Malachi", "Malachie", 4],
    ["matthew", "Matthew", "Matthieu", 28],
    ["mark", "Mark", "Marc", 16],
    ["luke", "Luke", "Luc", 24],
    ["john", "John", "Jean", 21],
    ["acts", "Acts", "Actes", 28],
    ["romans", "Romans", "Romains", 16],
    ["1 corinthians", "1 Corinthians", "1 Corinthiens", 16],
    ["2 corinthians", "2 Corinthians", "2 Corinthiens", 13],
    ["galatians", "Galatians", "Galates", 6],
    ["ephesians", "Ephesians", "Éphésiens", 6],
    ["philippians", "Philippians", "Philippiens", 4],
    ["colossians", "Colossians", "Colossiens", 4],
    ["1 thessalonians", "1 Thessalonians", "1 Thessaloniciens", 5],
    ["2 thessalonians", "2 Thessalonians", "2 Thessaloniciens", 3],
    ["1 timothy", "1 Timothy", "1 Timothée", 6],
    ["2 timothy", "2 Timothy", "2 Timothée", 4],
    ["titus", "Titus", "Tite", 3],
    ["philemon", "Philemon", "Philémon", 1],
    ["hebrews", "Hebrews", "Hébreux", 13],
    ["james", "James", "Jacques", 5],
    ["1 peter", "1 Peter", "1 Pierre", 5],
    ["2 peter", "2 Peter", "2 Pierre", 3],
    ["1 john", "1 John", "1 Jean", 5],
    ["2 john", "2 John", "2 Jean", 1],
    ["3 john", "3 John", "3 Jean", 1],
    ["jude", "Jude", "Jude", 1],
    ["revelation", "Revelation", "Apocalypse", 22],
  ]
  const OLD_TESTAMENT_BOOKS = 39
  /** Marks "the last verse of the chapter once it is loaded" for a step back across a chapter boundary. */
  const LAST_VERSE = 9999
  const SEARCH_DEBOUNCE_MS = 250
  const CHAPTER_TIMEOUT_MS = 10000

  const bookIndex = (id) => BOOKS.findIndex((book) => book[0] === id)

  /**
   * Where one step lands (pure; unit-tested). `lastVerse` is the last verse number of the
   * cursor's CURRENT chapter. Returns null at the ends of the Bible. A step back over a chapter
   * boundary answers verse LAST_VERSE ("the last one"), clamped once that chapter is loaded.
   * Chapter steps land on verse 1, like the server's own navigation (section 61.4).
   */
  function stepCursor(cursor, direction, lastVerse) {
    const index = bookIndex(cursor.book)
    if (index < 0) return null
    const chapters = BOOKS[index][3]
    const nextBook = BOOKS[index + 1]
    const previousBook = BOOKS[index - 1]
    switch (direction) {
      case "next-verse":
        if (cursor.verse < lastVerse) return { book: cursor.book, chapter: cursor.chapter, verse: cursor.verse + 1 }
        if (cursor.chapter < chapters) return { book: cursor.book, chapter: cursor.chapter + 1, verse: 1 }
        return nextBook ? { book: nextBook[0], chapter: 1, verse: 1 } : null
      case "previous-verse":
        if (cursor.verse > 1) return { book: cursor.book, chapter: cursor.chapter, verse: cursor.verse - 1 }
        if (cursor.chapter > 1) return { book: cursor.book, chapter: cursor.chapter - 1, verse: LAST_VERSE }
        return previousBook ? { book: previousBook[0], chapter: previousBook[3], verse: LAST_VERSE } : null
      case "next-chapter":
        if (cursor.chapter < chapters) return { book: cursor.book, chapter: cursor.chapter + 1, verse: 1 }
        return nextBook ? { book: nextBook[0], chapter: 1, verse: 1 } : null
      case "previous-chapter":
        if (cursor.chapter > 1) return { book: cursor.book, chapter: cursor.chapter - 1, verse: 1 }
        return previousBook ? { book: previousBook[0], chapter: previousBook[3], verse: 1 } : null
      default:
        return null
    }
  }

  /** Display name of a book in the UI language ("fr" or anything else = English). */
  function bookName(id, language) {
    const index = bookIndex(id)
    if (index < 0) return id
    return language === "fr" ? BOOKS[index][2] : BOOKS[index][1]
  }

  /** Splits `text` into [{ text, match }] where match marks words the query was looking for (accents and case ignored). */
  function highlightParts(text, query) {
    const fold = (value) =>
      String(value)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
    const queryWords = fold(query)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1)
    // Little words (je, ne, de) are only marked when the query is made of nothing else.
    const bigWords = queryWords.filter((word) => word.length > 2)
    const wanted = bigWords.length > 0 ? bigWords : queryWords
    if (wanted.length === 0) return [{ text, match: false }]
    const last = wanted[wanted.length - 1]
    const pieces = []
    for (const piece of String(text).split(/(\s+)/)) {
      if (piece === "") continue
      const words = fold(piece)
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
      // null: whitespace, which takes the colour of its neighbours so a matched phrase is one run
      const match = /^\s+$/.test(piece) ? null : words.some((word) => wanted.includes(word) || (last.length >= 3 && word.startsWith(last)))
      pieces.push({ text: piece, match })
    }
    const parts = []
    pieces.forEach((piece, i) => {
      let match = piece.match
      if (match === null) {
        const before = pieces[i - 1]
        const after = pieces[i + 1]
        match = Boolean(before && before.match && after && after.match)
      }
      const previous = parts[parts.length - 1]
      if (previous && previous.match === match) previous.text += piece.text
      else parts.push({ text: piece.text, match })
    })
    return parts
  }

  root.ChurchOverlayBibleLogic = { BOOKS, LAST_VERSE, stepCursor, bookName, highlightParts }

  // ----------------------------------------------------------------------------------------
  // UI (skipped when there is no DOM, e.g. when the logic above is unit-tested in Node)
  // ----------------------------------------------------------------------------------------
  const doc = root.document
  if (!doc) return
  const view = doc.getElementById("view-bible")
  const bridge = root.ChurchOverlayBridge
  if (!view || !bridge || !root.i18n) return

  const t = (key, params) => root.i18n.t(key, params)
  const language = () => (root.i18n.getLanguage ? root.i18n.getLanguage() : "en")
  const TRANSLATION_NAMES = { ls1910: "Louis Segond 1910", kjv: "King James", darby: "Darby" }
  const translationLabel = (code) => TRANSLATION_NAMES[String(code).toLowerCase()] || String(code).toUpperCase()

  const state = {
    mode: "browse", // "browse": nothing changes on screen until Show; "live": clicks and steps go on screen
    book: null,
    chapter: null,
    verses: [], // [{ verse, text, secondary? }] of the open chapter
    translation: "",
    secondaryTranslation: "",
    status: "idle", // idle | loading | ready | unavailable | not-found | disconnected
    cursor: null, // selected verse number in the open chapter
    anchor: null, // first verse of a shift-click range
    rangeEnd: null,
    onAir: null, // { book, chapter, verse } currently on the congregation screen
    pendingVerse: null, // verse to select once the chapter arrives (number or LAST_VERSE)
    seq: 0,
    chapterTimer: null,
    query: "",
    searchSeq: 0,
    searchTimer: null,
    search: null, // last answer for the current query
    searchRetry: null,
    searchRetries: 0,
    missing: [], // verse numbers the source did not provide for the open chapter
  }
  const MAX_INDEX_RETRIES = 5

  const el = {}

  function node(tag, className, text) {
    const created = doc.createElement(tag)
    if (className) created.className = className
    if (text !== undefined) created.textContent = text
    return created
  }

  function button(className, label, onClick, attrs) {
    const created = node("button", className, label)
    created.type = "button"
    if (attrs) for (const [name, value] of Object.entries(attrs)) created.setAttribute(name, value)
    created.addEventListener("click", onClick)
    return created
  }

  function send(type, payload) {
    return bridge.send({ id: crypto.randomUUID(), type, timestamp: Date.now(), payload })
  }

  let noticeTimer = null
  /** A short visible message under the toolbar (role=status): nothing the operator asked for may fail silently. */
  function notify(key) {
    if (!el.notice) return
    el.notice.textContent = t(key)
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      el.notice.textContent = ""
    }, 7000)
  }

  /** Sends a command that puts something on screen; tells the operator when the connection is down and it was not sent. */
  function sendToScreen(type, payload) {
    const sent = send(type, payload)
    if (!sent) notify("bible.notSent")
    return sent
  }

  const reference = (ref) => bookName(ref.book, language()) + " " + ref.chapter + ":" + ref.verse

  // ---------- skeleton (built once) ----------
  function build() {
    view.textContent = ""
    const container = node("div", "bb")

    const head = node("div", "view-head")
    const titles = node("div")
    el.eyebrow = node("span", "eyebrow")
    el.title = node("h2", "view-title")
    el.sub = node("p", "view-sub")
    titles.append(el.eyebrow, el.title, el.sub)
    head.appendChild(titles)

    const bar = node("div", "bb-toolbar")
    const searchWrap = node("div", "bb-search")
    el.search = node("input")
    el.search.type = "search"
    el.search.autocomplete = "off"
    el.search.spellcheck = false
    el.search.maxLength = 120
    el.search.id = "bb-search-input"
    el.search.addEventListener("input", onSearchInput)
    el.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        clearSearch()
        el.search.blur()
      }
    })
    searchWrap.appendChild(el.search)

    el.mode = node("div", "segmented")
    el.mode.setAttribute("role", "group")
    el.modeBrowse = button("", "", () => setMode("browse"))
    el.modeLive = button("", "", () => setMode("live"))
    el.mode.append(el.modeBrowse, el.modeLive)

    el.onAir = node("div", "bb-onair")
    el.onAirText = node("span", "bb-onair-text")
    el.onAirGo = button("btn-secondary btn-small", "", () => {
      if (!state.onAir) return
      clearSearch() // the results list would otherwise stay in front of the chapter being opened
      openChapter(state.onAir.book, state.onAir.chapter, state.onAir.verse)
    })
    el.onAir.append(el.onAirText, el.onAirGo)

    bar.append(searchWrap, el.mode, el.onAir)

    const grid = node("div", "bb-grid")
    el.books = node("nav", "card bb-books")
    el.chapters = node("div", "card bb-chapters")
    el.reader = node("div", "card bb-reader")
    el.results = node("div", "card bb-results")
    el.results.hidden = true
    grid.append(el.books, el.chapters, el.reader, el.results)

    el.notice = node("p", "bb-notice")
    el.notice.setAttribute("role", "status")
    container.append(head, bar, el.notice, grid)
    view.appendChild(container)
  }

  // ---------- rendering ----------
  function renderStatic() {
    el.eyebrow.textContent = t("bible.eyebrow")
    el.title.textContent = t("bible.title")
    el.sub.textContent = t("bible.sub")
    el.search.placeholder = t("bible.searchPlaceholder")
    el.search.setAttribute("aria-label", t("bible.searchLabel"))
    el.mode.setAttribute("aria-label", t("bible.modeLabel"))
    el.modeBrowse.textContent = t("bible.mode.browse")
    el.modeBrowse.title = t("bible.mode.browseHint")
    el.modeLive.textContent = t("bible.mode.live")
    el.modeLive.title = t("bible.mode.liveHint")
    el.books.setAttribute("aria-label", t("bible.booksHeading"))
    el.onAirGo.textContent = t("bible.goToOnScreen")
  }

  function renderMode() {
    for (const [btn, mode] of [[el.modeBrowse, "browse"], [el.modeLive, "live"]]) {
      btn.classList.toggle("active", state.mode === mode)
      btn.setAttribute("aria-pressed", String(state.mode === mode))
    }
  }

  function renderOnAir() {
    const ref = state.onAir
    el.onAir.classList.toggle("is-on", Boolean(ref))
    el.onAirText.textContent = ref ? t("bible.onScreen", { reference: reference(ref) }) : t("bible.nothingOnScreen")
    el.onAirGo.hidden = !ref
  }

  function renderBooks() {
    el.books.textContent = ""
    const lang = language()
    let group = null
    BOOKS.forEach((book, index) => {
      if (index === 0 || index === OLD_TESTAMENT_BOOKS) {
        el.books.appendChild(node("h3", "section-title", t(index === 0 ? "bible.oldTestament" : "bible.newTestament")))
        group = node("div", "bb-booklist")
        el.books.appendChild(group)
      }
      const item = button("bb-book", lang === "fr" ? book[2] : book[1], () => selectBook(book[0]), { "data-book": book[0] })
      if (state.book === book[0]) {
        item.classList.add("active")
        item.setAttribute("aria-current", "true")
      }
      group.appendChild(item)
    })
  }

  function renderBookSelection() {
    for (const item of el.books.querySelectorAll(".bb-book")) {
      const on = item.dataset.book === state.book
      item.classList.toggle("active", on)
      if (on) {
        item.setAttribute("aria-current", "true")
        if (item.scrollIntoView) item.scrollIntoView({ block: "nearest" })
      } else {
        item.removeAttribute("aria-current")
      }
    }
  }

  function renderChapters() {
    el.chapters.textContent = ""
    el.chapters.appendChild(node("h3", "section-title", t("bible.chaptersHeading")))
    if (state.book === null) {
      el.chapters.appendChild(node("p", "sub", t("bible.pickBook")))
      return
    }
    const count = BOOKS[bookIndex(state.book)][3]
    const grid = node("div", "bb-chaptergrid")
    for (let chapter = 1; chapter <= count; chapter++) {
      const item = button("bb-chapter", String(chapter), () => openChapter(state.book, chapter, 1), { "data-chapter": String(chapter) })
      if (state.chapter === chapter) {
        item.classList.add("active")
        item.setAttribute("aria-current", "true")
      }
      if (state.onAir && state.onAir.book === state.book && state.onAir.chapter === chapter) item.classList.add("on-air")
      grid.appendChild(item)
    }
    el.chapters.appendChild(grid)
  }

  function renderChapterSelection() {
    for (const item of el.chapters.querySelectorAll(".bb-chapter")) {
      const number = Number(item.dataset.chapter)
      const on = number === state.chapter
      item.classList.toggle("active", on)
      if (on) item.setAttribute("aria-current", "true")
      else item.removeAttribute("aria-current")
      item.classList.toggle("on-air", Boolean(state.onAir) && state.onAir.book === state.book && state.onAir.chapter === number)
    }
  }

  function renderReader() {
    el.reader.textContent = ""
    const head = node("div", "bb-reader-head")
    const heading = node("h3", "bb-reader-title", state.chapter === null ? t("bible.readerTitle") : bookName(state.book, language()) + " " + state.chapter)
    head.appendChild(heading)
    if (state.status === "ready" && state.translation) {
      const label = translationLabel(state.translation) + (state.secondaryTranslation ? " · " + translationLabel(state.secondaryTranslation) : "")
      head.appendChild(node("span", "bb-translation", label))
    }
    el.reader.appendChild(head)
    if (state.status === "ready" && state.missing.length > 0) {
      el.reader.appendChild(node("p", "bb-partial", t("bible.partialNote", { verses: state.missing.join(", ") })))
    }

    const body = node("div", "bb-verses")
    body.tabIndex = 0
    body.setAttribute("role", "listbox")
    body.setAttribute("aria-label", t("bible.versesLabel"))
    el.verses = body
    if (state.status === "idle") {
      body.appendChild(node("p", "sub bb-empty", t("bible.pickChapter")))
    } else if (state.status === "loading") {
      body.appendChild(node("p", "sub bb-empty", t("bible.loading")))
      for (let i = 0; i < 4; i++) {
        const placeholder = node("div", "skeleton skeleton-row")
        placeholder.setAttribute("aria-hidden", "true")
        body.appendChild(placeholder)
      }
    } else if (state.status === "ready") {
      for (const entry of state.verses) body.appendChild(verseRow(entry))
    } else {
      const message = state.status === "unavailable" ? "bible.unavailable" : state.status === "not-found" ? "bible.notFound" : "bible.notConnected"
      body.appendChild(node("p", "bb-empty bb-error", t(message)))
      if (state.chapter !== null) body.appendChild(button("btn-secondary btn-small", t("bible.retry"), () => openChapter(state.book, state.chapter, state.cursor || 1)))
    }
    el.reader.appendChild(body)

    const bar = node("div", "bb-stepbar")
    const steps = node("div", "btn-row")
    steps.append(
      button("btn-secondary", "«", () => step("previous-chapter"), { "aria-label": t("bible.prevChapter"), title: t("bible.prevChapter") + " (PageUp)" }),
      button("btn-secondary", "‹", () => step("previous-verse"), { "aria-label": t("bible.prevVerse"), title: t("bible.prevVerse") + " (←)" }),
      button("btn-secondary", "›", () => step("next-verse"), { "aria-label": t("bible.nextVerse"), title: t("bible.nextVerse") + " (→)" }),
      button("btn-secondary", "»", () => step("next-chapter"), { "aria-label": t("bible.nextChapter"), title: t("bible.nextChapter") + " (PageDown)" })
    )
    el.rangeNote = node("span", "sub bb-range-note")
    el.showBtn = button("btn-primary", t("bible.show"), () => showSelected(), { title: t("bible.show") + " (Enter)" })
    bar.append(steps, el.rangeNote, el.showBtn)
    el.reader.appendChild(bar)
    el.reader.appendChild(node("p", "sub bb-keys", t("bible.keysHint")))
    updateSelection()
  }

  function verseRow(entry) {
    const row = node("div", "bb-verse")
    row.id = "bb-verse-option-" + entry.verse
    row.setAttribute("role", "option")
    row.dataset.verse = String(entry.verse)
    row.appendChild(node("span", "bb-vnum", String(entry.verse)))
    const text = node("span", "bb-vtext")
    text.appendChild(node("span", "bb-vprimary", entry.text))
    if (entry.secondary) text.appendChild(node("span", "bb-vsecondary", entry.secondary))
    row.appendChild(text)
    row.appendChild(node("span", "bb-vbadge", t("bible.onAirBadge")))
    row.addEventListener("click", (event) => onVerseClick(entry.verse, event))
    row.addEventListener("dblclick", () => {
      selectVerse(entry.verse)
      showSelected()
    })
    return row
  }

  function rangeBounds() {
    if (state.cursor === null) return null
    const anchor = state.anchor === null ? state.cursor : state.anchor
    return { from: Math.min(anchor, state.rangeEnd === null ? anchor : state.rangeEnd), to: Math.max(anchor, state.rangeEnd === null ? anchor : state.rangeEnd) }
  }

  function updateSelection() {
    if (!el.verses) return
    const range = state.rangeEnd !== null ? rangeBounds() : null
    for (const row of el.verses.querySelectorAll(".bb-verse")) {
      const number = Number(row.dataset.verse)
      const selected = number === state.cursor
      row.classList.toggle("selected", selected)
      row.classList.toggle("in-range", Boolean(range) && number >= range.from && number <= range.to)
      row.classList.toggle("on-air", Boolean(state.onAir) && state.onAir.book === state.book && state.onAir.chapter === state.chapter && state.onAir.verse === number)
      row.setAttribute("aria-selected", String(selected))
    }
    if (el.rangeNote) {
      el.rangeNote.textContent = range ? t("bible.rangeNote", { count: range.to - range.from + 1 }) : ""
    }
    if (el.showBtn) el.showBtn.disabled = state.status !== "ready" || state.cursor === null
    const selectedRow = el.verses.querySelector(".bb-verse.selected")
    if (selectedRow) el.verses.setAttribute("aria-activedescendant", selectedRow.id)
    else el.verses.removeAttribute("aria-activedescendant")
    if (selectedRow && selectedRow.scrollIntoView) selectedRow.scrollIntoView({ block: "nearest" })
  }

  // ---------- actions ----------
  function setMode(mode) {
    state.mode = mode
    renderMode()
    // Entering Live: the reader follows what is on screen right away.
    if (mode === "live" && state.onAir) followOnAir()
  }

  function selectBook(id) {
    state.book = id
    state.chapter = null
    state.status = "idle"
    state.verses = []
    state.cursor = null
    state.anchor = null
    state.rangeEnd = null
    renderBookSelection()
    renderChapters()
    renderReader()
    if (BOOKS[bookIndex(id)][3] === 1) openChapter(id, 1, 1)
  }

  function openChapter(book, chapter, verse) {
    if (bookIndex(book) < 0) return
    clearTimeout(state.chapterTimer)
    const sameBook = state.book === book
    state.book = book
    state.chapter = chapter
    state.pendingVerse = verse === undefined || verse === null ? 1 : verse
    state.cursor = null
    state.anchor = null
    state.rangeEnd = null
    state.verses = []
    state.status = "loading"
    state.seq += 1
    if (!sameBook) renderBookSelection()
    renderChapters()
    renderReader()
    if (state.query === "") hideResults()
    const sent = send("bible:chapter", { seq: state.seq, book, chapter })
    if (!sent) {
      state.status = "disconnected"
      renderReader()
      return
    }
    const seq = state.seq
    state.chapterTimer = setTimeout(() => {
      if (state.seq === seq && state.status === "loading") {
        state.status = "unavailable"
        renderReader()
      }
    }, CHAPTER_TIMEOUT_MS)
  }

  function onChapterResult(payload) {
    if (!payload || payload.seq !== state.seq) return // a newer request replaced this one
    clearTimeout(state.chapterTimer)
    if (!Array.isArray(payload.verses)) {
      state.status = payload.reason === "not-found" ? "not-found" : "unavailable"
      renderReader()
      return
    }
    state.verses = payload.verses
    state.translation = payload.translation || ""
    state.secondaryTranslation = payload.secondaryTranslation || ""
    state.missing = Array.isArray(payload.missing) ? payload.missing : []
    state.status = "ready"
    const last = state.verses.length > 0 ? state.verses[state.verses.length - 1].verse : 1
    const wanted = state.pendingVerse === LAST_VERSE ? last : Number(state.pendingVerse) || 1
    state.cursor = state.verses.some((entry) => entry.verse === wanted) ? wanted : state.verses[0].verse
    state.pendingVerse = null
    renderReader()
    renderChapterSelection()
  }

  function selectVerse(verse) {
    state.cursor = verse
    state.anchor = null
    state.rangeEnd = null
    updateSelection()
  }

  function onVerseClick(verse, event) {
    if (event.shiftKey && state.cursor !== null) {
      if (state.anchor === null) state.anchor = state.cursor
      state.rangeEnd = verse
      state.cursor = state.anchor // Show sends the first verse of the range
      updateSelection()
      return
    }
    selectVerse(verse)
    if (state.mode === "live") showSelected()
  }

  /** Puts the selected verse on the screen: an ordinary verse:override, validated again by the server. */
  function showSelected() {
    if (state.status !== "ready" || state.cursor === null) return
    sendToScreen("verse:override", { book: state.book, chapter: state.chapter, verse: state.cursor })
  }

  function lastVerseOfChapter() {
    return state.verses.length > 0 ? state.verses[state.verses.length - 1].verse : 0
  }

  function step(direction) {
    if (state.mode === "live" && state.onAir) {
      // From what the SERVER last showed (voice detection included), never from this screen's guess.
      sendToScreen("verse:navigate", { direction })
      return
    }
    if (state.status === "loading") return
    const from = state.cursor !== null && state.status === "ready"
      ? { book: state.book, chapter: state.chapter, verse: state.cursor }
      : state.book !== null && state.chapter !== null
        ? { book: state.book, chapter: state.chapter, verse: 1 }
        : null
    if (!from) return
    const target = stepCursor(from, direction, lastVerseOfChapter())
    if (!target) return
    goTo(target.book, target.chapter, target.verse)
    // Live with nothing on screen yet: the first step has no server position, so it is a plain show.
    if (state.mode === "live") sendWhenReady()
  }

  /** Moves the reader to a verse, loading its chapter first if it is not the open one. */
  function goTo(book, chapter, verse) {
    if (state.book === book && state.chapter === chapter && state.status === "ready") {
      const target = verse === LAST_VERSE ? lastVerseOfChapter() : verse
      if (state.verses.some((entry) => entry.verse === target)) {
        selectVerse(target)
        return
      }
    }
    openChapter(book, chapter, verse)
  }

  let showAfterLoad = false
  function sendWhenReady() {
    if (state.status === "ready" && state.cursor !== null) showSelected()
    else showAfterLoad = true
  }

  function followOnAir() {
    const ref = state.onAir
    if (!ref) return
    if (state.book === ref.book && state.chapter === ref.chapter && state.status === "ready") selectVerse(ref.verse)
    else openChapter(ref.book, ref.chapter, ref.verse)
  }

  function onVerseShown(payload) {
    const ref = payload && payload.reference
    if (!ref || typeof ref.book !== "string") return
    state.onAir = { book: ref.book, chapter: ref.chapter, verse: ref.verse }
    renderOnAir()
    renderChapterSelection()
    updateSelection()
    if (state.mode === "live") followOnAir()
  }

  function onVerseCleared() {
    state.onAir = null
    renderOnAir()
    renderChapterSelection()
    updateSelection()
  }

  // ---------- search ----------
  function onSearchInput() {
    state.query = el.search.value
    clearTimeout(state.searchTimer)
    clearTimeout(state.searchRetry)
    state.searchRetries = 0
    state.searchSeq += 1
    if (state.query.trim() === "") {
      state.search = null
      hideResults()
      return
    }
    const seq = state.searchSeq
    state.searchTimer = setTimeout(() => runSearch(seq), SEARCH_DEBOUNCE_MS)
    showResults()
    renderResults()
  }

  function runSearch(seq) {
    if (seq !== state.searchSeq) return
    if (!send("bible:search", { seq, query: state.query.trim().slice(0, 120) })) {
      state.search = { seq, query: state.query, hits: [], total: 0, coverage: { french: "unavailable", loadedChapters: 0 }, disconnected: true }
      renderResults()
    }
  }

  function onSearchResult(payload) {
    if (!payload || payload.seq !== state.searchSeq) return
    state.search = payload
    renderResults()
    // The French index builds in the background right after launch: ask again shortly.
    // A bounded number of times: a build that never finishes must end in a visible message, not a silent loop.
    if (payload.coverage && payload.coverage.french === "indexing") {
      state.searchRetries += 1
      if (state.searchRetries > MAX_INDEX_RETRIES) {
        state.search = Object.assign({}, payload, { gaveUp: true })
        renderResults()
        return
      }
      const seq = state.searchSeq
      state.searchRetry = setTimeout(() => runSearch(seq), 2000)
    }
  }

  function clearSearch() {
    el.search.value = ""
    onSearchInput()
  }

  function showResults() {
    el.results.hidden = false
    el.reader.hidden = true
    el.chapters.hidden = true
  }

  function hideResults() {
    el.results.hidden = true
    el.reader.hidden = false
    el.chapters.hidden = false
  }

  function renderResults() {
    const box = el.results
    box.textContent = ""
    const head = node("div", "bb-reader-head")
    head.appendChild(node("h3", "bb-reader-title", t("bible.resultsHeading")))
    head.appendChild(button("btn-secondary btn-small", t("bible.searchClear"), clearSearch))
    box.appendChild(head)

    const answer = state.search
    const list = node("div", "bb-hits")
    list.setAttribute("role", "list")
    if (!answer) {
      list.appendChild(node("p", "sub bb-empty", t("bible.searching")))
    } else if (answer.disconnected) {
      list.appendChild(node("p", "bb-empty bb-error", t("bible.notConnected")))
    } else if (answer.reason === "too-short") {
      list.appendChild(node("p", "sub bb-empty", t("bible.searchTooShort")))
    } else if (answer.hits.length === 0 && (answer.gaveUp || answer.coverage.french === "unavailable")) {
      list.appendChild(node("p", "bb-empty bb-error", t("bible.searchIndexFailed")))
    } else if (answer.coverage.french === "indexing" && answer.hits.length === 0) {
      list.appendChild(node("p", "sub bb-empty", t("bible.searchIndexing")))
    } else if (answer.hits.length === 0) {
      list.appendChild(node("p", "bb-empty", t("bible.searchNone")))
      list.appendChild(node("p", "sub", t("bible.searchEnglishHint")))
    } else {
      for (const hit of answer.hits) list.appendChild(hitRow(hit, answer.query))
    }
    box.appendChild(list)

    if (answer && !answer.disconnected && answer.reason !== "too-short") {
      const foot = node("p", "sub bb-coverage")
      const coverageKey = answer.coverage.french === "offline" ? "bible.searchCoverage" : "bible.searchCoverageNoFrench"
      foot.textContent = t(coverageKey, { count: answer.coverage.loadedChapters })
      if (answer.total > answer.hits.length) foot.textContent += " " + t("bible.searchMore", { total: answer.total, shown: answer.hits.length })
      box.appendChild(foot)
    }
  }

  function hitRow(hit, query) {
    const row = node("div", "bb-hit")
    row.setAttribute("role", "listitem")
    const open = button("bb-hit-open", "", () => {
      clearSearch()
      openChapter(hit.reference.book, hit.reference.chapter, hit.reference.verse)
    })
    open.title = t("bible.hitOpen")
    const refLine = node("span", "bb-hit-ref")
    refLine.append(node("strong", "", reference(hit.reference)), node("span", "bb-translation", translationLabel(hit.translation)))
    const text = node("span", "bb-hit-text")
    for (const part of highlightParts(hit.text, query)) text.appendChild(part.match ? node("mark", "", part.text) : doc.createTextNode(part.text))
    open.append(refLine, text)
    const show = button("btn-primary btn-small", t("bible.hitShow"), () => sendToScreen("verse:override", hit.reference), { "aria-label": t("bible.hitShow") + " " + reference(hit.reference) })
    row.append(open, show)
    return row
  }

  // ---------- keyboard ----------
  function typingTarget(target) {
    if (!target) return false
    const tag = target.tagName
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target.isContentEditable)
  }

  function interactiveTarget(target) {
    return Boolean(target && target.closest && target.closest('button, a[href], [role="button"], [role="tab"]'))
  }

  doc.addEventListener("keydown", (event) => {
    if (!view.classList.contains("active") || event.defaultPrevented) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (typingTarget(event.target)) return
    if (interactiveTarget(event.target)) return
    if (Array.from(doc.querySelectorAll(".modal-overlay")).some((modal) => modal.style.display !== "none")) return
    if (!el.results.hidden) return // the results list has the stage: plain buttons, no stepping
    let direction = null
    if (event.key === "ArrowRight") direction = event.shiftKey ? "next-chapter" : "next-verse"
    else if (event.key === "ArrowLeft") direction = event.shiftKey ? "previous-chapter" : "previous-verse"
    else if (event.key === "PageDown") direction = "next-chapter"
    else if (event.key === "PageUp") direction = "previous-chapter"
    if (direction) {
      event.preventDefault()
      step(direction)
    } else if (event.key === "Enter" && !event.repeat && (event.target === el.verses || event.target === doc.body)) {
      event.preventDefault()
      showSelected()
    }
  })

  // ---------- wiring ----------
  bridge.subscribe((message) => {
    switch (message.type) {
      case "bible:chapter-result":
        onChapterResult(message.payload)
        if (showAfterLoad && state.status === "ready") {
          showAfterLoad = false
          if (state.mode === "live") showSelected()
        } else if (state.status !== "loading") {
          showAfterLoad = false
        }
        break
      case "bible:search-result":
        onSearchResult(message.payload)
        break
      case "verse:navigate-result": {
        const reason = message.payload && message.payload.reason
        notify(reason === "boundary" ? "bible.navigate.boundary" : reason === "unavailable" ? "bible.navigate.unavailable" : "bible.navigate.noPosition")
        break
      }
      case "verse:show":
        onVerseShown(message.payload)
        break
      case "verse:clear":
        onVerseCleared()
        break
      case "bridge:open":
        // A reconnect: re-ask for the chapter that was being read when the link dropped.
        if (state.chapter !== null && (state.status === "disconnected" || state.status === "loading")) openChapter(state.book, state.chapter, state.cursor || state.pendingVerse || 1)
        break
      default:
        break
    }
  })

  root.addEventListener("churchoverlay:languagechange", () => {
    renderStatic()
    renderOnAir()
    renderBooks()
    renderChapters()
    renderReader()
    if (!el.results.hidden) renderResults()
  })

  let opened = false
  root.addEventListener("churchoverlay:viewchange", (event) => {
    if (!event.detail || event.detail.view !== "bible") return
    if (!opened) {
      opened = true
      // First visit: start where the congregation is, if anything is on screen.
      if (state.onAir && state.book === null) followOnAir()
    }
    if (el.search) el.search.focus()
  })

  build()
  renderStatic()
  renderMode()
  renderOnAir()
  renderBooks()
  renderChapters()
  renderReader()
})(typeof window !== "undefined" ? window : globalThis)
