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
  const textEl = document.getElementById("verse-text")
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

  function showVerse(verse) {
    textEl.textContent = verse.text
    const ref = verse.reference
    refEl.textContent = capitalize(ref.book) + " " + ref.chapter + ":" + ref.verse
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

  connect()
})()
