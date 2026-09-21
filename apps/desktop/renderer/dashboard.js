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

  // Same RMS formula as apps/server/audio/silence-gate.ts's computeRms(),
  // duplicated deliberately (no build step to share it — see this file's
  // own float32ToInt16 comment for the established precedent) so the
  // mic-visual bars reflect the exact same scale the server's
  // SilenceGate threshold is actually evaluated against.
  function computeRmsInt16(samples) {
    if (samples.length === 0) return 0
    let sumOfSquares = 0
    for (let i = 0; i < samples.length; i++) {
      sumOfSquares += samples[i] * samples[i]
    }
    return Math.sqrt(sumOfSquares / samples.length)
  }

  // A real level meter, not a canned animation (a production audit found
  // the old version bounced unconditionally whenever the mic was merely
  // "on," giving no way to tell actual silence from actual speech). Peak-
  // hold with linear decay reads more like a genuine VU meter than a
  // frame-to-frame jump would. MIC_LEVEL_REFERENCE_RMS is a rough ceiling
  // for normal speaking volume on the Int16 scale — not a precise
  // calibration, just enough range for the bars to visibly move.
  const MIC_LEVEL_REFERENCE_RMS = 4000
  const MIC_LEVEL_DECAY_PER_FRAME = 0.08
  let micLevelDisplayed = 0
  const micBarEls = () => micVisualEl.querySelectorAll(".mic-bar")

  function updateMicLevel(rms) {
    const target = Math.max(0, Math.min(1, rms / MIC_LEVEL_REFERENCE_RMS))
    micLevelDisplayed = Math.max(target, micLevelDisplayed - MIC_LEVEL_DECAY_PER_FRAME)
    const bars = micBarEls()
    bars.forEach((bar, index) => {
      // A slight per-bar falloff from center so it reads as a level
      // meter, not five identical bars moving in lockstep.
      const centerDistance = Math.abs(index - (bars.length - 1) / 2)
      const barLevel = Math.max(0, micLevelDisplayed - centerDistance * 0.08)
      bar.style.height = Math.max(6, barLevel * 100) + "%"
    })

  }

  function resetMicLevel() {
    micLevelDisplayed = 0
    micBarEls().forEach((bar) => {
      bar.style.height = ""
    })
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
  const audioDiagnosticsEl = document.getElementById("audio-diagnostics")
  const referenceInput = document.getElementById("reference")
  const showBtn = document.getElementById("show-btn")
  const clearBtn = document.getElementById("clear-btn")
  const micStartBtn = document.getElementById("mic-start-btn")
  const micStopBtn = document.getElementById("mic-stop-btn")
  const micVisualEl = document.getElementById("mic-visual")
  const asrHealthWarningEl = document.getElementById("asr-health-warning")
  const asrHealthWarningTextEl = document.getElementById("asr-health-warning-text")
  const asrReturnPrimaryBtn = document.getElementById("asr-return-primary-btn")
  const micCalibratingStatusEl = document.getElementById("mic-calibrating-status")
  const overlayPreviewFrameEl = document.getElementById("overlay-preview-frame")
  const setupScreenEl = document.getElementById("setup-screen")
  const appShellEl = document.getElementById("app-shell")
  const setupKeyInput = document.getElementById("setup-groq-key")
  const setupDeepgramKeyInput = document.getElementById("setup-deepgram-key")
  const setupErrorEl = document.getElementById("setup-error")
  const setupSaveBtn = document.getElementById("setup-save-btn")
  const mediaGridEl = document.getElementById("media-grid")
  const mediaImportBtn = document.getElementById("media-import-btn")
  const mediaTitleModalEl = document.getElementById("media-title-modal")
  const mediaTitleModalHeadingEl = document.getElementById("media-title-modal-heading")
  const mediaTitleInput = document.getElementById("media-title-input")
  const mediaTitleCancelBtn = document.getElementById("media-title-cancel-btn")
  const mediaTitleConfirmBtn = document.getElementById("media-title-confirm-btn")
  const voiceCommandsBtn = document.getElementById("voice-commands-btn")
  const voiceCommandsModalEl = document.getElementById("voice-commands-modal")
  const voiceCommandsCloseBtn = document.getElementById("voice-commands-close-btn")
  const voiceCommandsMediaListEl = document.getElementById("voice-commands-media-list")
  const voiceCommandsGlossaryListEl = document.getElementById("voice-commands-glossary-list")
  const historySummaryEl = document.getElementById("history-summary")
  const historyMostShownEl = document.getElementById("history-most-shown")
  const historyRecentServicesEl = document.getElementById("history-recent-services")
  const displayModeToggleEl = document.getElementById("display-mode-toggle")
  const uiLanguageToggleEl = document.getElementById("ui-language-toggle")
  const verseConfirmationToggleEl = document.getElementById("verse-confirmation-toggle")
  const verseLayoutToggleEl = document.getElementById("verse-layout-toggle")
  const posterDurationInputEl = document.getElementById("poster-duration-input")
  const posterDurationApplyBtn = document.getElementById("poster-duration-apply-btn")
  const versePendingBannerEl = document.getElementById("verse-pending-banner")
  const versePendingTextEl = document.getElementById("verse-pending-text")
  const versePendingRefEl = document.getElementById("verse-pending-ref")
  const versePendingConfirmBtn = document.getElementById("verse-pending-confirm-btn")
  const setupDisplayModeEl = document.getElementById("setup-display-mode")
  const setupUiLanguageEl = document.getElementById("setup-ui-language")
  const setupAllowPhoneRemoteEl = document.getElementById("setup-allow-phone-remote")
  const remoteDisabledEl = document.getElementById("remote-disabled")
  const remoteEnabledEl = document.getElementById("remote-enabled")
  const remoteNoLanEl = document.getElementById("remote-no-lan")
  const remoteUrlInput = document.getElementById("remote-url")
  const remoteCopyBtn = document.getElementById("remote-copy-btn")
  const obsUrlInput = document.getElementById("obs-url")
  const obsCopyBtn = document.getElementById("obs-copy-btn")
  const ndiToggleBtn = document.getElementById("ndi-toggle-btn")
  const ndiStatusEl = document.getElementById("ndi-status")
  function renderNdiStatus(status) {
    currentNdiStatus = status || { state: "disabled" }
    const state = currentNdiStatus.state || "disabled"
    ndiEnabled = state === "running" || state === "starting"
    ndiToggleBtn.disabled = state === "starting"
    ndiToggleBtn.textContent = t(state === "running" ? "ndi.disable" : "ndi.enable")
    ndiStatusEl.textContent =
      state === "running" ? t("ndi.running") : state === "unavailable" ? t("ndi.unavailable") : ""
  }
  ndiToggleBtn.addEventListener("click", () => {
    const shouldEnable = !ndiEnabled
    ndiToggleBtn.disabled = true
    window.churchOverlay
      .setNdiEnabled(shouldEnable)
      .then(renderNdiStatus)
      .catch((err) => {
        log(err.message, "error")
        ndiToggleBtn.disabled = false
      })
  })
  const exportSessionBtn = document.getElementById("export-session-btn")
  const exportDiagnosticsBtn = document.getElementById("export-diagnostics-btn")
  const sermonNotesToggleEl = document.getElementById("sermon-notes-toggle")
  const sidebarEl = document.getElementById("sidebar")
  const viewEls = {
    live: document.getElementById("view-live"),
    rundown: document.getElementById("view-rundown"),
    media: document.getElementById("view-media"),
    history: document.getElementById("view-history"),
    settings: document.getElementById("view-settings"),
  }
  const sermonNotesFeedEl = document.getElementById("sermon-notes-feed")
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
  const rundownFieldCanvasEl = document.getElementById("rundown-field-canvas")
  const canvasAddTextBtn = document.getElementById("canvas-add-text-btn")
  const canvasAddImageBtn = document.getElementById("canvas-add-image-btn")
  const canvasAddBackgroundBtn = document.getElementById("canvas-add-background-btn")
  const canvasStageEl = document.getElementById("canvas-stage")
  const canvasInspectorEmptyEl = document.getElementById("canvas-inspector-empty")
  const canvasInspectorFieldsEl = document.getElementById("canvas-inspector-fields")
  const canvasLayerXInput = document.getElementById("canvas-layer-x")
  const canvasLayerYInput = document.getElementById("canvas-layer-y")
  const canvasLayerWidthInput = document.getElementById("canvas-layer-width")
  const canvasLayerHeightInput = document.getElementById("canvas-layer-height")
  const canvasFieldTextEl = document.getElementById("canvas-field-text")
  const canvasLayerTextInput = document.getElementById("canvas-layer-text")
  const canvasLayerFontEl = document.getElementById("canvas-layer-font")
  const canvasLayerFontSizeInput = document.getElementById("canvas-layer-font-size")
  const canvasLayerColorInput = document.getElementById("canvas-layer-color")
  const canvasLayerAlignEl = document.getElementById("canvas-layer-align")
  const canvasFieldImageEl = document.getElementById("canvas-field-image")
  const canvasLayerMediaSelect = document.getElementById("canvas-layer-media")
  const canvasFieldBackgroundEl = document.getElementById("canvas-field-background")
  const canvasLayerFillModeEl = document.getElementById("canvas-layer-fill-mode")
  const canvasBackgroundColorFieldEl = document.getElementById("canvas-background-color-field")
  const canvasLayerBgColorInput = document.getElementById("canvas-layer-bg-color")
  const canvasBackgroundMediaFieldEl = document.getElementById("canvas-background-media-field")
  const canvasLayerBgMediaSelect = document.getElementById("canvas-layer-bg-media")
  const canvasLayerBackBtn = document.getElementById("canvas-layer-back-btn")
  const canvasLayerFrontBtn = document.getElementById("canvas-layer-front-btn")
  const canvasLayerDeleteBtn = document.getElementById("canvas-layer-delete-btn")
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
  let principalPosterCueId = null
  // ARCHITECTURE.md production audit: this renderer is loaded via file://
  // (apps/desktop/main/index.ts's loadFile()), a different origin from the
  // static server that actually serves "/media/<id>" — a bare relative
  // path here would resolve against file:// and fail. Set once the real
  // overlayUrl is known (see setMediaOrigin below), giving the media grid
  // an absolute base to build real thumbnail URLs from.
  let mediaOrigin = null
  let activePlaybackState = null // "playing" | "paused" | null (null: no active cue, or an image with no playback concept)
  let setupSelectedMode = "english"
  let setupSelectedUiLanguage = "en"
  let ndiEnabled = false
  let currentNdiStatus = { state: "disabled" }

  // ARCHITECTURE.md section 64.5's authoring UI. `rundown:state` broadcasts
  // only the CURRENT scene (ARCHITECTURE.md section 64.4), not the whole
  // scene list — so the full list rendered here is whatever this dashboard
  // itself last loaded via rundown:load. If a rundown was loaded some other
  // way (or before this dashboard connected), loadedRundownScenes won't
  // match and the scene list falls back to showing just the one active
  // scene rather than guessing at a list it never actually saw.
  let draftScenes = []
  let draftSelectedKind = "verse"
  // ARCHITECTURE.md section 66, Phase 4: the in-progress canvas scene
  // being built in the builder's canvas field — mirrors draftScenes' own
  // "dashboard-only, in-memory, until Load rundown" pattern. Committed
  // into draftScenes (and reset) when "+ Add scene" fires while "canvas"
  // is the selected kind.
  let draftCanvasLayers = []
  let selectedCanvasLayerId = null
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

  // ARCHITECTURE.md section 65.7: dashboard-only feed of AI-generated
  // sermon-notes summaries, newest first — same prepend/cap pattern as
  // the Activity log above, since both are append-only running feeds.
  function appendSermonNote(text) {
    const empty = sermonNotesFeedEl.querySelector(".sermon-notes-empty")
    if (empty) empty.remove()

    const entry = document.createElement("div")
    entry.className = "sermon-notes-entry"
    const time = document.createElement("div")
    time.className = "sermon-notes-time"
    time.textContent = new Date().toLocaleTimeString()
    const body = document.createElement("div")
    body.className = "sermon-notes-text"
    body.textContent = text
    entry.append(time, body)
    sermonNotesFeedEl.prepend(entry)
    while (sermonNotesFeedEl.children.length > 20) sermonNotesFeedEl.removeChild(sermonNotesFeedEl.lastChild)
  }

  function setStatus(text, state) {
    statusTextEl.textContent = text
    statusPillEl.className = "status-pill " + state
  }

  function capitalize(book) {
    return book.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  // ARCHITECTURE.md section 72: same table as overlay.js's own copy
  // (duplicated, not shared — no build step, same precedent as
  // float32ToInt16/reconnect-backoff between these two files) — used so
  // the pending-verse-confirmation banner's reference line matches what
  // the overlay itself will show once confirmed.
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

  function formatBilingualReference(ref) {
    const frenchName = FRENCH_BOOK_NAMES[ref.book]
    const frenchRef = (frenchName || capitalize(ref.book)) + " " + ref.chapter + ":" + ref.verse
    return frenchRef + " · " + formatReference(ref)
  }

  // ARCHITECTURE.md section 69: the embedded overlay-preview-frame iframe
  // now shows what's actually live (a real, independent WS connection —
  // see renderOverlayPreview below), so a real verse:show has nothing
  // left to render dashboard-side beyond clearing any pending-confirmation
  // prompt it supersedes.
  function showLiveVerse() {
    clearPendingVerse()
  }

  // ARCHITECTURE.md section 65.3: review mode's holding prompt for a
  // DETECTED reference — a fresh verse:pending REPLACES whatever was
  // showing before (the server itself already enforces "most recent
  // wins"; this mirrors that on the display side too).
  function showPendingVerse(verse) {
    versePendingTextEl.textContent = verse.text
    const ref = verse.reference
    versePendingRefEl.textContent = verse.secondary ? formatBilingualReference(ref) : formatReference(ref)
    versePendingBannerEl.style.display = "flex"
  }

  function clearPendingVerse() {
    versePendingBannerEl.style.display = "none"
  }

  versePendingConfirmBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "verse:confirm-pending", timestamp: Date.now(), payload: null })
    log(t("log.sentVerseConfirmPending"), "sent")
  })

  // ASR/transcription health (status:update) — see ARCHITECTURE.md's
  // action-registry comment: a real producer now exists (AppCore
  // broadcasts this on a GroqProvider error, and again on the next
  // successful transcript as the recovery signal).
  function handleStatusUpdate(payload) {
    if (!payload) return
    if (payload.audioMetrics && audioDiagnosticsEl) {
      const m = payload.audioMetrics
      audioDiagnosticsEl.textContent =
        `Audio: ${m.framesForwarded}/${m.framesReceived} forwarded · RMS ${Math.round(m.averageRms)} · peak ${Math.round(m.maxRms)}`
    }
    asrHealthWarningEl.classList.remove("asr-health-warning-throttled", "asr-health-warning-rate-limited", "asr-health-warning-failover")
    asrReturnPrimaryBtn.style.display = "none"
    if (payload.asrHealth === "error") {
      asrHealthWarningTextEl.textContent = t("mic.transcriptionError", { error: payload.error || "" })
      asrHealthWarningEl.style.display = "block"
    } else if (payload.asrHealth === "throttled") {
      asrHealthWarningEl.classList.add("asr-health-warning-throttled")
      asrHealthWarningTextEl.textContent = t("mic.transcriptionThrottled", { error: payload.error || "" })
      asrHealthWarningEl.style.display = "block"
    } else if (payload.asrHealth === "rate-limited") {
      asrHealthWarningEl.classList.add("asr-health-warning-rate-limited")
      asrHealthWarningTextEl.textContent = t("mic.transcriptionRateLimited", { error: payload.error || "" })
      asrHealthWarningEl.style.display = "block"
    } else if (payload.asrHealth === "failover") {
      asrHealthWarningEl.classList.add("asr-health-warning-failover")
      asrHealthWarningTextEl.textContent = t("mic.failoverActive")
      asrReturnPrimaryBtn.textContent = t("mic.returnPrimary")
      asrReturnPrimaryBtn.setAttribute("aria-label", t("mic.returnPrimary"))
      asrReturnPrimaryBtn.style.display = "inline-block"
      asrHealthWarningEl.style.display = "block"
    } else if (payload.asrHealth === "ok") {
      asrHealthWarningEl.style.display = "none"
    }

    // ARCHITECTURE.md section 76: the ~1.5s auto-calibration window
    // deliberately forwards nothing yet — without this status line,
    // that looks identical to "the mic doesn't work."
    if (payload.micCalibrating === true) {
      micCalibratingStatusEl.style.display = "block"
    } else if (payload.micCalibrating === false) {
      micCalibratingStatusEl.style.display = "none"
      if (typeof payload.micThreshold === "number") {
        log(t("log.micCalibrated", { threshold: Math.round(payload.micThreshold) }), "received")
      }

      asrReturnPrimaryBtn.addEventListener("click", () => {
        sendJson({ id: crypto.randomUUID(), type: "asr:return-primary", timestamp: Date.now(), payload: null })
      })
    }
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

  // Production audit finding: every tile showed the same generic per-kind
  // icon, never the actual imported content — impossible to tell two
  // images or two videos apart at a glance. Real thumbnails for image
  // (an <img>) and video (a <video preload="metadata">, showing its first
  // frame without autoplaying); audio keeps the icon, since there is no
  // meaningful still frame for it. Falls back to the icon for image/video
  // too if mediaOrigin isn't known yet (the brief window before the app
  // shell's startup status resolves).
  function mediaThumbnailHtml(cue) {
    if (mediaOrigin && cue.kind === "image") {
      return `<img class="media-tile-thumb" src="${mediaOrigin}/media/${cue.id}" alt="" />`
    }
    if (mediaOrigin && cue.kind === "video") {
      return `<video class="media-tile-thumb" src="${mediaOrigin}/media/${cue.id}" preload="metadata" muted></video>`
    }
    return mediaIconSvg(cue.kind)
  }

  // Section 67.1: a plain pin outline, filled solid when this cue is the
  // current principal poster — same convention as MEDIA_ICONS/SCENE_ICONS
  // above (inline SVG, no emoji).
  const POSTER_PIN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M12 2v6.5M12 2 8 8.5h8L12 2Z"/><path d="M8.5 8.5 6 21l6-4 6 4-2.5-12.5"/>' +
    "</svg>"

  // ARCHITECTURE.md section 74 (production audit): an operator who
  // imported the wrong file, or named it wrong, needs a way to fix it
  // directly — not just prevented from repeating the mistake next time.
  const RENAME_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
    "</svg>"
  const DELETE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/>' +
    "</svg>"

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
      const isPoster = cue.id === principalPosterCueId
      const tile = document.createElement("div")
      tile.className = "media-tile" + (cue.id === activeCueId ? " active" : "") + (isPoster ? " poster" : "")
      tile.title = cue.title
      tile.innerHTML = mediaThumbnailHtml(cue) + '<div class="media-tile-title"></div>'
      tile.querySelector(".media-tile-title").textContent = cue.title
      tile.setAttribute("aria-label", cue.title)
      makeInteractive(tile, () => {
        sendJson({ id: crypto.randomUUID(), type: "media:select", timestamp: Date.now(), payload: { id: cue.id } })
        log(t("log.sentMediaSelect", { title: cue.title }), "sent")
      })
      // Only an image cue can be the principal poster (section 67.1/67.3 —
      // the overlay's poster layer only ever renders a still image). The
      // cue's existing title is also its voice-trigger phrase, per the
      // user's explicit correction: naming a cue IS appointing its trigger.
      if (cue.kind === "image") {
        const posterBtn = document.createElement("button")
        posterBtn.type = "button"
        posterBtn.className = "media-tile-poster-btn" + (isPoster ? " active" : "")
        posterBtn.innerHTML = POSTER_PIN_ICON
        posterBtn.title = isPoster
          ? t("media.posterUnsetTooltip", { title: cue.title })
          : t("media.posterSetTooltip", { title: cue.title })
        posterBtn.setAttribute("aria-label", posterBtn.title)
        posterBtn.addEventListener("click", (event) => {
          event.stopPropagation()
          if (isPoster) {
            sendJson({ id: crypto.randomUUID(), type: "poster:clear", timestamp: Date.now(), payload: null })
            log(t("log.sentPosterClear"), "sent")
          } else {
            sendJson({
              id: crypto.randomUUID(),
              type: "poster:set",
              timestamp: Date.now(),
              payload: { mediaCueId: cue.id },
            })
            log(t("log.sentPosterSet", { title: cue.title }), "sent")
          }
        })
        tile.appendChild(posterBtn)
      }

      const timer = document.createElement("div")
      timer.className = "media-tile-timer"
      const timerInput = document.createElement("input")
      timerInput.type = "number"
      timerInput.min = "1"
      timerInput.step = "1"
      timerInput.value = cue.autoClearMs ? String(Math.round(cue.autoClearMs / 60000)) : ""
      timerInput.placeholder = t("media.timerManual")
      timerInput.title = t("media.timerTooltip")
      timerInput.setAttribute("aria-label", t("media.timerTooltip"))
      const timerButton = document.createElement("button")
      timerButton.type = "button"
      timerButton.className = "media-tile-action-btn"
      timerButton.textContent = t("media.timerApply")
      timerButton.addEventListener("click", (event) => {
        event.stopPropagation()
        const minutes = timerInput.value.trim() === "" ? null : Number(timerInput.value)
        if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) return
        sendJson({
          id: crypto.randomUUID(),
          type: "media:set-duration",
          timestamp: Date.now(),
          payload: { mediaCueId: cue.id, durationMs: minutes === null ? null : minutes * 60000 },
        })
      })
      timer.append(timerInput, timerButton)
      tile.appendChild(timer)

      const tileActions = document.createElement("div")
      tileActions.className = "media-tile-actions"
      const renameBtn = document.createElement("button")
      renameBtn.type = "button"
      renameBtn.className = "media-tile-action-btn"
      renameBtn.innerHTML = RENAME_ICON
      renameBtn.title = t("media.renameTooltip", { title: cue.title })
      renameBtn.setAttribute("aria-label", renameBtn.title)
      renameBtn.addEventListener("click", (event) => {
        event.stopPropagation()
        showMediaTitleModal("rename", cue.title, cue.id)
      })
      const deleteBtn = document.createElement("button")
      deleteBtn.type = "button"
      deleteBtn.className = "media-tile-action-btn media-tile-action-btn-danger"
      deleteBtn.innerHTML = DELETE_ICON
      deleteBtn.title = t("media.deleteTooltip", { title: cue.title })
      deleteBtn.setAttribute("aria-label", deleteBtn.title)
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation()
        deleteMediaCue(cue)
      })
      tileActions.append(renameBtn, deleteBtn)
      tile.appendChild(tileActions)

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
    // ARCHITECTURE.md section 66, Phase 2 stopgap: a canvas scene's real
    // editor UI ships in Phase 4 — this icon just distinguishes it in the
    // scene-chip lists until then.
    canvas: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15l4-4 3 3 5-5 6 6"/>',
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
      case "canvas":
        return t("rundown.canvasLabel") + " (" + scene.canvas.layers.length + ")"
    }
  }

  function populateMediaSelect(selectEl, cues) {
    selectEl.innerHTML = ""
    if (cues.length === 0) {
      const option = document.createElement("option")
      option.value = ""
      option.textContent = t("rundown.builder.noMediaOption")
      selectEl.appendChild(option)
      return
    }
    for (const cue of cues) {
      const option = document.createElement("option")
      option.value = cue.id
      option.textContent = cue.title
      selectEl.appendChild(option)
    }
  }

  function renderRundownMediaOptions() {
    populateMediaSelect(rundownMediaSelectEl, knownCues)
    // ARCHITECTURE.md section 66.3: a canvas image/background layer only
    // ever holds an image or video cue (mediaKind) — never audio, which
    // has no visual to place on a stage.
    const visualCues = knownCues.filter((cue) => cue.kind === "image" || cue.kind === "video")
    populateMediaSelect(canvasLayerMediaSelect, visualCues)
    populateMediaSelect(canvasLayerBgMediaSelect, visualCues)
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
      chip.setAttribute("aria-label", sceneSummary(scene))
      makeInteractive(chip, () => {
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
      up.setAttribute("aria-label", t("rundown.builder.moveUp"))
      makeInteractive(up, (event) => {
        event.stopPropagation()
        if (index === 0) return
        ;[draftScenes[index - 1], draftScenes[index]] = [draftScenes[index], draftScenes[index - 1]]
        renderDraftSceneList()
      })

      const down = document.createElement("span")
      down.className = "chip-action"
      down.textContent = "↓"
      down.title = t("rundown.builder.moveDown")
      down.setAttribute("aria-label", t("rundown.builder.moveDown"))
      makeInteractive(down, (event) => {
        event.stopPropagation()
        if (index === draftScenes.length - 1) return
        ;[draftScenes[index], draftScenes[index + 1]] = [draftScenes[index + 1], draftScenes[index]]
        renderDraftSceneList()
      })

      const remove = document.createElement("span")
      remove.className = "chip-action chip-remove"
      remove.textContent = "×"
      remove.setAttribute("aria-label", t("rundown.builder.removeScene"))
      makeInteractive(remove, (event) => {
        event.stopPropagation()
        draftScenes.splice(index, 1)
        renderDraftSceneList()
      })

      chip.append(up, down, remove)
      rundownDraftListEl.appendChild(chip)
    })
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
    rundownFieldCanvasEl.style.display = draftSelectedKind === "canvas" ? "block" : "none"
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
    } else if (draftSelectedKind === "canvas") {
      // ARCHITECTURE.md section 66, Phase 4: commits whatever layers were
      // built in the canvas editor field, then resets it so the next
      // canvas scene starts from a blank stage.
      const invalidImageLayer = draftCanvasLayers.find((l) => l.kind === "image" && !l.mediaCueId)
      if (invalidImageLayer) {
        log(t("rundown.canvasEditor.imageLayerMissingMedia"), "error")
        return
      }
      scene = { kind: "canvas", canvas: { layers: draftCanvasLayers.slice() } }
      draftCanvasLayers = []
      selectedCanvasLayerId = null
      renderCanvasStage()
      renderCanvasInspector()
    } else {
      scene = { kind: "blank" }
    }
    draftScenes.push(scene)
    renderDraftSceneList()
  })

  // ============================================================
  // ARCHITECTURE.md section 66, Phase 4: the WYSIWYG canvas editor.
  // Hand-written (no canvas/interact dependency, section 66.2's decisive
  // call) — pointer capture for drag/resize, percentage-based coordinates
  // throughout (matching CanvasLayer's own 0-100 stage-relative model),
  // snap-to-edge/center against the stage and other layers, and keyboard
  // nudge for accessibility/precision.
  //
  // Known simplification: image/background media layers render as a
  // labeled placeholder box in this editor stage, not the real pixels —
  // this dashboard is loaded via file:// (apps/desktop/main/index.ts's
  // loadFile()), not through the overlay's own StaticServer, so a
  // same-origin "/media/<id>" URL the overlay uses doesn't resolve here.
  // The real overlay (apps/overlay/public/overlay.js's showCanvas())
  // renders the actual image/video correctly; only this editor's own
  // preview is a placeholder. Position/size/z-order are still exactly
  // WYSIWYG for every layer kind.
  // ============================================================

  const CANVAS_FONT_FAMILIES = {
    serif: "'Instrument Serif', Georgia, serif",
    sans: "'Instrument Sans', -apple-system, 'Segoe UI', system-ui, sans-serif",
    mono: "'JetBrains Mono', 'SF Mono', Consolas, monospace",
  }
  const MIN_LAYER_SIZE_PCT = 3
  const SNAP_THRESHOLD_PCT = 1.5

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max)
  }

  function findCanvasLayer(id) {
    return draftCanvasLayers.find((l) => l.id === id)
  }

  function nextCanvasZIndex() {
    return draftCanvasLayers.length === 0 ? 1 : Math.max(...draftCanvasLayers.map((l) => l.zIndex)) + 1
  }

  function buildLayerContentEl(layer) {
    const content = document.createElement("div")
    content.className = "layer-content"
    if (layer.kind === "text") {
      content.classList.add("layer-text")
      content.textContent = layer.text
      content.style.fontFamily = CANVAS_FONT_FAMILIES[layer.fontFamily] || CANVAS_FONT_FAMILIES.sans
      content.style.fontSize = layer.fontSizePx + "px"
      content.style.color = layer.color
      content.style.textAlign = layer.align
      content.style.justifyContent = layer.align === "left" ? "flex-start" : layer.align === "right" ? "flex-end" : "center"
    } else if (layer.kind === "image") {
      const cue = knownCues.find((c) => c.id === layer.mediaCueId)
      content.style.display = "flex"
      content.style.alignItems = "center"
      content.style.justifyContent = "center"
      content.style.background = "rgba(255,255,255,0.08)"
      content.style.color = "var(--text-secondary)"
      content.style.fontSize = "11px"
      content.style.textAlign = "center"
      content.style.padding = "4px"
      content.textContent = cue ? cue.title : t("rundown.canvasEditor.noMediaChosen")
    } else {
      // background
      const cue = layer.mediaCueId ? knownCues.find((c) => c.id === layer.mediaCueId) : null
      if (cue) {
        content.style.display = "flex"
        content.style.alignItems = "center"
        content.style.justifyContent = "center"
        content.style.background = "rgba(255,255,255,0.08)"
        content.style.color = "var(--text-secondary)"
        content.style.fontSize = "11px"
        content.textContent = cue.title
      } else if (layer.color) {
        content.style.background = layer.color
      }
    }
    return content
  }

  function renderCanvasStage() {
    canvasStageEl.innerHTML = ""
    const sorted = draftCanvasLayers.slice().sort((a, b) => a.zIndex - b.zIndex)
    for (const layer of sorted) {
      const el = document.createElement("div")
      el.className = "canvas-editor-layer" + (layer.id === selectedCanvasLayerId ? " selected" : "")
      el.style.left = layer.x + "%"
      el.style.top = layer.y + "%"
      el.style.width = layer.width + "%"
      el.style.height = layer.height + "%"
      el.style.zIndex = layer.zIndex
      el.appendChild(buildLayerContentEl(layer))
      el.addEventListener("pointerdown", (e) => startLayerDrag(e, layer, el))
      if (layer.id === selectedCanvasLayerId) {
        for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
          const handle = document.createElement("div")
          handle.className = "canvas-resize-handle " + dir
          handle.addEventListener("pointerdown", (e) => startLayerResize(e, layer, el, dir))
          el.appendChild(handle)
        }
      }
      canvasStageEl.appendChild(el)
    }
  }

  function renderCanvasInspector() {
    const layer = findCanvasLayer(selectedCanvasLayerId)
    if (!layer) {
      canvasInspectorEmptyEl.style.display = "block"
      canvasInspectorFieldsEl.style.display = "none"
      return
    }
    canvasInspectorEmptyEl.style.display = "none"
    canvasInspectorFieldsEl.style.display = "block"

    canvasLayerXInput.value = Math.round(layer.x * 10) / 10
    canvasLayerYInput.value = Math.round(layer.y * 10) / 10
    canvasLayerWidthInput.value = Math.round(layer.width * 10) / 10
    canvasLayerHeightInput.value = Math.round(layer.height * 10) / 10

    canvasFieldTextEl.style.display = layer.kind === "text" ? "block" : "none"
    canvasFieldImageEl.style.display = layer.kind === "image" ? "block" : "none"
    canvasFieldBackgroundEl.style.display = layer.kind === "background" ? "block" : "none"

    if (layer.kind === "text") {
      canvasLayerTextInput.value = layer.text
      setActiveOption(canvasLayerFontEl, "font", layer.fontFamily)
      canvasLayerFontSizeInput.value = layer.fontSizePx
      canvasLayerColorInput.value = layer.color
      setActiveOption(canvasLayerAlignEl, "align", layer.align)
    } else if (layer.kind === "image") {
      canvasLayerMediaSelect.value = layer.mediaCueId || ""
    } else if (layer.kind === "background") {
      const fillMode = layer.mediaCueId ? "media" : "color"
      setActiveOption(canvasLayerFillModeEl, "fill", fillMode)
      canvasBackgroundColorFieldEl.style.display = fillMode === "color" ? "block" : "none"
      canvasBackgroundMediaFieldEl.style.display = fillMode === "media" ? "block" : "none"
      canvasLayerBgColorInput.value = layer.color || "#000000"
      canvasLayerBgMediaSelect.value = layer.mediaCueId || ""
    }
  }

  function updateSelectedLayer(mutate, options) {
    const layer = findCanvasLayer(selectedCanvasLayerId)
    if (!layer) return
    mutate(layer)
    renderCanvasStage()
    if (!options || !options.skipInspectorRefresh) renderCanvasInspector()
  }

  function selectCanvasLayer(id) {
    selectedCanvasLayerId = id
    renderCanvasStage()
    renderCanvasInspector()
  }

  canvasStageEl.addEventListener("pointerdown", (e) => {
    if (e.target === canvasStageEl) selectCanvasLayer(null)
  })

  // Arrow-key nudge (1x / shift for 10x, in the same 0-100 stage-percent
  // units as everything else) and Delete/Backspace, matching the
  // keyboard-first convention makeInteractive() already establishes
  // elsewhere in this file.
  canvasStageEl.addEventListener("keydown", (e) => {
    const layer = findCanvasLayer(selectedCanvasLayerId)
    if (!layer) return
    const step = e.shiftKey ? 2 : 0.5
    let handled = true
    if (e.key === "ArrowLeft") layer.x = clamp(layer.x - step, 0, 100 - layer.width)
    else if (e.key === "ArrowRight") layer.x = clamp(layer.x + step, 0, 100 - layer.width)
    else if (e.key === "ArrowUp") layer.y = clamp(layer.y - step, 0, 100 - layer.height)
    else if (e.key === "ArrowDown") layer.y = clamp(layer.y + step, 0, 100 - layer.height)
    else if (e.key === "Delete" || e.key === "Backspace") {
      draftCanvasLayers = draftCanvasLayers.filter((l) => l.id !== selectedCanvasLayerId)
      selectedCanvasLayerId = null
    } else {
      handled = false
    }
    if (handled) {
      e.preventDefault()
      renderCanvasStage()
      renderCanvasInspector()
    }
  })

  function collectSnapLinesX(excludeId) {
    const lines = [0, 50, 100]
    for (const l of draftCanvasLayers) {
      if (l.id === excludeId) continue
      lines.push(l.x, l.x + l.width / 2, l.x + l.width)
    }
    return lines
  }
  function collectSnapLinesY(excludeId) {
    const lines = [0, 50, 100]
    for (const l of draftCanvasLayers) {
      if (l.id === excludeId) continue
      lines.push(l.y, l.y + l.height / 2, l.y + l.height)
    }
    return lines
  }
  function snapValue(value, lines) {
    for (const line of lines) {
      if (Math.abs(value - line) <= SNAP_THRESHOLD_PCT) return line
    }
    return value
  }
  function snapPosition(layer, rawX, rawY) {
    const linesX = collectSnapLinesX(layer.id)
    const linesY = collectSnapLinesY(layer.id)
    let x = rawX
    const leftSnap = snapValue(rawX, linesX)
    const centerXSnap = snapValue(rawX + layer.width / 2, linesX) - layer.width / 2
    const rightSnap = snapValue(rawX + layer.width, linesX) - layer.width
    if (leftSnap !== rawX) x = leftSnap
    else if (centerXSnap !== rawX) x = centerXSnap
    else if (rightSnap !== rawX) x = rightSnap

    let y = rawY
    const topSnap = snapValue(rawY, linesY)
    const centerYSnap = snapValue(rawY + layer.height / 2, linesY) - layer.height / 2
    const bottomSnap = snapValue(rawY + layer.height, linesY) - layer.height
    if (topSnap !== rawY) y = topSnap
    else if (centerYSnap !== rawY) y = centerYSnap
    else if (bottomSnap !== rawY) y = bottomSnap

    return { x: clamp(x, 0, 100 - layer.width), y: clamp(y, 0, 100 - layer.height) }
  }

  function startLayerDrag(e, layer, el) {
    if (e.target !== el && !e.target.classList.contains("layer-content")) return // a resize handle owns this pointerdown instead
    e.stopPropagation()
    e.preventDefault()
    // Only select (which fully re-renders the stage, per renderCanvasStage()
    // clearing and rebuilding every layer element) when switching to a
    // DIFFERENT layer. Calling it unconditionally here — even when `layer`
    // is already selected — would replace `el` with a fresh DOM node right
    // before setPointerCapture()/addEventListener() below, leaving them
    // attached to a now-detached element that never receives the real
    // pointermove/pointerup events the browser sends to the NEW node.
    if (selectedCanvasLayerId !== layer.id) selectCanvasLayer(layer.id)
    const stageRect = canvasStageEl.getBoundingClientRect()
    const startClientX = e.clientX
    const startClientY = e.clientY
    const startX = layer.x
    const startY = layer.y
    // Pointer capture keeps pointermove/pointerup reaching this element
    // even once the pointer moves outside its (shrinking/moving) bounds
    // mid-drag — real hardware input always supports this; the try/catch
    // is only a defensive fallback (dragging still mostly works without
    // it, as long as the pointer stays over the element).
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // ignore — see comment above
    }

    function onMove(moveEvent) {
      const dxPct = ((moveEvent.clientX - startClientX) / stageRect.width) * 100
      const dyPct = ((moveEvent.clientY - startClientY) / stageRect.height) * 100
      const rawX = clamp(startX + dxPct, 0, 100 - layer.width)
      const rawY = clamp(startY + dyPct, 0, 100 - layer.height)
      const snapped = snapPosition(layer, rawX, rawY)
      layer.x = snapped.x
      layer.y = snapped.y
      el.style.left = layer.x + "%"
      el.style.top = layer.y + "%"
      renderCanvasInspector()
    }
    function onUp() {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
    }
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
  }

  function startLayerResize(e, layer, el, direction) {
    e.stopPropagation()
    e.preventDefault()
    // No selectCanvasLayer() call needed here (unlike startLayerDrag): a
    // resize handle only ever exists in the DOM for the already-selected
    // layer (renderCanvasStage() only renders handles for
    // selectedCanvasLayerId), so re-selecting would only destructively
    // re-render the stage — and detach handleEl below — for no reason.
    const stageRect = canvasStageEl.getBoundingClientRect()
    const startClientX = e.clientX
    const startClientY = e.clientY
    const start = { x: layer.x, y: layer.y, width: layer.width, height: layer.height }
    const handleEl = e.currentTarget
    try {
      handleEl.setPointerCapture(e.pointerId)
    } catch {
      // ignore — see the comment in startLayerDrag() above
    }

    function onMove(moveEvent) {
      const dxPct = ((moveEvent.clientX - startClientX) / stageRect.width) * 100
      const dyPct = ((moveEvent.clientY - startClientY) / stageRect.height) * 100
      let x = start.x
      let y = start.y
      let width = start.width
      let height = start.height

      if (direction.includes("e")) width = clamp(start.width + dxPct, MIN_LAYER_SIZE_PCT, 100 - start.x)
      if (direction.includes("w")) {
        const newX = clamp(start.x + dxPct, 0, start.x + start.width - MIN_LAYER_SIZE_PCT)
        width = start.width + (start.x - newX)
        x = newX
      }
      if (direction.includes("s")) height = clamp(start.height + dyPct, MIN_LAYER_SIZE_PCT, 100 - start.y)
      if (direction.includes("n")) {
        const newY = clamp(start.y + dyPct, 0, start.y + start.height - MIN_LAYER_SIZE_PCT)
        height = start.height + (start.y - newY)
        y = newY
      }

      layer.x = x
      layer.y = y
      layer.width = width
      layer.height = height
      el.style.left = x + "%"
      el.style.top = y + "%"
      el.style.width = width + "%"
      el.style.height = height + "%"
      renderCanvasInspector()
    }
    function onUp() {
      try {
        handleEl.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      handleEl.removeEventListener("pointermove", onMove)
      handleEl.removeEventListener("pointerup", onUp)
      renderCanvasStage() // rebuilds handle positions cleanly against the final size
    }
    handleEl.addEventListener("pointermove", onMove)
    handleEl.addEventListener("pointerup", onUp)
  }

  canvasAddTextBtn.addEventListener("click", () => {
    const layer = {
      id: crypto.randomUUID(),
      kind: "text",
      x: 20,
      y: 40,
      width: 60,
      height: 20,
      zIndex: nextCanvasZIndex(),
      text: t("rundown.canvasEditor.defaultText"),
      fontFamily: "serif",
      fontSizePx: 48,
      color: "#ffffff",
      align: "center",
    }
    draftCanvasLayers.push(layer)
    selectCanvasLayer(layer.id)
  })

  canvasAddImageBtn.addEventListener("click", () => {
    const firstCue = knownCues.find((c) => c.kind === "image" || c.kind === "video")
    const layer = {
      id: crypto.randomUUID(),
      kind: "image",
      x: 25,
      y: 25,
      width: 50,
      height: 50,
      zIndex: nextCanvasZIndex(),
      mediaCueId: firstCue ? firstCue.id : "",
      mediaKind: firstCue ? firstCue.kind : "image",
    }
    draftCanvasLayers.push(layer)
    selectCanvasLayer(layer.id)
  })

  canvasAddBackgroundBtn.addEventListener("click", () => {
    const layer = {
      id: crypto.randomUUID(),
      kind: "background",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 0,
      color: "#0a0a12",
      mediaCueId: null,
      mediaKind: null,
    }
    draftCanvasLayers.push(layer)
    selectCanvasLayer(layer.id)
  })

  canvasLayerXInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.x = clamp(Number(canvasLayerXInput.value) || 0, 0, 100 - l.width) }, { skipInspectorRefresh: true })
  )
  canvasLayerYInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.y = clamp(Number(canvasLayerYInput.value) || 0, 0, 100 - l.height) }, { skipInspectorRefresh: true })
  )
  canvasLayerWidthInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.width = clamp(Number(canvasLayerWidthInput.value) || 1, MIN_LAYER_SIZE_PCT, 100 - l.x) }, { skipInspectorRefresh: true })
  )
  canvasLayerHeightInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.height = clamp(Number(canvasLayerHeightInput.value) || 1, MIN_LAYER_SIZE_PCT, 100 - l.y) }, { skipInspectorRefresh: true })
  )
  canvasLayerTextInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.text = canvasLayerTextInput.value }, { skipInspectorRefresh: true })
  )
  wireOptionGroup(canvasLayerFontEl, "font", (font) => updateSelectedLayer((l) => { l.fontFamily = font }))
  canvasLayerFontSizeInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.fontSizePx = Number(canvasLayerFontSizeInput.value) || 16 }, { skipInspectorRefresh: true })
  )
  canvasLayerColorInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.color = canvasLayerColorInput.value }, { skipInspectorRefresh: true })
  )
  wireOptionGroup(canvasLayerAlignEl, "align", (align) => updateSelectedLayer((l) => { l.align = align }))

  canvasLayerMediaSelect.addEventListener("change", () =>
    updateSelectedLayer((l) => {
      const cue = knownCues.find((c) => c.id === canvasLayerMediaSelect.value)
      l.mediaCueId = cue ? cue.id : ""
      l.mediaKind = cue ? cue.kind : "image"
    })
  )

  wireOptionGroup(canvasLayerFillModeEl, "fill", (fill) =>
    updateSelectedLayer((l) => {
      if (fill === "color") {
        l.mediaCueId = null
        l.mediaKind = null
        if (!l.color) l.color = "#000000"
      } else {
        l.color = null
      }
    })
  )
  canvasLayerBgColorInput.addEventListener("input", () =>
    updateSelectedLayer((l) => { l.color = canvasLayerBgColorInput.value }, { skipInspectorRefresh: true })
  )
  canvasLayerBgMediaSelect.addEventListener("change", () =>
    updateSelectedLayer((l) => {
      const cue = knownCues.find((c) => c.id === canvasLayerBgMediaSelect.value)
      l.mediaCueId = cue ? cue.id : null
      l.mediaKind = cue ? cue.kind : null
    })
  )

  canvasLayerFrontBtn.addEventListener("click", () =>
    updateSelectedLayer((l) => {
      const maxZ = draftCanvasLayers.reduce((m, x) => Math.max(m, x.zIndex), 0)
      l.zIndex = maxZ + 1
    })
  )
  canvasLayerBackBtn.addEventListener("click", () =>
    updateSelectedLayer((l) => {
      const minZ = draftCanvasLayers.reduce((m, x) => Math.min(m, x.zIndex), 0)
      l.zIndex = minZ - 1
    })
  )
  canvasLayerDeleteBtn.addEventListener("click", () => {
    draftCanvasLayers = draftCanvasLayers.filter((l) => l.id !== selectedCanvasLayerId)
    selectedCanvasLayerId = null
    renderCanvasStage()
    renderCanvasInspector()
  })

  renderCanvasStage()
  renderCanvasInspector()

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

  // ARCHITECTURE.md section 74: the title is also the voice-trigger
  // phrase (section 60.3), so the SAME confirm/edit dialog serves two
  // moments — right after picking a file (mode "import", pre-filled with
  // the main process's filename-derived suggestion) and fixing an
  // existing cue's title later (mode "rename", pre-filled with its
  // current title) — rather than building a second dialog for what is,
  // to the operator, the same action: "here's the name, confirm or edit
  // it." mediaTitleModalMode/mediaTitleModalCueId are which one is active.
  let mediaTitleModalMode = "import"
  let mediaTitleModalCueId = null

  function showMediaTitleModal(mode, suggestedTitle, cueId) {
    mediaTitleModalMode = mode
    mediaTitleModalCueId = cueId ?? null
    mediaTitleInput.value = suggestedTitle
    mediaTitleModalHeadingEl.textContent = t(
      mode === "rename" ? "media.titleModal.renameHeading" : "media.titleModal.heading"
    )
    mediaTitleConfirmBtn.textContent = t(
      mode === "rename" ? "media.titleModal.saveButton" : "media.titleModal.confirmButton"
    )
    mediaTitleModalEl.style.display = "flex"
    mediaTitleInput.focus()
    mediaTitleInput.select()
  }

  function hideMediaTitleModal() {
    mediaTitleModalEl.style.display = "none"
  }

  function confirmMediaTitleModal() {
    const title = mediaTitleInput.value.trim()
    if (!title) return // empty title: let the operator keep editing, same as main's own rejection
    mediaTitleConfirmBtn.disabled = true

    const request =
      mediaTitleModalMode === "rename"
        ? window.churchOverlay.renameMediaCue(mediaTitleModalCueId, title)
        : window.churchOverlay.confirmMediaImport(title)

    request
      .then((result) => {
        if (result.error) {
          log(t("log.importFailed", { error: result.error }), "error")
          return
        }
        if (mediaTitleModalMode === "rename") {
          const index = knownCues.findIndex((c) => c.id === result.cue.id)
          if (index !== -1) knownCues[index] = result.cue
          log(t("log.renamedMedia", { title: result.cue.title }), "sent")
        } else {
          knownCues.push(result.cue)
          log(t("log.imported", { title: result.cue.title }), "received")
        }
        renderMediaGrid()
        hideMediaTitleModal()
      })
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
      .finally(() => {
        mediaTitleConfirmBtn.disabled = false
      })
  }

  mediaTitleConfirmBtn.addEventListener("click", confirmMediaTitleModal)
  mediaTitleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") confirmMediaTitleModal()
  })
  mediaTitleCancelBtn.addEventListener("click", () => {
    if (mediaTitleModalMode === "import") window.churchOverlay.cancelMediaImport().catch(() => {})
    hideMediaTitleModal()
  })

  // ARCHITECTURE.md section 78: several real bugs this project found
  // came down to an operator not knowing the exact phrase a voice
  // command needed — a reference, not a settings screen, so it's just
  // shown/hidden, never anything here written back anywhere.
  let glossaryTermsCache = null

  function renderVoiceCommandsDynamicLists() {
    voiceCommandsMediaListEl.innerHTML = ""
    if (knownCues.length === 0) {
      const empty = document.createElement("div")
      empty.className = "voice-commands-empty"
      empty.textContent = t("voiceCommands.noMedia")
      voiceCommandsMediaListEl.appendChild(empty)
    } else {
      for (const cue of knownCues) {
        const row = document.createElement("div")
        row.className = "voice-commands-item"
        const label = document.createElement("span")
        label.textContent = cue.id === principalPosterCueId ? t("voiceCommands.posterLabel") : cue.kind
        const phrase = document.createElement("code")
        phrase.textContent = '"' + cue.title + '"'
        row.append(phrase, label)
        voiceCommandsMediaListEl.appendChild(row)
      }
    }

    voiceCommandsGlossaryListEl.innerHTML = ""
    if (glossaryTermsCache === null) {
      const loading = document.createElement("div")
      loading.className = "voice-commands-empty"
      loading.textContent = t("voiceCommands.loadingGlossary")
      voiceCommandsGlossaryListEl.appendChild(loading)
      window.churchOverlay
        .listGlossaryTerms()
        .then((terms) => {
          glossaryTermsCache = terms
          if (voiceCommandsModalEl.style.display !== "none") renderVoiceCommandsDynamicLists()
        })
        .catch(() => {
          glossaryTermsCache = []
        })
      return
    }
    if (glossaryTermsCache.length === 0) {
      const empty = document.createElement("div")
      empty.className = "voice-commands-empty"
      empty.textContent = t("voiceCommands.noGlossary")
      voiceCommandsGlossaryListEl.appendChild(empty)
    } else {
      for (const entry of glossaryTermsCache) {
        const row = document.createElement("div")
        row.className = "voice-commands-item"
        const label = document.createElement("span")
        label.textContent = entry.term
        const phrase = document.createElement("code")
        // The real trigger phrase, not a guessed template — English and
        // French entries use different verbs ("define" vs. "definis"/
        // "que veut dire"), section 78's own fix for the earlier mistake
        // of assuming one universal phrasing across both languages.
        phrase.textContent = '"' + entry.examplePhrase + '"'
        row.append(label, phrase)
        voiceCommandsGlossaryListEl.appendChild(row)
      }
    }
  }

  voiceCommandsBtn.addEventListener("click", () => {
    renderVoiceCommandsDynamicLists()
    voiceCommandsModalEl.style.display = "flex"
  })
  voiceCommandsCloseBtn.addEventListener("click", () => {
    voiceCommandsModalEl.style.display = "none"
  })

  // ARCHITECTURE.md section 74: an operator who imported the wrong file
  // has no fix short of removing it and re-importing — deleting a cue
  // that's currently the poster or on screen would otherwise leave a
  // dangling reference, so this proactively clears it via the same
  // WS commands the operator's own poster/media buttons already use,
  // before the file itself is gone.
  function deleteMediaCue(cue) {
    if (!window.confirm(t("media.deleteConfirm", { title: cue.title }))) return
    if (cue.id === principalPosterCueId) {
      sendJson({ id: crypto.randomUUID(), type: "poster:clear", timestamp: Date.now(), payload: null })
    }
    if (cue.id === activeCueId) {
      sendJson({ id: crypto.randomUUID(), type: "media:clear", timestamp: Date.now(), payload: null })
    }
    window.churchOverlay
      .deleteMediaCue(cue.id)
      .then((result) => {
        if (result.error) {
          log(t("log.deleteFailed", { error: result.error }), "error")
          return
        }
        knownCues = knownCues.filter((c) => c.id !== cue.id)
        renderMediaGrid()
        log(t("log.deletedMedia", { title: cue.title }), "sent")
      })
      .catch((err) => log(t("log.deleteFailed", { error: err.message }), "error"))
  }

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
        showMediaTitleModal("import", result.suggestedTitle)
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

  // Media tiles and rundown scene chips are non-<button> elements (a
  // <div> grid tile, a chip with several independently-clickable actions
  // inside it) so they need this explicitly — a plain click listener
  // alone is invisible to keyboard and screen-reader users. Found during
  // a full-codebase audit: none of the new Phase 2 interactive elements
  // had this, unlike every pre-existing v1 control (all real <button>s).
  function makeInteractive(el, onActivate) {
    el.setAttribute("role", "button")
    el.setAttribute("tabindex", "0")
    el.addEventListener("click", onActivate)
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        onActivate(event)
      }
    })
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
      const { samples, sequence } = event.data
      const pcm16 = float32ToInt16(samples)
      // A production audit found this feedback bar was purely decorative
      // (a canned CSS animation, unconditional on real signal) — an
      // operator had no way to tell "my voice isn't registering" from
      // "it's registering, nobody's spoken yet" until the silence gate's
      // own server-side decision showed up in the log. Driving the bars
      // from the SAME Int16 scale the server's SilenceGate thresholds
      // against makes that gap actually observable, not just fixed in
      // theory: what the operator sees IS what's being evaluated.
      updateMicLevel(computeRmsInt16(pcm16))
      if (!ws || ws.readyState !== WebSocket.OPEN) return
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
    micCalibratingStatusEl.style.display = "none"
    resetMicLevel()
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

      if (message.type === "transcript:partial" || message.type === "transcript:final") {
        // ARCHITECTURE.md section 70: the operator needs to see what was
        // actually heard, continuously, to judge transcription accuracy
        // and latency — this field always reflects the raw ASR output,
        // never something else (like verse text) overwriting it.
        const text = message.payload && message.payload.text
        if (text) transcriptEl.textContent = text
      } else if (message.type === "verse:show") {
        showLiveVerse()
      } else if (message.type === "media:show") {
        activeCueId = message.payload.cue.id
        renderMediaGrid()
        updateNowPlayingBar(message.payload.cue, message.payload.playback)
      } else if (message.type === "media:clear") {
        activeCueId = null
        renderMediaGrid()
        updateNowPlayingBar(null, null)
      } else if (message.type === "poster:show") {
        principalPosterCueId = message.payload.cue.id
        renderMediaGrid()
      } else if (message.type === "poster:clear") {
        principalPosterCueId = null
        renderMediaGrid()
      } else if (message.type === "rundown:state") {
        currentRundownState = message.payload
        renderRundownSceneList()
      } else if (message.type === "status:update") {
        handleStatusUpdate(message.payload)
      } else if (message.type === "verse:pending") {
        showPendingVerse(message.payload)
      } else if (message.type === "sermonNotes:update") {
        appendSermonNote(message.payload.notes)
      }
    })
  }

  function showAppShell() {
    setupScreenEl.style.display = "none"
    appShellEl.style.display = "flex"
    let lastView = "live"
    try {
      lastView = localStorage.getItem("churchOverlay.activeView") || "live"
    } catch {
      // Private-window/blocked-storage: default to the Live view.
    }
    showView(lastView)
    // A separate IPC channel from the WS connection below — the media
    // library should populate as soon as the shell is usable, not wait on
    // (or reload every time on) the WS connection's own open/reconnect
    // cycle.
    loadMediaCues()
  }

  // ARCHITECTURE.md section 66, Phase 1: the sidebar app shell's own
  // screen switch — the exact same binary style.display toggle pattern
  // showAppShell()/showSetupScreen() already use, generalized from 2
  // named panels to N. Persisted to localStorage as a per-viewer
  // convenience only (which tab was open last) — never anything the main
  // process needs to know or restore on its behalf.
  function showView(viewName) {
    const target = viewEls[viewName] ? viewName : "live"
    for (const [name, el] of Object.entries(viewEls)) {
      el.classList.toggle("active", name === target)
    }
    sidebarEl.querySelectorAll(".sidebar-nav-item").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === target)
    })
    try {
      localStorage.setItem("churchOverlay.activeView", target)
    } catch {
      // Private-window/blocked-storage: the view still switches correctly
      // this session, it just won't be remembered next launch.
    }
  }

  sidebarEl.querySelectorAll(".sidebar-nav-item").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view))
  })

  // ARCHITECTURE.md section 79: a persistent, cross-restart record of
  // every verse shown — this view answers "what have I shown across
  // every service, ever," aggregated client-side from the raw entries
  // main.ts hands back (the same thin-passthrough division of
  // responsibility list-media-cues already uses). Re-fetched every time
  // the view is opened, not cached, so it reflects verses shown since
  // the operator last looked.
  function localDateKey(timestamp) {
    const d = new Date(timestamp)
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
  }

  function referenceKey(ref) {
    return ref.book + " " + ref.chapter + ":" + ref.verse
  }

  function renderHistoryView() {
    historySummaryEl.textContent = t("history.loading")
    historyMostShownEl.innerHTML = ""
    historyRecentServicesEl.innerHTML = ""

    window.churchOverlay
      .getSessionHistory()
      .then((entries) => {
        if (entries.length === 0) {
          historySummaryEl.textContent = t("history.empty")
          return
        }

        const dayCount = new Map()
        const verseCount = new Map()
        for (const entry of entries) {
          const day = localDateKey(entry.timestamp)
          dayCount.set(day, (dayCount.get(day) || 0) + 1)
          const key = referenceKey(entry.reference)
          verseCount.set(key, (verseCount.get(key) || 0) + 1)
        }

        historySummaryEl.innerHTML =
          "<strong>" + entries.length + "</strong> " + t("history.versesShownAcross") +
          " <strong>" + dayCount.size + "</strong> " + (dayCount.size === 1 ? t("history.daySingular") : t("history.dayPlural"))

        const topVerses = Array.from(verseCount.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
        for (const [key, count] of topVerses) {
          const row = document.createElement("div")
          row.className = "history-row"
          row.innerHTML = "<span></span><span></span>"
          row.children[0].textContent = key
          row.children[1].textContent = "×" + count
          historyMostShownEl.appendChild(row)
        }

        const recentDays = Array.from(dayCount.entries())
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .slice(0, 14)
        for (const [day, count] of recentDays) {
          const row = document.createElement("div")
          row.className = "history-row"
          row.innerHTML = "<span></span><span></span>"
          row.children[0].textContent = day
          row.children[1].textContent = count + " " + (count === 1 ? t("history.verseSingular") : t("history.versePlural"))
          historyRecentServicesEl.appendChild(row)
        }
      })
      .catch((err) => {
        historySummaryEl.textContent = ""
        log(t("log.historyLoadFailed", { error: err.message }), "error")
      })
  }

  document.getElementById("nav-history").addEventListener("click", renderHistoryView)

  function showSetupScreen() {
    appShellEl.style.display = "none"
    setupScreenEl.style.display = "flex"
  }

  // ARCHITECTURE.md section 65.6: the phone remote's own panel — one of
  // three states (disabled / enabled with a link / enabled but no LAN
  // address was found), never all three at once.
  function renderRemotePanel(remoteUrl, allowPhoneRemoteEnabled) {
    if (remoteUrl) {
      remoteDisabledEl.style.display = "none"
      remoteNoLanEl.style.display = "none"
      remoteEnabledEl.style.display = "block"
      remoteUrlInput.value = remoteUrl
    } else if (allowPhoneRemoteEnabled) {
      remoteDisabledEl.style.display = "none"
      remoteEnabledEl.style.display = "none"
      remoteNoLanEl.style.display = "block"
    } else {
      remoteEnabledEl.style.display = "none"
      remoteNoLanEl.style.display = "none"
      remoteDisabledEl.style.display = "block"
    }
  }

  remoteCopyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText(remoteUrlInput.value)
      .then(() => log(t("log.remoteLinkCopied"), "sent"))
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
  })

  // A production audit found this URL was previously never surfaced
  // anywhere for the operator to paste into OBS's own Browser Source.
  function renderObsPanel(overlayUrl) {
    if (overlayUrl) obsUrlInput.value = overlayUrl
  }

  // Derives mediaOrigin from the same overlayUrl the OBS panel and the
  // embedded preview iframe already use — one real, known-good origin,
  // not a second guess at the static server's port.
  function setMediaOrigin(overlayUrl) {
    if (!overlayUrl) return
    mediaOrigin = new URL(overlayUrl).origin
    renderMediaGrid()
  }

  // ARCHITECTURE.md section 69: points the embedded Live-view preview at
  // the same overlay URL the OBS panel above shows — the app's own
  // former standalone preview window is gone, combined into this one
  // iframe instead. Setting src only once (skipping a redundant
  // reassignment on every status poll) avoids reloading — and briefly
  // blanking — the live preview's own independent WS connection.
  function renderOverlayPreview(overlayUrl) {
    if (overlayUrl && overlayPreviewFrameEl.src !== overlayUrl) {
      overlayPreviewFrameEl.src = overlayUrl
    }
  }

  obsCopyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText(obsUrlInput.value)
      .then(() => log(t("log.obsLinkCopied"), "sent"))
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
  })

  // ARCHITECTURE.md section 65.8: post-service content export — a
  // plain-text transcript plus one quote-card PNG per shown verse, saved
  // to an operator-chosen folder.
  exportSessionBtn.addEventListener("click", () => {
    exportSessionBtn.disabled = true
    exportSessionBtn.textContent = t("session.exporting")
    window.churchOverlay
      .exportSession()
      .then((result) => {
        if (result.canceled) return
        if (result.error) {
          log(result.error, "error")
        } else {
          log(t("log.sessionExported", { count: result.count, targetDir: result.targetDir }), "received")
        }
      })
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
      .finally(() => {
        exportSessionBtn.disabled = false
        exportSessionBtn.textContent = t("session.exportButton")
      })
  })

  exportDiagnosticsBtn.addEventListener("click", () => {
    exportDiagnosticsBtn.disabled = true
    window.churchOverlay
      .exportDiagnostics()
      .then((result) => {
        if (!result.canceled) log(t("log.diagnosticsExported", { path: result.path }), "received")
      })
      .catch((err) => log(err.message, "error"))
      .finally(() => {
        exportDiagnosticsBtn.disabled = false
      })
  })

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
    renderNdiStatus(currentNdiStatus)
    window.churchOverlay.setUiLanguage(lang).catch(() => {})
  })
  wireOptionGroup(verseConfirmationToggleEl, "confirmationMode", (mode) => {
    window.churchOverlay
      .setVerseConfirmationMode(mode)
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
  })
  wireOptionGroup(sermonNotesToggleEl, "notesEnabled", (value) => {
    window.churchOverlay
      .setEnableSermonNotes(value === "on")
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
  })
  // ARCHITECTURE.md section 82: a pure WS round trip like poster:set
  // above — this is a viewer-facing broadcast setting, not a
  // ConfigStore/IPC concern in itself (persistence happens on the main
  // process side via onVerseLayoutChanged, triggered by this same
  // layout:set command).
  wireOptionGroup(verseLayoutToggleEl, "layout", (layout) => {
    sendJson({ id: crypto.randomUUID(), type: "layout:set", timestamp: Date.now(), payload: { layout } })
    log(t("log.sentLayoutSet", { layout }), "sent")
  })
  posterDurationApplyBtn.addEventListener("click", () => {
    const raw = posterDurationInputEl.value.trim()
    const minutes = raw === "" ? null : Number(raw)
    const durationMs = minutes === null || !Number.isFinite(minutes) || minutes <= 0 ? null : minutes * 60000
    sendJson({
      id: crypto.randomUUID(),
      type: "poster:set-duration",
      timestamp: Date.now(),
      payload: { durationMs },
    })
    log(t("log.sentPosterDuration", { minutes: durationMs === null ? t("verseLayout.posterDurationManual") : String(minutes) }), "sent")
  })

  function setActiveOption(groupEl, datasetKey, value) {
    groupEl.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset[datasetKey] === value)
    })
  }

  setupSaveBtn.addEventListener("click", () => {
    const apiKey = setupKeyInput.value.trim()
    const deepgramApiKey = setupDeepgramKeyInput.value.trim()
    if (!apiKey && !deepgramApiKey) {
      setSetupError("Enter a Groq or Deepgram API key.")
      return
    }
    setSetupError("")
    setupSaveBtn.disabled = true
    setupSaveBtn.textContent = t("setup.saving")

    window.churchOverlay
      .completeSetup(apiKey, deepgramApiKey, setupSelectedMode, setupSelectedUiLanguage, setupAllowPhoneRemoteEl.checked)
      .then((info) => {
        setActiveOption(displayModeToggleEl, "mode", setupSelectedMode)
        setActiveOption(uiLanguageToggleEl, "lang", setupSelectedUiLanguage)
        setActiveOption(verseConfirmationToggleEl, "confirmationMode", info.verseConfirmationMode || "auto")
        setActiveOption(sermonNotesToggleEl, "notesEnabled", info.enableSermonNotes ? "on" : "off")
        setActiveOption(verseLayoutToggleEl, "layout", info.verseLayout || "fullscreen")
        renderRemotePanel(info.remoteUrl, info.allowPhoneRemote)
        renderObsPanel(info.overlayUrl)
        renderOverlayPreview(info.overlayUrl)
        setMediaOrigin(info.overlayUrl)
        renderNdiStatus(info.ndi)
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
        setActiveOption(verseConfirmationToggleEl, "confirmationMode", status.verseConfirmationMode || "auto")
        setActiveOption(sermonNotesToggleEl, "notesEnabled", status.enableSermonNotes ? "on" : "off")
        setActiveOption(verseLayoutToggleEl, "layout", status.verseLayout || "fullscreen")
        renderRemotePanel(status.remoteUrl, status.allowPhoneRemote)
        renderObsPanel(status.overlayUrl)
        renderOverlayPreview(status.overlayUrl)
        setMediaOrigin(status.overlayUrl)
        renderNdiStatus(status.ndi)
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
