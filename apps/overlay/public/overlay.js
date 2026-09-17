// Plain browser JS, no build step — this page is served as-is by
// StaticServer, not compiled from apps/overlay/src/. It is a real,
// functional overlay client, not a mockup: it speaks the same
// WsMessage protocol (packages/contracts/ws.ts) the real app uses.
//
// The viewer token travels in the URL (?token=...) — the only workable
// option for this page, since it must also be loadable as a plain URL by
// OBS's Browser Source, which has no IPC/contextBridge available the way
// the Electron dashboard renderer does. See ARCHITECTURE.md section 26's
// reasoning: what that section actually forbids is putting the token in
// the *WebSocket handshake* URL — which this does NOT do (the token is
// sent correctly via Sec-WebSocket-Protocol, below, exactly as required).
(function () {
  const params = new URLSearchParams(window.location.search)
  const token = params.get("token")
  const wsPort = params.get("wsPort") || window.location.port

  const statusEl = document.getElementById("status")
  const verseEl = document.getElementById("verse")
  const verseCardEl = document.getElementById("verse-card")
  const textEl = document.getElementById("verse-text")
  const secondaryTextEl = document.getElementById("verse-secondary-text")
  const refEl = document.getElementById("verse-reference")

  function setStatus(text) {
    statusEl.textContent = text
  }

  // Bounded, backoff-aware reconnect (ARCHITECTURE.md section 48, AGENTS.md
  // section 37 — "infinite retry loops" specifically forbidden). This is a
  // live, always-on broadcast overlay, so it must keep trying indefinitely
  // rather than give up after N attempts — "bounded" here means the DELAY
  // is capped and grows via backoff, not that reconnection ever stops.
  // Duplicated (not shared) with dashboard.js's identical copy — same
  // no-build-step reasoning as float32ToInt16 elsewhere in this codebase.
  const BASE_RECONNECT_DELAY_MS = 1000
  const MAX_RECONNECT_DELAY_MS = 30000
  let reconnectAttempts = 0

  function nextReconnectDelay() {
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
    reconnectAttempts += 1
    return delay
  }

  function capitalize(book) {
    return book.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  // Auto-shrink to fit: a long verse (a wordy translation, or a small OBS
  // Browser Source size) must never run off-screen or get visually cut
  // off — the CSS clamp() on #verse-text's font-size is viewport-width
  // aware, but not text-length aware, so it alone can't guarantee this.
  // Steps the font size down until the card fits within a safe fraction
  // of the viewport, or hits a legibility floor (never shrinks forever).
  //
  // Bilingual mode (ARCHITECTURE.md section 63.4) extends this to measure
  // the COMBINED card height across both text blocks, not just the
  // primary one — #verse-secondary-text's own font size is stepped down
  // in proportion to the primary's, rather than left fixed, since a long
  // secondary (English) translation can just as easily overflow on its
  // own.
  const MAX_FONT_PX = 44
  const MIN_FONT_PX = 15
  const SECONDARY_FONT_RATIO = 0.55 // matches the visual hierarchy already set in CSS's own clamp() sizing
  const MIN_SECONDARY_FONT_PX = 12
  const MAX_HEIGHT_FRACTION = 0.62 // leaves headroom above/below for #verse's own vertical placement
  const MAX_WIDTH_FRACTION = 0.86 // matches #verse's 7%-each-side padding

  function fitVerseText() {
    const maxWidth = window.innerWidth * MAX_WIDTH_FRACTION
    const maxHeight = window.innerHeight * MAX_HEIGHT_FRACTION
    let fontSize = MAX_FONT_PX
    textEl.style.fontSize = fontSize + "px"
    if (secondaryTextEl.classList.contains("visible")) {
      secondaryTextEl.style.fontSize = Math.max(MIN_SECONDARY_FONT_PX, fontSize * SECONDARY_FONT_RATIO) + "px"
    }
    while (
      (verseCardEl.scrollWidth > maxWidth || verseCardEl.scrollHeight > maxHeight) &&
      fontSize > MIN_FONT_PX
    ) {
      fontSize -= 1
      textEl.style.fontSize = fontSize + "px"
      if (secondaryTextEl.classList.contains("visible")) {
        secondaryTextEl.style.fontSize = Math.max(MIN_SECONDARY_FONT_PX, fontSize * SECONDARY_FONT_RATIO) + "px"
      }
    }
  }

  function showVerse(verse) {
    textEl.textContent = verse.text
    const ref = verse.reference
    refEl.textContent = capitalize(ref.book) + " " + ref.chapter + ":" + ref.verse

    if (verse.secondary) {
      secondaryTextEl.textContent = verse.secondary.text
      secondaryTextEl.classList.add("visible")
    } else {
      secondaryTextEl.classList.remove("visible")
      secondaryTextEl.textContent = ""
    }

    fitVerseText()
    verseEl.classList.add("visible")
  }

  function clearVerse() {
    verseEl.classList.remove("visible")
  }

  function connect() {
    if (!token) {
      setStatus("no viewer token in URL (add ?token=...)")
      return
    }
    setStatus("connecting…")
    const ws = new WebSocket("ws://127.0.0.1:" + wsPort, [token])

    ws.addEventListener("open", () => {
      reconnectAttempts = 0
      setStatus("connected")
    })
    ws.addEventListener("close", () => {
      const delay = nextReconnectDelay()
      setStatus("disconnected — retrying in " + Math.round(delay / 1000) + "s…")
      setTimeout(connect, delay)
    })
    ws.addEventListener("error", () => setStatus("connection error"))
    ws.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === "verse:show") {
        showVerse(message.payload)
      } else if (message.type === "verse:clear") {
        clearVerse()
      }
    })
  }

  // Local emergency clear (ARCHITECTURE.md section 35): must not require
  // a server round trip, and must never become a channel for issuing
  // application commands — this only ever hides the LOCAL visual state.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearVerse()
  })

  // Re-fit on resize (the overlay preview window is resizable; a fixed
  // OBS Browser Source size won't fire this, which is fine — it only
  // needs to fit once, at whatever size it was given).
  window.addEventListener("resize", () => {
    if (verseEl.classList.contains("visible")) fitVerseText()
  })

  connect()
})()
