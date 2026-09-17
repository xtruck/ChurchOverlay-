// Plain browser JS (no build step) loaded into the Electron dashboard
// BrowserWindow via file loadFile() + a local relative <script src>. Runs
// with nodeIntegration:false/contextIsolation:true — its only path to
// main-process capability is window.churchOverlay, exposed by
// apps/desktop/preload/index.ts.
;(function () {
  const CANONICAL_SAMPLE_RATE = 16000

  // Duplicated from packages/shared/pcm-convert.ts and
  // audio-frame-codec.ts rather than imported: this file has no build
  // step (no bundler is set up in this project, and adding one solely to
  // share ~20 lines of pure math between a Node backend and a browser
  // frontend would be a disproportionate architectural decision for a
  // "small v1" — AGENTS.md sections 40-41). These two functions MUST stay
  // byte-for-byte identical to those files; if either changes, update
  // both. This tradeoff is called out explicitly rather than silently
  // duplicated and forgotten.
  function float32ToInt16(samples) {
    const output = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]))
      output[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
    }
    return output
  }

  function encodeAudioFrame(samples, sequence) {
    const buffer = new ArrayBuffer(4 + samples.length * 2)
    const view = new DataView(buffer)
    view.setUint32(0, sequence, true)
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(4 + i * 2, samples[i], true)
    }
    return buffer
  }

  const statusPillEl = document.getElementById("status-pill")
  const statusTextEl = document.getElementById("status-text")
  const logEl = document.getElementById("log")
  const transcriptEl = document.getElementById("transcript")
  const referenceInput = document.getElementById("reference")
  const showBtn = document.getElementById("show-btn")
  const clearBtn = document.getElementById("clear-btn")
  const micStartBtn = document.getElementById("mic-start-btn")
  const micStopBtn = document.getElementById("mic-stop-btn")
  const micVisualEl = document.getElementById("mic-visual")
  const liveVerseEmptyEl = document.getElementById("live-verse-empty")
  const liveVerseTextEl = document.getElementById("live-verse-text")
  const liveVerseRefEl = document.getElementById("live-verse-ref")
  const setupScreenEl = document.getElementById("setup-screen")
  const appShellEl = document.getElementById("app-shell")
  const setupKeyInput = document.getElementById("setup-groq-key")
  const setupErrorEl = document.getElementById("setup-error")
  const setupSaveBtn = document.getElementById("setup-save-btn")
  const mediaGridEl = document.getElementById("media-grid")
  const mediaImportBtn = document.getElementById("media-import-btn")
  const displayModeToggleEl = document.getElementById("display-mode-toggle")
  const uiLanguageToggleEl = document.getElementById("ui-language-toggle")
  const setupDisplayModeEl = document.getElementById("setup-display-mode")
  const setupUiLanguageEl = document.getElementById("setup-ui-language")
  const mediaNowPlayingEl = document.getElementById("media-now-playing")
  const mediaNowPlayingTitleEl = document.getElementById("media-now-playing-title")
  const mediaPlayPauseBtn = document.getElementById("media-play-pause-btn")
  const mediaStopBtn = document.getElementById("media-stop-btn")
  const rundownSceneListEl = document.getElementById("rundown-scene-list")
  const rundownPrevBtn = document.getElementById("rundown-prev-btn")
  const rundownNextBtn = document.getElementById("rundown-next-btn")
  const rundownBuilderToggleBtn = document.getElementById("rundown-builder-toggle-btn")
  const rundownBuilderEl = document.getElementById("rundown-builder")
  const rundownSceneKindEl = document.getElementById("rundown-scene-kind")
  const rundownFieldVerseEl = document.getElementById("rundown-field-verse")
  const rundownFieldMediaEl = document.getElementById("rundown-field-media")
  const rundownFieldAnnouncementEl = document.getElementById("rundown-field-announcement")
  const rundownVerseInput = document.getElementById("rundown-verse-input")
  const rundownMediaSelectEl = document.getElementById("rundown-media-select")
  const rundownAnnouncementTitleInput = document.getElementById("rundown-announcement-title")
  const rundownAnnouncementBodyInput = document.getElementById("rundown-announcement-body")
  const rundownAddSceneBtn = document.getElementById("rundown-add-scene-btn")
  const rundownDraftListEl = document.getElementById("rundown-draft-list")
  const rundownLoadBtn = document.getElementById("rundown-load-btn")

  const t = (key, params) => window.i18n.t(key, params)

  let ws = null
  let audioContext = null
  let mediaStream = null
  let knownCues = []
  let activeCueId = null
  let activePlaybackState = null // "playing" | "paused" | null (null: no active cue, or an image with no playback concept)
  let setupSelectedMode = "english"
  let setupSelectedUiLanguage = "en"

  // ARCHITECTURE.md section 64.5's authoring UI. `rundown:state` broadcasts
  // only the CURRENT scene (ARCHITECTURE.md section 64.4), not the whole
  // scene list — so the full list rendered here is whatever this dashboard
  // itself last loaded via rundown:load. If a rundown was loaded some other
  // way (or before this dashboard connected), loadedRundownScenes won't
  // match and the scene list falls back to showing just the one active
  // scene rather than guessing at a list it never actually saw.
  let draftScenes = []
  let draftSelectedKind = "verse"
  let loadedRundownScenes = []
  let loadedRundownId = null
  let currentRundownState = null // last rundown:state payload, or null if no rundown is active

  // Bounded, backoff-aware reconnect (ARCHITECTURE.md section 48, AGENTS.md
  // section 37 — "infinite retry loops" specifically forbidden). This is
  // the operator's always-on console for a live service, so it must keep
  // trying indefinitely rather than give up after N attempts — "bounded"
  // here means the DELAY is capped and grows via backoff, not that
  // reconnection ever stops. Duplicated (not shared) with overlay.js's
  // identical copy — same no-build-step reasoning as float32ToInt16 above.
  const BASE_RECONNECT_DELAY_MS = 1000
  const MAX_RECONNECT_DELAY_MS = 30000
  let reconnectAttempts = 0

  function nextReconnectDelay() {
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
    reconnectAttempts += 1
    return delay
  }

  function log(text, kind) {
    const line = document.createElement("div")
    line.className = "log-line" + (kind ? " event-" + kind : "")
    const time = document.createElement("span")
    time.className = "log-time"
    time.textContent = new Date().toLocaleTimeString()
    const body = document.createElement("span")
    body.className = "log-text"
    body.textContent = text
    line.append(time, body)
    logEl.prepend(line)
    while (logEl.children.length > 50) logEl.removeChild(logEl.lastChild)
  }

  function setStatus(text, state) {
    statusTextEl.textContent = text
    statusPillEl.className = "status-pill " + state
  }

  function capitalize(book) {
    return book.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  function showLiveVerse(verse) {
    liveVerseEmptyEl.style.display = "none"
    liveVerseTextEl.style.display = "block"
    liveVerseRefEl.style.display = "block"
    liveVerseTextEl.textContent = verse.text
    const ref = verse.reference
    liveVerseRefEl.textContent = capitalize(ref.book) + " " + ref.chapter + ":" + ref.verse
  }

  function clearLiveVerse() {
    liveVerseEmptyEl.style.display = "block"
    liveVerseTextEl.style.display = "none"
    liveVerseRefEl.style.display = "none"
  }

  // One icon per MediaCueKind (apps/server/media's own "kind" discriminant,
  // packages/contracts/media.ts) — plain inline SVG, never an emoji, per
  // the design system's own icon rule.
  const MEDIA_ICONS = {
    image:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5-9 9"/>',
    video: '<rect x="2.5" y="5.5" width="14" height="13" rx="2"/><path d="m20.5 9 v6 l-4-3z"/>',
    audio:
      '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  }

  function mediaIconSvg(kind) {
    const paths = MEDIA_ICONS[kind] || MEDIA_ICONS.image
    return (
      '<svg class="media-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
      paths +
      "</svg>"
    )
  }

  function renderMediaGrid() {
    mediaGridEl.innerHTML = ""
    if (knownCues.length === 0) {
      const empty = document.createElement("div")
      empty.className = "media-empty"
      empty.textContent = t("media.empty")
      mediaGridEl.appendChild(empty)
      return
    }
    for (const cue of knownCues) {
      const tile = document.createElement("div")
      tile.className = "media-tile" + (cue.id === activeCueId ? " active" : "")
      tile.title = cue.title
      tile.innerHTML = mediaIconSvg(cue.kind) + '<div class="media-tile-title"></div>'
      tile.querySelector(".media-tile-title").textContent = cue.title
      tile.addEventListener("click", () => {
        sendJson({ id: crypto.randomUUID(), type: "media:select", timestamp: Date.now(), payload: { id: cue.id } })
        log(t("log.sentMediaSelect", { title: cue.title }), "sent")
      })
      mediaGridEl.appendChild(tile)
    }
  }

  function loadMediaCues() {
    window.churchOverlay
      .listMediaCues()
      .then((cues) => {
        knownCues = cues
        renderMediaGrid()
        renderRundownMediaOptions()
      })
      .catch((err) => log(t("log.mediaLoadFailed", { error: err.message }), "error"))
  }

  // One icon per RundownScene kind (packages/contracts/rundown.ts) — same
  // plain-inline-SVG convention as MEDIA_ICONS above, sized for the smaller
  // chip context via the .chip-icon class rather than .media-tile-icon.
  const SCENE_ICONS = {
    verse: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    media: '<rect x="2.5" y="5.5" width="14" height="13" rx="2"/><path d="m20.5 9 v6 l-4-3z"/>',
    announcement: '<path d="M3 11v2a2 2 0 0 0 2 2h1l4 4V5L6 9H5a2 2 0 0 0-2 2z"/><path d="M17 8a5 5 0 0 1 0 8"/>',
    blank: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  }

  function sceneIconSvg(kind) {
    const paths = SCENE_ICONS[kind] || SCENE_ICONS.blank
    return (
      '<svg class="chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
      paths +
      "</svg>"
    )
  }

  function sceneSummary(scene) {
    switch (scene.kind) {
      case "verse":
        return capitalize(scene.reference.book) + " " + scene.reference.chapter + ":" + scene.reference.verse
      case "media": {
        const cue = knownCues.find((c) => c.id === scene.mediaCueId)
        return cue ? cue.title : t("rundown.unknownMedia")
      }
      case "announcement":
        return scene.title
      case "blank":
        return t("rundown.blankLabel")
    }
  }

  function renderRundownMediaOptions() {
    rundownMediaSelectEl.innerHTML = ""
    if (knownCues.length === 0) {
      const option = document.createElement("option")
      option.value = ""
      option.textContent = t("rundown.builder.noMediaOption")
      rundownMediaSelectEl.appendChild(option)
      return
    }
    for (const cue of knownCues) {
      const option = document.createElement("option")
      option.value = cue.id
      option.textContent = cue.title
      rundownMediaSelectEl.appendChild(option)
    }
  }

  // The currently-active rundown (this dashboard's own scene list, click-
  // to-jump via scene:goto). Rendered separately from the builder's draft
  // list below, even though both use the same .rundown-scene-chip look.
  function renderRundownSceneList() {
    rundownSceneListEl.innerHTML = ""
    if (!currentRundownState) {
      const empty = document.createElement("div")
      empty.className = "rundown-empty"
      empty.textContent = t("rundown.empty")
      rundownSceneListEl.appendChild(empty)
      rundownPrevBtn.disabled = true
      rundownNextBtn.disabled = true
      return
    }
    rundownPrevBtn.disabled = false
    rundownNextBtn.disabled = false

    const knowsFullList = loadedRundownId === currentRundownState.rundownId && loadedRundownScenes.length > 0
    const scenes = knowsFullList ? loadedRundownScenes : [currentRundownState.scene]
    const activeIndex = knowsFullList ? currentRundownState.cursor : 0

    scenes.forEach((scene, index) => {
      const isActive = index === activeIndex
      const chip = document.createElement("div")
      chip.className =
        "rundown-scene-chip" + (isActive ? " active" : "") + (isActive && currentRundownState.interrupted ? " interrupted" : "")
      if (isActive && currentRundownState.interrupted) chip.title = t("rundown.interruptedHint")
      chip.innerHTML = sceneIconSvg(scene.kind) + "<span></span>"
      chip.querySelector("span").textContent = sceneSummary(scene)
      chip.addEventListener("click", () => {
        sendJson({ id: crypto.randomUUID(), type: "scene:goto", timestamp: Date.now(), payload: { index } })
        log(t("log.sentSceneGoto", { index }), "sent")
      })
      rundownSceneListEl.appendChild(chip)
    })
  }

  function renderDraftSceneList() {
    rundownDraftListEl.innerHTML = ""
    if (draftScenes.length === 0) {
      const empty = document.createElement("div")
      empty.className = "rundown-empty"
      empty.textContent = t("rundown.builder.draftEmpty")
      rundownDraftListEl.appendChild(empty)
      return
    }
    draftScenes.forEach((scene, index) => {
      const chip = document.createElement("div")
      chip.className = "rundown-scene-chip"
      chip.innerHTML = sceneIconSvg(scene.kind) + "<span></span>"
      chip.querySelector("span").textContent = sceneSummary(scene)

      const up = document.createElement("span")
      up.className = "chip-action"
      up.textContent = "↑"
      up.title = t("rundown.builder.moveUp")
      up.addEventListener("click", (event) => {
        event.stopPropagation()
        if (index === 0) return
        ;[draftScenes[index - 1], draftScenes[index]] = [draftScenes[index], draftScenes[index - 1]]
        renderDraftSceneList()
      })

      const down = document.createElement("span")
      down.className = "chip-action"
      down.textContent = "↓"
      down.title = t("rundown.builder.moveDown")
      down.addEventListener("click", (event) => {
        event.stopPropagation()
        if (index === draftScenes.length - 1) return
        ;[draftScenes[index], draftScenes[index + 1]] = [draftScenes[index + 1], draftScenes[index]]
        renderDraftSceneList()
      })

      const remove = document.createElement("span")
      remove.className = "chip-action chip-remove"
      remove.textContent = "×"
      remove.addEventListener("click", (event) => {
        event.stopPropagation()
        draftScenes.splice(index, 1)
        renderDraftSceneList()
      })

      chip.append(up, down, remove)
      rundownDraftListEl.appendChild(chip)
    })
  }

  function showLiveAnnouncement(payload) {
    liveVerseEmptyEl.style.display = "none"
    liveVerseTextEl.style.display = "block"
    liveVerseRefEl.style.display = "block"
    liveVerseTextEl.textContent = payload.body
    liveVerseRefEl.textContent = payload.title
  }

  rundownBuilderToggleBtn.addEventListener("click", () => {
    const isHidden = rundownBuilderEl.style.display === "none"
    rundownBuilderEl.style.display = isHidden ? "block" : "none"
    rundownBuilderToggleBtn.textContent = isHidden ? t("rundown.buildButtonClose") : t("rundown.buildButton")
  })

  function updateRundownBuilderFieldsVisibility() {
    rundownFieldVerseEl.style.display = draftSelectedKind === "verse" ? "block" : "none"
    rundownFieldMediaEl.style.display = draftSelectedKind === "media" ? "block" : "none"
    rundownFieldAnnouncementEl.style.display = draftSelectedKind === "announcement" ? "block" : "none"
  }

  wireOptionGroup(rundownSceneKindEl, "kind", (kind) => {
    draftSelectedKind = kind
    updateRundownBuilderFieldsVisibility()
  })

  rundownAddSceneBtn.addEventListener("click", () => {
    let scene
    if (draftSelectedKind === "verse") {
      const reference = parseReference(rundownVerseInput.value)
      if (!reference) {
        log(t("log.parseError", { text: rundownVerseInput.value }), "error")
        return
      }
      scene = { kind: "verse", reference }
      rundownVerseInput.value = ""
    } else if (draftSelectedKind === "media") {
      const mediaCueId = rundownMediaSelectEl.value
      if (!mediaCueId) {
        log(t("rundown.builder.noMediaSelected"), "error")
        return
      }
      scene = { kind: "media", mediaCueId }
    } else if (draftSelectedKind === "announcement") {
      const title = rundownAnnouncementTitleInput.value.trim()
      const body = rundownAnnouncementBodyInput.value.trim()
      if (!title || !body) {
        log(t("rundown.builder.announcementIncomplete"), "error")
        return
      }
      scene = { kind: "announcement", title, body }
      rundownAnnouncementTitleInput.value = ""
      rundownAnnouncementBodyInput.value = ""
    } else {
      scene = { kind: "blank" }
    }
    draftScenes.push(scene)
    renderDraftSceneList()
  })

  rundownLoadBtn.addEventListener("click", () => {
    if (draftScenes.length === 0) {
      log(t("rundown.builder.emptyRundownError"), "error")
      return
    }
    const rundown = { id: crypto.randomUUID(), title: t("rundown.defaultTitle"), scenes: draftScenes.slice() }
    loadedRundownId = rundown.id
    loadedRundownScenes = draftScenes.slice()
    sendJson({ id: crypto.randomUUID(), type: "rundown:load", timestamp: Date.now(), payload: { rundown } })
    log(t("log.sentRundownLoad", { count: rundown.scenes.length }), "sent")

    // Collapse the builder after loading — attention should go back to the
    // now-active scene list, not stay on the builder form.
    rundownBuilderEl.style.display = "none"
    rundownBuilderToggleBtn.textContent = t("rundown.buildButton")
  })

  rundownPrevBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "scene:previous", timestamp: Date.now(), payload: null })
    log(t("log.sentScenePrevious"), "sent")
  })

  rundownNextBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "scene:next", timestamp: Date.now(), payload: null })
    log(t("log.sentSceneNext"), "sent")
  })

  mediaImportBtn.addEventListener("click", () => {
    mediaImportBtn.disabled = true
    window.churchOverlay
      .importMediaFile()
      .then((result) => {
        if (result.canceled) return
        if (result.error) {
          log(t("log.importFailed", { error: result.error }), "error")
          return
        }
        knownCues.push(result.cue)
        renderMediaGrid()
        log(t("log.imported", { title: result.cue.title }), "received")
      })
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
      .finally(() => {
        mediaImportBtn.disabled = false
      })
  })

  // Transport controls for the active video/audio cue (ARCHITECTURE.md
  // section 60.4's confirmed "full transport" decision). Seek/scrub is a
  // known, deliberate gap, not an oversight: a seek UI needs the media's
  // total duration, which nothing in this codebase inspects or stores
  // today (MediaLibrary only ever looks at the file extension) — adding
  // it means solving "how do we know how long this file is" first, a
  // separate piece of work, not something to fake with a slider that has
  // no real range.
  function updateNowPlayingBar(cue, playback) {
    if (!cue || !playback) {
      mediaNowPlayingEl.style.display = "none"
      activePlaybackState = null
      return
    }
    activePlaybackState = playback.state
    mediaNowPlayingTitleEl.textContent = cue.title
    mediaPlayPauseBtn.textContent = playback.state === "playing" ? t("media.pause") : t("media.play")
    mediaNowPlayingEl.style.display = "flex"
  }

  mediaPlayPauseBtn.addEventListener("click", () => {
    if (activePlaybackState === "playing") {
      sendJson({ id: crypto.randomUUID(), type: "media:pause", timestamp: Date.now(), payload: null })
      log(t("log.sentMediaPause"), "sent")
    } else {
      sendJson({ id: crypto.randomUUID(), type: "media:play", timestamp: Date.now(), payload: null })
      log(t("log.sentMediaPlay"), "sent")
    }
  })

  mediaStopBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "media:clear", timestamp: Date.now(), payload: null })
    log(t("log.sentMediaClear"), "sent")
  })

  // Deliberately similar to, but NOT required to stay byte-for-byte in
  // sync with, RegexDetector's REFERENCE_PATTERN in
  // apps/server/detector/regex-detector.ts — unlike float32ToInt16/
  // encodeAudioFrame above, a mismatch here is not a correctness risk:
  // this only decides whether the manual-override input field accepts
  // what the operator typed, then sends it as a plain payload. The
  // server-side resolveVerse()/KnownValidVerseIndex path re-validates
  // it exactly like a detected reference regardless of what this parser
  // let through (see app-core.ts's verse:override handler, ARCHITECTURE.md
  // section 36). Intentionally looser than the server pattern (e.g. it
  // doesn't require the book name to start with a capital letter), since
  // rejecting a typo-free field here isn't a security boundary.
  function parseReference(text) {
    const match = /^\s*((?:[123]\s+)?[A-Za-z]+)\s+(\d{1,3}):(\d{1,3})\s*$/.exec(text)
    if (!match) return null
    return {
      book: match[1].trim().replace(/\s+/g, " ").toLowerCase(),
      chapter: Number.parseInt(match[2], 10),
      verse: Number.parseInt(match[3], 10),
    }
  }

  function sendJson(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log(t("log.notConnected"), "error")
      return
    }
    ws.send(JSON.stringify(message))
  }

  showBtn.addEventListener("click", () => {
    const reference = parseReference(referenceInput.value)
    if (!reference) {
      log(t("log.parseError", { text: referenceInput.value }), "error")
      return
    }
    sendJson({ id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: reference })
    log(t("log.sentVerseOverride", { reference: JSON.stringify(reference) }), "sent")
  })

  clearBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "verse:clear", timestamp: Date.now(), payload: null })
    log(t("log.sentVerseClear"), "sent")
  })

  async function startMic() {
    try {
      // ARCHITECTURE.md section 8.3's recommended baseline.
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      log(t("log.micPermissionDenied", { error: err.message }), "error")
      return
    }

    // Requesting the canonical sample rate directly lets the browser
    // handle resampling from the device's native rate (ARCHITECTURE.md
    // section 8.1) — this codebase does not implement its own resampler.
    audioContext = new AudioContext({ sampleRate: CANONICAL_SAMPLE_RATE })
    await audioContext.audioWorklet.addModule("./pcm-worklet-processor.js")

    const source = audioContext.createMediaStreamSource(mediaStream)
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor")

    workletNode.port.onmessage = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const { samples, sequence } = event.data
      const pcm16 = float32ToInt16(samples)
      ws.send(encodeAudioFrame(pcm16, sequence))
    }

    source.connect(workletNode)

    sendJson({ id: crypto.randomUUID(), type: "mic:start", timestamp: Date.now(), payload: null })
    micStartBtn.disabled = true
    micStopBtn.disabled = false
    micVisualEl.classList.add("active")
    log(t("log.micStarted"), "sent")
  }

  async function stopMic() {
    sendJson({ id: crypto.randomUUID(), type: "mic:stop", timestamp: Date.now(), payload: null })

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      await audioContext.close()
      audioContext = null
    }
    micStartBtn.disabled = false
    micStopBtn.disabled = true
    micVisualEl.classList.remove("active")
    log(t("log.micStopped"), "sent")
  }

  micStartBtn.addEventListener("click", () => startMic())
  micStopBtn.addEventListener("click", () => stopMic())

  function connect(port, token) {
    setStatus(t("status.connecting"), "disconnected")
    ws = new WebSocket("ws://127.0.0.1:" + port, [token])

    ws.addEventListener("open", () => {
      reconnectAttempts = 0
      setStatus(t("status.connectedOperator"), "connected")
      log(t("log.connected"), "received")
    })
    ws.addEventListener("close", () => {
      const delay = nextReconnectDelay()
      const delaySeconds = Math.round(delay / 1000)
      setStatus(t("status.disconnectedRetrying", { seconds: delaySeconds }), "disconnected")
      log(t("log.disconnectedRetrying", { seconds: delaySeconds }), "error")
      setTimeout(() => connect(port, token), delay)
    })
    ws.addEventListener("error", () => log(t("log.connectionError"), "error"))
    ws.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      // message.type is a wire-protocol identifier (e.g. "verse:show"),
      // not user-facing text — it stays in English regardless of UI
      // language, same as any other protocol/technical identifier.
      log(t("log.received", { type: message.type }), "received")

      if (message.type === "transcript:partial") {
        const text = message.payload && message.payload.text
        if (text) transcriptEl.textContent = text
      } else if (message.type === "verse:show") {
        showLiveVerse(message.payload)
        transcriptEl.textContent = message.payload.text
      } else if (message.type === "verse:clear") {
        clearLiveVerse()
      } else if (message.type === "media:show") {
        activeCueId = message.payload.cue.id
        renderMediaGrid()
        updateNowPlayingBar(message.payload.cue, message.payload.playback)
      } else if (message.type === "media:clear") {
        activeCueId = null
        renderMediaGrid()
        updateNowPlayingBar(null, null)
      } else if (message.type === "announcement:show") {
        showLiveAnnouncement(message.payload)
      } else if (message.type === "announcement:clear") {
        clearLiveVerse()
      } else if (message.type === "rundown:state") {
        currentRundownState = message.payload
        renderRundownSceneList()
      }
    })
  }

  function showAppShell() {
    setupScreenEl.style.display = "none"
    appShellEl.style.display = "flex"
    // A separate IPC channel from the WS connection below — the media
    // library should populate as soon as the shell is usable, not wait on
    // (or reload every time on) the WS connection's own open/reconnect
    // cycle.
    loadMediaCues()
  }

  function showSetupScreen() {
    appShellEl.style.display = "none"
    setupScreenEl.style.display = "flex"
  }

  function setSetupError(text) {
    setupErrorEl.textContent = text
    setupErrorEl.style.display = text ? "block" : "none"
  }

  // ARCHITECTURE.md section 63.2/63.5: option-list groups (setup screen)
  // and segmented toggles (header) share the same "one active choice
  // among siblings" behavior — a single small helper wires both.
  function wireOptionGroup(groupEl, datasetKey, onSelect) {
    groupEl.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        groupEl.querySelectorAll("button").forEach((b) => b.classList.remove("active"))
        button.classList.add("active")
        onSelect(button.dataset[datasetKey])
      })
    })
  }

  wireOptionGroup(setupDisplayModeEl, "mode", (mode) => {
    setupSelectedMode = mode
  })
  wireOptionGroup(setupUiLanguageEl, "lang", (lang) => {
    setupSelectedUiLanguage = lang
    window.i18n.setLanguage(lang) // live preview on the setup screen itself
  })

  wireOptionGroup(displayModeToggleEl, "mode", (mode) => {
    window.churchOverlay.setDisplayMode(mode).catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
  })
  wireOptionGroup(uiLanguageToggleEl, "lang", (lang) => {
    window.i18n.setLanguage(lang)
    window.churchOverlay.setUiLanguage(lang).catch(() => {})
  })

  function setActiveOption(groupEl, datasetKey, value) {
    groupEl.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset[datasetKey] === value)
    })
  }

  setupSaveBtn.addEventListener("click", () => {
    const apiKey = setupKeyInput.value.trim()
    if (!apiKey) {
      setSetupError(t("setup.enterKeyError"))
      return
    }
    setSetupError("")
    setupSaveBtn.disabled = true
    setupSaveBtn.textContent = t("setup.saving")

    window.churchOverlay
      .completeSetup(apiKey, setupSelectedMode, setupSelectedUiLanguage)
      .then((info) => {
        setActiveOption(displayModeToggleEl, "mode", setupSelectedMode)
        setActiveOption(uiLanguageToggleEl, "lang", setupSelectedUiLanguage)
        showAppShell()
        connect(info.port, info.token)
      })
      .catch((err) => {
        setSetupError(err.message)
        setupSaveBtn.disabled = false
        setupSaveBtn.textContent = t("setup.saveButton")
      })
  })

  // On load, ask main whether services are already running (a Groq key
  // was saved on a previous run) or this is a genuine first run — the
  // setup screen only appears when there is nothing to connect to yet
  // (ARCHITECTURE.md section 2.1 item 21).
  window.churchOverlay
    .getStartupStatus()
    .then((status) => {
      window.i18n.setLanguage(status.uiLanguage || "en")
      setActiveOption(setupUiLanguageEl, "lang", status.uiLanguage || "en")
      setActiveOption(uiLanguageToggleEl, "lang", status.uiLanguage || "en")

      if (status.ready) {
        setActiveOption(displayModeToggleEl, "mode", status.displayMode || "english")
        showAppShell()
        connect(status.port, status.token)
      } else {
        showSetupScreen()
      }
    })
    .catch((err) => {
      showSetupScreen()
      setSetupError("Could not check startup status: " + err.message)
    })
})()
