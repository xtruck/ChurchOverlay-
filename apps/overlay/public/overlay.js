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
  const brandNameEl = document.getElementById("brand-name")
  const brandLogoEl = document.getElementById("brand-logo")
  const posterLayerEl = document.getElementById("poster-layer")
  const posterImageEl = document.getElementById("poster-image")
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
  const outlineLayerEl = document.getElementById("outline-layer")
  const outlineBadgeEl = document.getElementById("outline-badge")
  const outlineTitleEl = document.getElementById("outline-title")
  const outlineTextEl = document.getElementById("outline-text")

  // The connection pill is a diagnostic, not content: it used to stay on
  // the congregation screen (and in the stream) for the whole service.
  // It starts hidden (index.html), is hidden the moment the socket is
  // connected, and appears only when a problem outlasts a short grace period
  // — so a normal page load or a sub-second reconnect never puts diagnostic
  // chrome on the stream. `immediate` is for states no retry will fix
  // (missing token), which should be visible straight away.
  const STATUS_GRACE_MS = 1500
  let statusShowTimer = null
  function setStatus(text, healthy, immediate) {
    statusEl.textContent = text
    clearTimeout(statusShowTimer)
    if (healthy) {
      statusEl.classList.add("status-hidden")
      return
    }
    if (immediate) {
      statusEl.classList.remove("status-hidden")
      return
    }
    if (statusEl.classList.contains("status-hidden")) {
      statusShowTimer = setTimeout(() => statusEl.classList.remove("status-hidden"), STATUS_GRACE_MS)
    }
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

  // ARCHITECTURE.md section 72: canonical (English) book id -> proper
  // French display name, WITH accents/capitalization restored for display
  // — deliberately separate from RegexDetector's FRENCH_BOOK_ALIASES
  // (apps/server/detector/regex-detector.ts), which strips accents for
  // robust *matching* and can't be reused as-is for display. Duplicated
  // here rather than sent over the wire: this is static, non-secret
  // reference data, the same "duplicated, not shared, no build step"
  // precedent as float32ToInt16/reconnect-backoff elsewhere in this file.
  const FRENCH_BOOK_NAMES = {
    genesis: "Genèse", exodus: "Exode", leviticus: "Lévitique", numbers: "Nombres",
    deuteronomy: "Deutéronome", joshua: "Josué", judges: "Juges", ruth: "Ruth",
    "1 samuel": "1 Samuel", "2 samuel": "2 Samuel", "1 kings": "1 Rois", "2 kings": "2 Rois",
    "1 chronicles": "1 Chroniques", "2 chronicles": "2 Chroniques", ezra: "Esdras",
    nehemiah: "Néhémie", esther: "Esther", job: "Job", psalm: "Psaumes",
    proverbs: "Proverbes", ecclesiastes: "Ecclésiaste", "song of solomon": "Cantique des Cantiques",
    isaiah: "Ésaïe", jeremiah: "Jérémie", lamentations: "Lamentations", ezekiel: "Ézéchiel",
    daniel: "Daniel", hosea: "Osée", joel: "Joël", amos: "Amos", obadiah: "Abdias",
    jonah: "Jonas", micah: "Michée", nahum: "Nahum", habakkuk: "Habacuc",
    zephaniah: "Sophonie", haggai: "Aggée", zechariah: "Zacharie", malachi: "Malachie",
    matthew: "Matthieu", mark: "Marc", luke: "Luc", john: "Jean", acts: "Actes",
    romans: "Romains", "1 corinthians": "1 Corinthiens", "2 corinthians": "2 Corinthiens",
    galatians: "Galates", ephesians: "Éphésiens", philippians: "Philippiens",
    colossians: "Colossiens", "1 thessalonians": "1 Thessaloniciens",
    "2 thessalonians": "2 Thessaloniciens", "1 timothy": "1 Timothée", "2 timothy": "2 Timothée",
    titus: "Tite", philemon: "Philémon", hebrews: "Hébreux", james: "Jacques",
    "1 peter": "1 Pierre", "2 peter": "2 Pierre", "1 john": "1 Jean", "2 john": "2 Jean",
    "3 john": "3 Jean", jude: "Jude", revelation: "Apocalypse",
  }

  function formatReference(ref) {
    return capitalize(ref.book) + " " + ref.chapter + ":" + ref.verse
  }

  // French-only display used to show the ENGLISH book name ("John 3:16")
  // under a French verse. The verse's own translation id says which
  // language the congregation is reading — Louis Segond 1910 is "ls1910".
  // ARCHITECTURE.md section 107: "darby" (J.N. Darby, French, public
  // domain) added alongside the existing Louis Segond aliases — both name
  // a French-language translation, so both should render French book names.
  const FRENCH_TRANSLATIONS = new Set(["ls1910", "lsg", "segond", "darby"])
  function formatVerseReference(verse) {
    const ref = verse.reference
    if (verse.secondary) return formatBilingualReference(ref)
    if (FRENCH_TRANSLATIONS.has(String(verse.translation || "").toLowerCase())) {
      return (FRENCH_BOOK_NAMES[ref.book] || capitalize(ref.book)) + " " + ref.chapter + ":" + ref.verse
    }
    return formatReference(ref)
  }

  // ARCHITECTURE.md section 72: a viewer confirmed both languages must be
  // visible in bilingual mode, not just the verse text — the reference
  // line was showing only the English book name even while the verse
  // itself displayed in French, which read as a mismatch/bug ("I say
  // Jean, it shows John"). verse.secondary only exists in bilingual mode
  // (LocalizedVerseSource), so its presence is exactly the right signal —
  // French first, matching the primary/secondary text hierarchy below.
  function formatBilingualReference(ref) {
    const frenchName = FRENCH_BOOK_NAMES[ref.book]
    const frenchRef = (frenchName || capitalize(ref.book)) + " " + ref.chapter + ":" + ref.verse
    return frenchRef + " · " + formatReference(ref)
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
  const MIN_FONT_PX = 14
  const SECONDARY_FONT_RATIO = 0.55 // matches the visual hierarchy already set in CSS's own clamp() sizing
  const MIN_SECONDARY_FONT_PX = 10
  const MAX_HEIGHT_FRACTION = 0.84
  const MAX_WIDTH_FRACTION = 0.9

  // ARCHITECTURE.md section 82: fitVerseText() sets an inline font-size,
  // which always wins over the CSS clamp()s on #verse.fullscreen — so
  // without a separate, much larger cap here, a fullscreen verse would
  // still render at the same size as lower-third, wasting the entire
  // point of "seen from across a room." Bigger max, and bigger available
  // area (the card now fills the whole viewport, not a bottom third).
  const FULLSCREEN_MAX_FONT_PX = 120
  const FULLSCREEN_MIN_FONT_PX = 18
  const FULLSCREEN_MAX_HEIGHT_FRACTION = 0.9
  const FULLSCREEN_MAX_WIDTH_FRACTION = 0.9

  function clearVerseSizing() {
    textEl.style.fontSize = ""
    secondaryTextEl.style.fontSize = ""
    verseCardEl.style.transform = ""
  }

  function fitVerseText() {
    if (!verseEl.classList.contains("visible")) return
    const isFullscreen = verseEl.classList.contains("fullscreen")
    const maxWidth = window.innerWidth * (isFullscreen ? FULLSCREEN_MAX_WIDTH_FRACTION : MAX_WIDTH_FRACTION)
    const maxHeight = window.innerHeight * (isFullscreen ? FULLSCREEN_MAX_HEIGHT_FRACTION : MAX_HEIGHT_FRACTION)
    const maxFontPx = isFullscreen ? FULLSCREEN_MAX_FONT_PX : MAX_FONT_PX
    const minFontPx = isFullscreen ? FULLSCREEN_MIN_FONT_PX : MIN_FONT_PX
    clearVerseSizing()
    let fontSize = maxFontPx
    textEl.style.fontSize = fontSize + "px"
    if (secondaryTextEl.classList.contains("visible")) {
      secondaryTextEl.style.fontSize = Math.max(MIN_SECONDARY_FONT_PX, fontSize * SECONDARY_FONT_RATIO) + "px"
    }
    while ((verseCardEl.scrollWidth > maxWidth || verseCardEl.scrollHeight > maxHeight) && fontSize > minFontPx) {
      fontSize -= 1
      textEl.style.fontSize = fontSize + "px"
      if (secondaryTextEl.classList.contains("visible")) {
        secondaryTextEl.style.fontSize = Math.max(MIN_SECONDARY_FONT_PX, fontSize * SECONDARY_FONT_RATIO) + "px"
      }
    }

    // Extremely long bilingual passages can still exceed the viewport at the
    // legibility floor. Scale the complete card as a last resort rather than
    // clipping or allowing it to escape the screen.
    const overflowWidth = verseCardEl.scrollWidth / maxWidth
    const overflowHeight = verseCardEl.scrollHeight / maxHeight
    const scale = Math.min(1, 1 / Math.max(overflowWidth, overflowHeight))
    if (scale < 1) verseCardEl.style.transform = `scale(${scale})`
  }

  function showVerse(verse) {
    textEl.textContent = verse.text
    refEl.textContent = formatVerseReference(verse)

    if (verse.secondary) {
      secondaryTextEl.textContent = verse.secondary.text
      secondaryTextEl.classList.add("visible")
    } else {
      secondaryTextEl.classList.remove("visible")
      secondaryTextEl.textContent = ""
    }

    verseEl.classList.add("visible")
    // Restart the reveal even if a verse is already on screen: removing the
    // class and forcing a reflow lets the same keyframes play again.
    verseCardEl.classList.remove("reveal")
    void verseCardEl.offsetWidth
    verseCardEl.classList.add("reveal")
    requestAnimationFrame(() => fitVerseText())
  }

  function clearVerse() {
    verseEl.classList.remove("visible")
  }

  // ARCHITECTURE.md section 82 — "fullscreen" is the confirmed default
  // (matches the CSS's own unprefixed #verse rules being the lower-third
  // base and .fullscreen being the override... but the class itself
  // starts ABSENT until the server's own layout:update arrives, so a
  // brand-new connection defaults to fullscreen here too, before the
  // first real message even lands, keeping the very first render correct
  // rather than lower-third-then-flip).
  verseEl.classList.add("fullscreen")

  function setVerseLayout(layout) {
    verseEl.classList.toggle("fullscreen", layout === "fullscreen")
    if (verseEl.classList.contains("visible")) requestAnimationFrame(() => fitVerseText())
  }

  // ARCHITECTURE.md section 110: the whole look (palette, card design, church
  // name and logo) arrives as ONE server-validated `overlay:style` event, sent
  // on connect and on every operator edit. This page only ever READS it
  // (section 20: the overlay is a viewer, never a control client) and writes
  // it into CSS custom properties / textContent, never innerHTML.
  // branding:update is still received for older servers but no longer drives
  // anything visual: organization name and accent now live in the style.
  const CARD_CLASSES = ["tpl-banner", "tpl-minimal", "tpl-elegant", "tpl-glass", "tpl-ribbon"]
  const BRAND_FONTS = {
    serif: '"Instrument Serif", Georgia, "Times New Roman", serif',
    sans: '"Instrument Sans", -apple-system, "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "SF Mono", Consolas, monospace',
  }
  const HEX = /^#[0-9a-fA-F]{6}$/
  // Revisions order updates (section 22). Reset on every (re)connect so a
  // restarted server, whose counter starts again, never looks "stale".
  let lastStyleRevision = -1

  function rgbTriple(hex) {
    return parseInt(hex.slice(1, 3), 16) + ", " + parseInt(hex.slice(3, 5), 16) + ", " + parseInt(hex.slice(5, 7), 16)
  }
  // 40% toward black: the bottom of the fullscreen backdrop gradient.
  function darken(hex) {
    const part = (i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.6).toString(16).padStart(2, "0")
    return "#" + part(1) + part(3) + part(5)
  }
  function isDark(hex) {
    const lum = (0.2126 * parseInt(hex.slice(1, 3), 16) + 0.7152 * parseInt(hex.slice(3, 5), 16) + 0.0722 * parseInt(hex.slice(5, 7), 16)) / 255
    return lum < 0.45
  }
  function setVar(name, value) {
    document.documentElement.style.setProperty(name, value)
  }
  function placeBrandItem(el, item) {
    el.style.left = item.x + "%"
    el.style.top = item.y + "%"
    el.style.opacity = String(item.opacity)
    el.style.transform = "translate(-50%, -50%) rotate(" + item.rotation + "deg) scale(" + item.scale + ")"
  }

  function applyOverlayStyle(style) {
    if (!style || typeof style.revision !== "number" || style.revision <= lastStyleRevision) return
    const c = style.colors
    if (!c || ![c.backdrop, c.card, c.text, c.textSecondary, c.accent, c.border].every((v) => typeof v === "string" && HEX.test(v))) return
    lastStyleRevision = style.revision

    setVar("--accent", c.accent)
    setVar("--accent-rgb", rgbTriple(c.accent))
    setVar("--ov-card-rgb", rgbTriple(c.card))
    setVar("--ov-card-a", String(c.cardOpacity))
    setVar("--ov-text", c.text)
    setVar("--ov-text2", c.textSecondary)
    setVar("--ov-border", c.border)
    setVar("--ov-backdrop", c.backdrop)
    setVar("--ov-backdrop-2", darken(c.backdrop))
    // Dark text sits on a light card: the heavy black halo made it look smudged,
    // so it gets a faint light edge instead. Light text keeps the legibility halo.
    setVar("--ov-shadow", isDark(c.text) ? "0 1px 1px rgba(255, 255, 255, 0.35)" : "0 2px 10px rgba(0, 0, 0, 0.85)")

    verseCardEl.classList.remove(...CARD_CLASSES)
    if (style.card && style.card !== "classic") verseCardEl.classList.add("tpl-" + style.card)
    verseCardEl.classList.toggle("no-card", c.cardOpacity === 0)

    const name = style.brand && style.brand.name
    if (name && name.visible && name.text) {
      brandNameEl.textContent = name.text
      brandNameEl.style.fontFamily = BRAND_FONTS[name.font] || BRAND_FONTS.sans
      brandNameEl.style.fontWeight = String(name.weight)
      brandNameEl.style.setProperty("--brand-size", String(name.size))
      if (name.color && HEX.test(name.color)) brandNameEl.style.setProperty("--brand-color", name.color)
      else brandNameEl.style.removeProperty("--brand-color")
      brandNameEl.classList.toggle("plate", !!name.plate)
      placeBrandItem(brandNameEl, name)
      brandNameEl.classList.add("visible")
    } else {
      brandNameEl.classList.remove("visible")
    }

    const logo = style.brand && style.brand.logo
    if (logo && logo.visible && logo.version > 0) {
      const src = "/brand/logo?v=" + logo.version
      if (brandLogoEl.getAttribute("src") !== src) brandLogoEl.setAttribute("src", src)
      placeBrandItem(brandLogoEl, logo)
      brandLogoEl.classList.add("visible")
    } else {
      brandLogoEl.classList.remove("visible")
      brandLogoEl.removeAttribute("src")
    }

    if (designPreview) requestAnimationFrame(reportBrandRects)

    // Colours and card chrome change the card's box: refit the verse text.
    if (verseEl.classList.contains("visible")) requestAnimationFrame(() => fitVerseText())
  }

  // The dashboard's design preview (section 110.7): a clearly-placeholder
  // card, shown only in that preview. It carries no Bible text, so nothing
  // here can display an unverified verse (sections 13-14).
  const designPreview = params.get("designPreview") === "1"
  // Outbound only, and only inside the dashboard's design preview: tells the
  // editor where each brand item really is (percent of the frame) so its drag
  // handles fit. The page never listens for messages, so this is not a
  // control channel (section 20).
  function rectPercent(el) {
    if (!el.classList.contains("visible")) return null
    const r = el.getBoundingClientRect()
    return { left: (r.left / window.innerWidth) * 100, top: (r.top / window.innerHeight) * 100, width: (r.width / window.innerWidth) * 100, height: (r.height / window.innerHeight) * 100 }
  }
  function reportBrandRects() {
    if (window.parent === window) return
    window.parent.postMessage({ type: "churchoverlay:brand-rects", name: rectPercent(brandNameEl), logo: rectPercent(brandLogoEl) }, "*")
  }
  if (designPreview) {
    brandLogoEl.addEventListener("load", reportBrandRects)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(reportBrandRects)
  }
  function showDesignSample() {
    textEl.textContent = "This is how your verse will look."
    refEl.textContent = "Reference 1:1"
    secondaryTextEl.classList.remove("visible")
    verseEl.classList.add("visible")
    requestAnimationFrame(() => fitVerseText())
  }

  let resizeTimer = 0
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => fitVerseText(), 80)
  })
  if (document.fonts?.ready) document.fonts.ready.then(() => fitVerseText())

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

  // Principal poster (ARCHITECTURE.md section 67) — a persistent backdrop,
  // not a scene. No playback/position sync needed (posters are always a
  // static image, enforced server-side) and no "restore" logic: this
  // layer is simply always on while a poster is appointed, sitting at the
  // lowest z-index so everything else already renders correctly on top
  // of it without either side needing to know about the other.
  function showPoster(payload) {
    posterImageEl.src = "/media/" + payload.cue.id
    posterLayerEl.classList.add("visible")
  }

  function clearPoster() {
    posterImageEl.removeAttribute("src")
    posterLayerEl.classList.remove("visible")
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

  let outlineAutoClearTimer = null
  function showOutline(payload) {
    if (!outlineLayerEl) return
    clearTimeout(outlineAutoClearTimer)
    outlineBadgeEl.textContent = `POINT ${payload.pointNumber || 1}`
    outlineTitleEl.textContent = payload.title || ""
    if (payload.text) {
      outlineTextEl.textContent = payload.text
      outlineTextEl.style.display = "block"
    } else {
      outlineTextEl.style.display = "none"
    }
    outlineLayerEl.classList.add("visible")
    // Auto-fade outline point after 14s unless dismissed
    outlineAutoClearTimer = setTimeout(clearOutline, 14000)
  }

  function clearOutline() {
    clearTimeout(outlineAutoClearTimer)
    if (outlineLayerEl) outlineLayerEl.classList.remove("visible")
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
      setStatus("no viewer token in URL (add ?token=...)", false, true)
      return
    }
    setStatus("connecting…")
    // ARCHITECTURE.md section 65.6: once allowPhoneRemote is on, the WS
    // server binds to 0.0.0.0 (LAN-reachable), and this overlay page can
    // just as well be opened from a different machine on the network
    // (e.g. a separate OBS PC) as from the same one serving it. Using
    // window.location.hostname — the address this very page was loaded
    // from — instead of a hardcoded "127.0.0.1" is exactly the fix
    // remote.js already applies for the identical reason (its own
    // comment above this line's counterpart). A same-machine setup still
    // works unchanged: window.location.hostname is "127.0.0.1" (or
    // "localhost") in that case too.
    const ws = new WebSocket("ws://" + window.location.hostname + ":" + wsPort, [token])

    ws.addEventListener("open", () => {
      // While this socket was down the operator may have cleared the screen,
      // and a clear sent to nobody is lost. The server's connect-time resync
      // re-sends verse/media/poster only if one is active, and never sends a
      // clear — so without this, a verse cleared during a Wi-Fi blip stays on
      // the stream. Reset exactly the channels the server resyncs; the open
      // event fires before any message of this connection, so a still-active
      // item is simply shown again a moment later.
      if (!designPreview) {
        clearVerse()
        clearMedia()
        clearPoster()
      }
      lastStyleRevision = -1
      reconnectAttempts = 0
      setStatus("connected", true)
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
      // The design preview shows only its placeholder, never live content.
      if (designPreview && (message.type === "verse:show" || message.type === "verse:clear")) return
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
      } else if (message.type === "poster:show") {
        showPoster(message.payload)
      } else if (message.type === "poster:clear") {
        clearPoster()
      } else if (message.type === "layout:update") {
        setVerseLayout(message.payload.layout)
      } else if (message.type === "overlay:style") {
        applyOverlayStyle(message.payload)
      } else if (message.type === "outline:show") {
        showOutline(message.payload)
      } else if (message.type === "outline:clear") {
        clearOutline()
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
    if (event.key === "Escape" && !designPreview) {
      clearVerse()
      clearMedia()
      clearAnnouncement()
      clearDefinition()
      clearOutline()
      clearCanvas()
    }
  })

  // Re-fit on resize (the overlay preview window is resizable; a fixed
  // OBS Browser Source size won't fire this, which is fine — it only
  // needs to fit once, at whatever size it was given).
  window.addEventListener("resize", () => {
    if (verseEl.classList.contains("visible")) fitVerseText()
  })

  if (designPreview) showDesignSample()
  connect()
})()
