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
  const mediaLayerEl = document.getElementById("media-layer")
  const mediaImageEl = document.getElementById("media-image")
  const mediaVideoEl = document.getElementById("media-video")
  const mediaAudioEl = document.getElementById("media-audio")
  const announcementEl = document.getElementById("announcement")
  const announcementTitleEl = document.getElementById("announcement-title")
  const announcementBodyEl = document.getElementById("announcement-body")
  const definitionEl = document.getElementById("definition")
  const definitionTermEl = document.getElementById("definition-term")
  const definitionBodyEl = document.getElementById("definition-body")
  const canvasLayerEl = document.getElementById("canvas-layer")

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

  // Media Library (ARCHITECTURE.md section 60) had server/dashboard support
  // fully built but no audience-facing display at all until this. Image/
  // video fill #media-layer (a full-frame "scene"); audio has no visual —
  // it just plays, never touching that layer's visibility.
  let activeMediaCueId = null

  // Mirrors MediaPlaybackController.computeCurrentPositionMs() exactly
  // (ARCHITECTURE.md section 60.5's timestamp-and-recompute sync model) —
  // the overlay is a separate client and must derive "where we actually
  // are" from the same formula the server used to build the payload,
  // never trust a stale positionMs as if it were still current.
  function computePositionSeconds(playback) {
    if (!playback) return 0
    if (playback.state === "paused") return playback.positionMs / 1000
    return (playback.positionMs + (Date.now() - playback.asOfServerTime)) / 1000
  }

  function syncPlayback(el, playback) {
    if (!playback) return
    const targetSeconds = computePositionSeconds(playback)
    // Only correct drift beyond ~0.4s — re-seeking on every message would
    // cause visible stutter for a value that is already close enough.
    if (Math.abs(el.currentTime - targetSeconds) > 0.4) el.currentTime = targetSeconds
    if (playback.state === "playing") el.play().catch(() => {})
    else el.pause()
  }

  function showMedia(payload) {
    const { cue, playback } = payload
    const isNewCue = activeMediaCueId !== cue.id
    activeMediaCueId = cue.id
    const url = "/media/" + cue.id

    if (cue.kind === "image") {
      mediaVideoEl.pause()
      mediaVideoEl.style.display = "none"
      mediaVideoEl.removeAttribute("src")
      mediaAudioEl.pause()
      mediaAudioEl.removeAttribute("src")
      if (isNewCue) mediaImageEl.src = url
      mediaImageEl.style.display = "block"
      mediaLayerEl.classList.add("visible")
      return
    }

    if (cue.kind === "video") {
      mediaImageEl.style.display = "none"
      mediaImageEl.removeAttribute("src")
      mediaAudioEl.pause()
      mediaAudioEl.removeAttribute("src")
      if (isNewCue) mediaVideoEl.src = url
      mediaVideoEl.style.display = "block"
      mediaLayerEl.classList.add("visible")
      syncPlayback(mediaVideoEl, playback)
      return
    }

    // audio — no visual takeover at all; whatever else is showing (verse,
    // announcement, or nothing) stays exactly as it is.
    mediaImageEl.style.display = "none"
    mediaImageEl.removeAttribute("src")
    mediaVideoEl.pause()
    mediaVideoEl.style.display = "none"
    mediaVideoEl.removeAttribute("src")
    mediaLayerEl.classList.remove("visible")
    if (isNewCue) mediaAudioEl.src = url
    syncPlayback(mediaAudioEl, playback)
  }

  function clearMedia() {
    activeMediaCueId = null
    mediaImageEl.style.display = "none"
    mediaImageEl.removeAttribute("src")
    mediaVideoEl.pause()
    mediaVideoEl.style.display = "none"
    mediaVideoEl.removeAttribute("src")
    mediaAudioEl.pause()
    mediaAudioEl.removeAttribute("src")
    mediaLayerEl.classList.remove("visible")
  }

  function showAnnouncement(payload) {
    announcementTitleEl.textContent = payload.title
    announcementBodyEl.textContent = payload.body
    announcementEl.classList.add("visible")
  }

  function clearAnnouncement() {
    announcementEl.classList.remove("visible")
  }

  function showDefinition(payload) {
    definitionTermEl.textContent = payload.term
    definitionBodyEl.textContent = payload.definition
    definitionEl.classList.add("visible")
  }

  function clearDefinition() {
    definitionEl.classList.remove("visible")
  }

  // Canvas scene (ARCHITECTURE.md section 66) — the first content type
  // rendered from a whole list of positioned layers rather than one fixed
  // template's fields. Every layer is a real DOM node, absolutely
  // positioned by percentage inside #canvas-layer (never a <canvas>/WebGL
  // surface), so each layer keeps its own font/CSS the same as the rest
  // of this page. Duplicated in apps/desktop/renderer/dashboard.js as
  // renderCanvasLayers() for the editor's own live preview — keep both in
  // sync, same no-build-step reasoning as fitVerseText()'s neighbors.
  const CANVAS_FONT_FAMILIES = {
    serif: "'Instrument Serif', Georgia, 'Times New Roman', serif",
    sans: "'Instrument Sans', -apple-system, 'Segoe UI', system-ui, sans-serif",
    mono: "'JetBrains Mono', 'SF Mono', Consolas, monospace",
  }

  function buildCanvasLayerElement(layer) {
    let el
    if (layer.kind === "text") {
      el = document.createElement("div")
      el.className = "canvas-layer-item canvas-layer-text"
      el.textContent = layer.text
      el.style.fontFamily = CANVAS_FONT_FAMILIES[layer.fontFamily] || CANVAS_FONT_FAMILIES.sans
      el.style.fontSize = layer.fontSizePx + "px"
      el.style.color = layer.color
      el.style.textAlign = layer.align
    } else if (layer.kind === "image") {
      el = document.createElement(layer.mediaKind === "video" ? "video" : "img")
      el.className = "canvas-layer-item canvas-layer-image"
      el.src = "/media/" + layer.mediaCueId
      if (layer.mediaKind === "video") {
        el.autoplay = true
        el.loop = true
        el.muted = true
        el.playsInline = true
      } else {
        el.alt = ""
      }
    } else {
      // "background" — fills the whole stage, ignoring its own x/y/width/
      // height (a background is always the full 0/0/100/100 frame by
      // definition); only its color/media choice varies.
      el = document.createElement("div")
      el.className = "canvas-layer-item"
      el.style.left = "0%"
      el.style.top = "0%"
      el.style.width = "100%"
      el.style.height = "100%"
      el.style.zIndex = layer.zIndex
      if (layer.mediaCueId) {
        const mediaEl = document.createElement(layer.mediaKind === "video" ? "video" : "img")
        mediaEl.className = "canvas-layer-media"
        mediaEl.src = "/media/" + layer.mediaCueId
        if (layer.mediaKind === "video") {
          mediaEl.autoplay = true
          mediaEl.loop = true
          mediaEl.muted = true
          mediaEl.playsInline = true
        } else {
          mediaEl.alt = ""
        }
        el.appendChild(mediaEl)
      } else if (layer.color) {
        el.style.background = layer.color
      }
      return el
    }
    el.style.left = layer.x + "%"
    el.style.top = layer.y + "%"
    el.style.width = layer.width + "%"
    el.style.height = layer.height + "%"
    el.style.zIndex = layer.zIndex
    return el
  }

  function showCanvas(payload) {
    canvasLayerEl.innerHTML = ""
    const sorted = payload.layers.slice().sort((a, b) => a.zIndex - b.zIndex)
    for (const layer of sorted) {
      canvasLayerEl.appendChild(buildCanvasLayerElement(layer))
    }
    canvasLayerEl.classList.add("visible")
  }

  function clearCanvas() {
    canvasLayerEl.classList.remove("visible")
    canvasLayerEl.innerHTML = ""
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
      } else if (message.type === "media:show") {
        showMedia(message.payload)
      } else if (message.type === "media:clear") {
        clearMedia()
      } else if (message.type === "announcement:show") {
        showAnnouncement(message.payload)
      } else if (message.type === "announcement:clear") {
        clearAnnouncement()
      } else if (message.type === "definition:show") {
        showDefinition(message.payload)
      } else if (message.type === "definition:clear") {
        clearDefinition()
      } else if (message.type === "canvas:show") {
        showCanvas(message.payload)
      } else if (message.type === "canvas:clear") {
        clearCanvas()
      }
    })
  }

  // Local emergency clear (ARCHITECTURE.md section 35): must not require
  // a server round trip, and must never become a channel for issuing
  // application commands — this only ever hides the LOCAL visual state.
  // "local visual state" is the whole overlay, not just the verse card —
  // an operator hitting Escape in an emergency needs everything gone, not
  // just whichever content type happened to be on screen.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      clearVerse()
      clearMedia()
      clearAnnouncement()
      clearDefinition()
      clearCanvas()
    }
  })

  // Re-fit on resize (the overlay preview window is resizable; a fixed
  // OBS Browser Source size won't fire this, which is fine — it only
  // needs to fit once, at whatever size it was given).
  window.addEventListener("resize", () => {
    if (verseEl.classList.contains("visible")) fitVerseText()
  })

  connect()
})()
