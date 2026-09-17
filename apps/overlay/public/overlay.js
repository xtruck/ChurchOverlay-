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

    ws.addEventListener("open", () => setStatus("connected"))
    ws.addEventListener("close", () => {
      setStatus("disconnected — retrying…")
      setTimeout(connect, 2000)
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
