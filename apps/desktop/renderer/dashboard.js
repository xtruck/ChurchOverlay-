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

  // Vespers 2 icon set: the same 24px / 1.75-stroke family as the inline
  // SVGs in index.html (stroke, fill and caps come from the .icon class).
  // Static strings only — never built from data.
  const svgIcon = (paths) => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + paths + "</svg>"
  const ICONS = {
    close: svgIcon('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    plus: svgIcon('<path d="M12 5v14M5 12h14"/>'),
    arrowUp: svgIcon('<path d="M12 19V5m0 0-5.5 5.5M12 5l5.5 5.5"/>'),
    arrowDown: svgIcon('<path d="M12 5v14m0 0-5.5-5.5M12 19l5.5-5.5"/>'),
    duplicate: svgIcon('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  }

  const statusPillEl = document.getElementById("status-pill")
  const statusTextEl = document.getElementById("status-text")
  const logEl = document.getElementById("log")
  const transcriptEl = document.getElementById("transcript")
  const transcriptLangEl = document.getElementById("transcript-lang")
  const transcriptTranslationEl = document.getElementById("transcript-translation")
  let lastFinalTranscriptId = null
  const nearMissIndicatorEl = document.getElementById("near-miss-indicator")
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
  const setupAnthropicKeyInput = document.getElementById("setup-anthropic-key")
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
  const frenchTranslationToggleEl = document.getElementById("french-translation-toggle")
  const posterDurationInputEl = document.getElementById("poster-duration-input")
  const posterDurationApplyBtn = document.getElementById("poster-duration-apply-btn")
  const versePendingBannerEl = document.getElementById("verse-pending-banner")
  const pendingAnnounceEl = document.getElementById("pending-announce")
  const versePendingTextEl = document.getElementById("verse-pending-text")
  const versePendingRefEl = document.getElementById("verse-pending-ref")
  const versePendingConfirmBtn = document.getElementById("verse-pending-confirm-btn")
  const setupDisplayModeEl = document.getElementById("setup-display-mode")
  const setupUiLanguageEl = document.getElementById("setup-ui-language")
  const setupAllowPhoneRemoteEl = document.getElementById("setup-allow-phone-remote")
  const setupAudioProfileEl = document.getElementById("setup-audio-profile")
  const setupOrganizationNameEl = document.getElementById("setup-organization-name")
  const setupAccentColorEl = document.getElementById("setup-accent-color")
  const setupAccentColorResetBtn = document.getElementById("setup-accent-color-reset")
  const DEFAULT_ACCENT_COLOR = "#e0a93b"
  // New elements from the operator-console redesign.
  const livePreviewEl = document.getElementById("live-preview")
  const tallyChipEl = document.getElementById("tally-chip")
  const versePendingOriginEl = document.getElementById("verse-pending-origin")
  const micHealthEl = document.getElementById("mic-health")
  const micHealthTextEl = document.getElementById("mic-health-text")
  const micStatSpeechEl = document.getElementById("mic-stat-speech")
  const micStatNoiseEl = document.getElementById("mic-stat-noise")
  const micStatGainEl = document.getElementById("mic-stat-gain")
  const autoGainToggleEl = document.getElementById("auto-gain-toggle")
  const asrProviderLineEl = document.getElementById("asr-provider-line")
  const asrStrategyToggleEl = document.getElementById("asr-strategy-toggle")
  const asrStrategyNoteEl = document.getElementById("asr-strategy-note")
  const brandMarkEl = document.getElementById("brand-mark")
  const brandTitleEl = document.getElementById("brand-title")
  const remoteDisabledEl = document.getElementById("remote-disabled")
  const remoteEnabledEl = document.getElementById("remote-enabled")
  const remoteNoLanEl = document.getElementById("remote-no-lan")
  const remoteUrlInput = document.getElementById("remote-url")
  const remoteCopyBtn = document.getElementById("remote-copy-btn")
  const remoteToggleBtn = document.getElementById("remote-toggle-btn")
  const obsUrlInput = document.getElementById("obs-url")
  const obsCopyBtn = document.getElementById("obs-copy-btn")
  const ndiToggleBtn = document.getElementById("ndi-toggle-btn")
  const ndiStatusEl = document.getElementById("ndi-status")
  // ARCHITECTURE.md section 109: the output reports stats and an error/retry state, so the operator
  // can see it is really streaming (size, measured fps) instead of trusting a one-time "running".
  let ndiPollTimer = null
  function renderNdiStatus(status) {
    currentNdiStatus = status || { state: "disabled" }
    const state = currentNdiStatus.state || "disabled"
    // "error" while still attached means the output is retrying: offer Disable (stop retrying), not Enable.
    ndiEnabled = state === "running" || state === "starting" || (state === "error" && currentNdiStatus.active === true)
    ndiToggleBtn.disabled = state === "starting"
    ndiToggleBtn.textContent = t(ndiEnabled ? "ndi.disable" : "ndi.enable")
    const stats = currentNdiStatus.stats
    if (state === "running") {
      ndiStatusEl.textContent = stats && stats.width
        ? t("ndi.runningStats", { size: stats.width + "×" + stats.height, fps: stats.fps, sent: stats.framesSent })
        : t("ndi.running")
    } else if (state === "error") {
      ndiStatusEl.textContent = t("ndi.error", { reason: currentNdiStatus.reason || "" })
    } else {
      ndiStatusEl.textContent = state === "unavailable" ? t("ndi.unavailable") : ""
    }
    // Poll cheaply only while there is something live to show; stop as soon as NDI is off.
    if (ndiEnabled && !ndiPollTimer) {
      ndiPollTimer = setInterval(() => {
        window.churchOverlay.getNdiStatus().then(renderNdiStatus).catch(() => {})
      }, 2000)
    } else if (!ndiEnabled && ndiPollTimer) {
      clearInterval(ndiPollTimer)
      ndiPollTimer = null
    }
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
  const exportRehearsalBtn = document.getElementById("export-rehearsal-btn")
  const exportDiagnosticsBtn = document.getElementById("export-diagnostics-btn")
  const generateServiceSummaryBtn = document.getElementById("generate-service-summary-btn")
  const serviceSummaryResultEl = document.getElementById("service-summary-result")
  const sermonNotesToggleEl = document.getElementById("sermon-notes-toggle")
  const sidebarEl = document.getElementById("sidebar")
  const viewEls = {
    live: document.getElementById("view-live"),
    rundown: document.getElementById("view-rundown"),
    media: document.getElementById("view-media"),
    history: document.getElementById("view-history"),
    overlay: document.getElementById("view-overlay"),
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
  let allowPhoneRemoteEnabled = false

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

  // Errors also surface as a toast: the Activity log lives in a drawer that
  // is collapsed for most of a service. Pass { toast: false } for errors
  // the UI already shows elsewhere (the reconnect cycle drives the status
  // pill), so a dropped connection does not stack a toast every retry.
  function log(text, kind, options) {
    const wantsToast = options && typeof options.toast === "boolean" ? options.toast : kind === "error"
    if (wantsToast) showToast(text, kind === "error" ? "error" : "info")
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

  // Bounded (AGENTS.md section 36): at most MAX_TOASTS on screen, and an
  // identical message already showing is refreshed instead of duplicated.
  const toastRegionEl = document.getElementById("toast-region")
  const MAX_TOASTS = 3
  const TOAST_LIFETIME_MS = 4500
  // Errors stay long enough to be read and announce assertively; hovering or
  // focusing a toast pauses its timer; every toast can be dismissed.
  const TOAST_ERROR_LIFETIME_MS = 9000
  function showToast(text, kind) {
    if (!toastRegionEl || !text) return
    const existing = Array.from(toastRegionEl.children).find((el) => el.dataset.text === text)
    if (existing) {
      clearTimeout(existing._timer)
      existing.remove()
    }
    const toast = document.createElement("div")
    const isError = kind === "error"
    toast.className = "toast toast-" + (kind || "info")
    toast.dataset.text = text
    toast.setAttribute("role", isError ? "alert" : "status")
    const message = document.createElement("span")
    message.className = "toast-message"
    message.textContent = text
    const close = document.createElement("button")
    close.type = "button"
    close.className = "toast-close"
    close.innerHTML = ICONS.close
    close.setAttribute("aria-label", t("toast.dismiss"))
    toast.append(message, close)
    toastRegionEl.appendChild(toast)
    while (toastRegionEl.children.length > MAX_TOASTS) {
      const oldest = toastRegionEl.firstElementChild
      clearTimeout(oldest._timer)
      oldest.remove()
    }
    const lifetime = isError ? TOAST_ERROR_LIFETIME_MS : TOAST_LIFETIME_MS
    const dismiss = () => {
      clearTimeout(toast._timer)
      toast.classList.add("leaving")
      setTimeout(() => toast.remove(), 200)
    }
    const arm = () => {
      clearTimeout(toast._timer)
      toast._timer = setTimeout(dismiss, lifetime)
    }
    close.addEventListener("click", dismiss)
    toast.addEventListener("mouseenter", () => clearTimeout(toast._timer))
    toast.addEventListener("mouseleave", arm)
    toast.addEventListener("focusin", () => clearTimeout(toast._timer))
    toast.addEventListener("focusout", arm)
    arm()
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

  function currentDisplayMode() {
    const active = displayModeToggleEl.querySelector("button.active")
    return active ? active.dataset.mode : "english"
  }

  /** The reference as the congregation will read it: French names in French mode. */
  function formatDisplayedReference(verse) {
    const ref = verse.reference
    if (verse.secondary) return formatBilingualReference(ref)
    // Same rule as the overlay: the translation says the language.
    if (["ls1910", "lsg", "segond"].includes(String(verse.translation || "").toLowerCase()) || currentDisplayMode() === "french") {
      return (FRENCH_BOOK_NAMES[ref.book] || capitalize(ref.book)) + " " + ref.chapter + ":" + ref.verse
    }
    return formatReference(ref)
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
    versePendingRefEl.textContent = formatDisplayedReference(verse)
    // A verse recognised from a reading (no reference spoken) is always a
    // suggestion, even in auto mode — say why it is waiting.
    const originKey = verse.corroboratedBy === "interpreter"
      ? "livePreview.pendingCorroborated"
      : verse.origin === "ai" ? (verse.suggestedBy === "cleanup" ? "livePreview.pendingFromAiCleanup" : verse.suggestedBy === "semantic" ? "livePreview.pendingFromAiSemantic" : "livePreview.pendingFromAi") : verse.origin === "quote" ? "livePreview.pendingFromQuote" : verse.origin === "inferred" ? "livePreview.pendingFromVolume" : null
    versePendingOriginEl.style.display = originKey ? "block" : "none"
    if (originKey) {
      versePendingOriginEl.dataset.i18n = originKey // stays right if the UI language changes
      versePendingOriginEl.textContent = t(originKey)
    }
    renderPendingAlternatives(verse)
    versePendingBannerEl.style.display = "flex"
    livePreviewEl.classList.add("has-pending")
    globalPendingBtn.style.display = ""
    // One sentence in an always-present live region (the banner itself is not announced).
    const waiting = t("livePreview.pendingLabel") + ": " + versePendingRefEl.textContent
    pendingAnnounceEl.textContent = waiting + ". " + t("livePreview.pendingConfirm") + " (Ctrl+Enter)"
    globalPendingBtn.setAttribute("aria-label", waiting)
  }

  // Header shortcut to a waiting verse, so it is noticed from any view.
  // It only navigates: confirming stays the Live view's own button.
  const globalPendingBtn = document.getElementById("global-pending")
  globalPendingBtn.addEventListener("click", () => {
    showView("live")
    versePendingConfirmBtn.focus()
  })

  // The server found the same words fit more than one verse (e.g. 1 and 2 Corinthians
  // when no volume was said and no context names one). One button per alternative;
  // choosing one is a normal manual override, so it takes the same validated path.
  const versePendingAlternativesEl = document.getElementById("verse-pending-alternatives")
  function renderPendingAlternatives(verse) {
    versePendingAlternativesEl.textContent = ""
    const alternatives = Array.isArray(verse.alternatives) ? verse.alternatives : []
    for (const alternative of alternatives) {
      const label = formatDisplayedReference(alternative)
      const button = document.createElement("button")
      button.type = "button"
      button.className = "btn-secondary"
      button.textContent = t("livePreview.pendingAlternative", { reference: label })
      button.addEventListener("click", () => {
        sendJson({ id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: alternative.reference })
        log(t("log.sentVerseOverride", { reference: JSON.stringify(alternative.reference) }), "sent")
      })
      versePendingAlternativesEl.appendChild(button)
    }
  }

  function clearPendingVerse() {
    versePendingBannerEl.style.display = "none"
    livePreviewEl.classList.remove("has-pending")
    globalPendingBtn.style.display = "none"
    pendingAnnounceEl.textContent = ""
    globalPendingBtn.removeAttribute("aria-label")
  }

  versePendingConfirmBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "verse:confirm-pending", timestamp: Date.now(), payload: null })
    log(t("log.sentVerseConfirmPending"), "sent")
  })

  // ASR/transcription health (status:update) — see ARCHITECTURE.md's
  // action-registry comment: a real producer now exists (AppCore
  // broadcasts this on a GroqProvider error, and again on the next
  // successful transcript as the recovery signal).
  // ARCHITECTURE.md section 132: absent echoWarning means "no change", null clears it.
  const echoWarningEl = document.getElementById("echo-warning")
  let echoReason = null

  function renderEchoWarning() {
    if (!echoWarningEl) return
    echoWarningEl.hidden = echoReason === null
    echoWarningEl.textContent = echoReason === null ? "" : t(echoReason === "media-loud" ? "echo.mediaLoud" : "echo.repeated")
  }

  window.addEventListener("churchoverlay:languagechange", renderEchoWarning)

  function handleStatusUpdate(payload) {
    if (!payload) return
    if (payload.echoWarning !== undefined) {
      echoReason = payload.echoWarning === null ? null : payload.echoWarning.reason
      renderEchoWarning()
    }
    if (payload.audioMetrics && audioDiagnosticsEl) {
      const m = payload.audioMetrics
      audioDiagnosticsEl.textContent = t("mic.framesForwarded", { forwarded: m.framesForwarded, received: m.framesReceived })
    }
    asrHealthWarningEl.classList.remove("asr-health-warning-throttled", "asr-health-warning-rate-limited", "asr-health-warning-failover")
    asrReturnPrimaryBtn.style.display = "none"
    if (typeof payload.asrHealth === "string") statusbarAsrEl.dataset.health = payload.asrHealth
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
    }
  }

  // Registered once. It used to be attached inside the calibration branch
  // above: never attached if no calibration had finished yet (a dead
  // button), and attached again on every calibration (duplicate commands).
  asrReturnPrimaryBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "asr:return-primary", timestamp: Date.now(), payload: null })
  })

  // ARCHITECTURE.md section 91: detector:near-miss's dashboard surface —
  // transient, not persistent like the ASR health warning, since it
  // describes one utterance rather than an ongoing condition. A new
  // near-miss resets (does not queue behind) an earlier one still
  // showing, the same "most recent wins" pattern verseAutoClearTimer
  // already uses server-side.
  // ARCHITECTURE.md section 92: applies the operator's optional branding —
  // absent/blank means "leave the app's own neutral defaults alone"
  // ('ChurchOverlay' / 'CO' / the built-in accent), never a church-
  // specific fallback baked into the app itself.
  function applyBranding(organizationName, accentColor) {
    if (organizationName) {
      brandTitleEl.textContent = organizationName
      const initials = organizationName
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word.charAt(0).toUpperCase())
        .join("")
      brandMarkEl.textContent = initials || "CO"
    }
    if (accentColor) {
      document.documentElement.style.setProperty("--accent", accentColor)
      // Any church colour must stay readable as a button background:
      // pick dark or light ink from the colour's own relative luminance.
      document.documentElement.style.setProperty("--accent-ink", relativeLuminance(accentColor) > 0.35 ? "#1c1405" : "#ffffff")
    }
  }

  function relativeLuminance(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex || "")
    if (!match) return 1
    const value = parseInt(match[1], 16)
    const channel = (shift) => {
      const c = ((value >> shift) & 255) / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
  }

  // ---- Congregation-screen tally ----------------------------------------
  // Red frame while anything is on the congregation's screen, amber while a
  // verse waits for confirmation. The poster is a persistent backdrop under
  // everything, so it never lights the tally on its own.
  const onScreen = { verse: null, media: null, announcement: false, canvas: false }
  // When the current item went live, for the on-air timer. Restarts
  // whenever what is on screen changes, not only when it first goes live.
  let onAirSince = null
  let onAirKey = null
  const globalTallyEl = document.getElementById("global-tally")
  const globalTallyLabelEl = document.getElementById("global-tally-label")
  function renderTally() {
    const live = Boolean(onScreen.verse || onScreen.media || onScreen.announcement || onScreen.canvas)
    livePreviewEl.classList.toggle("on-air", live)
    const key = live ? [onScreen.verse, onScreen.media, onScreen.announcement, onScreen.canvas].join("|") : null
    if (key !== onAirKey) {
      onAirKey = key
      onAirSince = live ? Date.now() : null
    }
    renderClocks()
    renderRecentVerses()
    let text = t("livePreview.offAir")
    if (onScreen.verse) text = t("livePreview.onAirVerse", { reference: onScreen.verse })
    else if (onScreen.media) text = t("livePreview.onAirMedia", { title: onScreen.media })
    else if (live) text = t("livePreview.onAir")
    tallyChipEl.textContent = text
    // The header tally mirrors the program monitor's state from every view.
    const tallyKey = live ? "tally.onAir" : "tally.offAir"
    globalTallyEl.dataset.state = live ? "on" : "off"
    globalTallyLabelEl.dataset.i18n = tallyKey // stays right if the UI language changes
    globalTallyLabelEl.textContent = t(tallyKey)
    globalTallyEl.title = text
  }

  // ---- Microphone health (mic:health, ~1/s while listening) ---------------
  function formatDb(value) {
    return typeof value === "number" ? Math.round(value) + " dB" : "–"
  }
  // Status bar: a short mirror of the mic card's state, readable from any view.
  const statusbarMicEl = document.getElementById("statusbar-mic")
  const statusbarMicTextEl = document.getElementById("statusbar-mic-text")
  const statusbarAsrEl = document.getElementById("statusbar-asr")
  const statusbarAsrTextEl = document.getElementById("statusbar-asr-text")
  function renderStatusbarMic(state) {
    statusbarMicEl.dataset.state = state
    statusbarMicTextEl.dataset.i18n = "statusbar.mic." + state
    statusbarMicTextEl.textContent = t("statusbar.mic." + state)
  }

  function renderMicHealth(payload) {
    renderStatusbarMic(payload ? payload.state : "idle")
    if (!payload) {
      micHealthEl.dataset.state = "idle"
      micHealthTextEl.textContent = t("micHealth.idle")
      micStatSpeechEl.textContent = "–"
      micStatNoiseEl.textContent = "–"
      micStatGainEl.textContent = "–"
      return
    }
    micHealthEl.dataset.state = payload.state
    micHealthTextEl.textContent = t("micHealth." + payload.state)
    micStatSpeechEl.textContent = formatDb(payload.speechDbfs)
    micStatNoiseEl.textContent = formatDb(payload.noiseDbfs)
    micStatGainEl.textContent = payload.autoGain ? "+" + Math.round(payload.gainDb) + " dB" : t("micHealth.gainOff")
    autoGainToggleEl.checked = payload.autoGain
  }
  autoGainToggleEl.addEventListener("change", () => {
    sendJson({ id: crypto.randomUUID(), type: "mic:auto-gain", timestamp: Date.now(), payload: { enabled: autoGainToggleEl.checked } })
    log(t(autoGainToggleEl.checked ? "log.autoGainOn" : "log.autoGainOff"), "sent")
  })

  // ---- Pipeline latency (final transcript -> verse:show / verse:pending) ---
  // Read over IPC, not WS: operator diagnostics, not part of the overlay
  // protocol. Polled slowly — the numbers only move when a verse is shown.
  const latencyLastEl = document.getElementById("latency-last")
  const latencyMedianEl = document.getElementById("latency-median")
  const latencyP95El = document.getElementById("latency-p95")
  function formatLatency(ms) {
    if (typeof ms !== "number") return "–"
    return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s"
  }
  function refreshLatency() {
    if (!window.churchOverlay || !window.churchOverlay.getPipelineLatency) return
    window.churchOverlay
      .getPipelineLatency()
      .then((snapshot) => {
        latencyLastEl.textContent = formatLatency(snapshot && snapshot.lastMs)
        latencyMedianEl.textContent = formatLatency(snapshot && snapshot.p50Ms)
        latencyP95El.textContent = formatLatency(snapshot && snapshot.p95Ms)
      })
      .catch((err) => console.error("pipeline latency unavailable", err))
  }
  setInterval(refreshLatency, 5000)

  // ---- Sermon-prep import (ARCHITECTURE.md section 130) --------------------
  // The server parses and validates; this only renders the references it returns.
  // Imported text never reaches innerHTML: every node is built with textContent.
  // "Show" is an ordinary verse:override, validated again on the server.
  const sermonPrepInputEl = document.getElementById("sermon-prep-input")
  const sermonPrepImportBtn = document.getElementById("sermon-prep-import-btn")
  const sermonPrepClearBtn = document.getElementById("sermon-prep-clear-btn")
  const sermonPrepStatusEl = document.getElementById("sermon-prep-status")
  const sermonPrepListEl = document.getElementById("sermon-prep-list")
  const sermonPrepAvailable = Boolean(window.churchOverlay && window.churchOverlay.importSermonPrep)

  function renderSermonPrep(result) {
    sermonPrepListEl.textContent = ""
    const references = result && Array.isArray(result.references) ? result.references : []
    references.forEach((r) => {
      const item = document.createElement("li")
      item.className = "sermon-prep-item"
      const label = document.createElement("span")
      label.className = "sermon-prep-ref"
      label.textContent = formatDisplayedReference({ reference: r })
      const show = document.createElement("button")
      show.type = "button"
      show.className = "btn-secondary btn-small"
      show.textContent = t("sermonPrep.show")
      show.addEventListener("click", () => {
        const payload = { book: r.book, chapter: r.chapter, verse: r.verse }
        sendJson({ id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload })
        item.classList.add("shown")
        log(t("log.sentVerseOverride", { reference: JSON.stringify(payload) }), "sent")
      })
      item.append(label, show)
      sermonPrepListEl.appendChild(item)
    })
    if (!result) {
      sermonPrepStatusEl.textContent = ""
      return
    }
    let status = t("sermonPrep.found", { count: references.length })
    if (result.rejectedCount > 0) status += " " + t("sermonPrep.rejected", { count: result.rejectedCount })
    if (result.truncated) status += " " + t("sermonPrep.truncated", { count: references.length })
    sermonPrepStatusEl.textContent = status
  }

  if (!sermonPrepAvailable) {
    sermonPrepImportBtn.disabled = true
    sermonPrepClearBtn.disabled = true
  } else {
    sermonPrepImportBtn.addEventListener("click", () => {
      window.churchOverlay
        .importSermonPrep(String(sermonPrepInputEl.value))
        .then((outcome) => {
          if (outcome && outcome.ok) {
            renderSermonPrep(outcome.result)
            return
          }
          sermonPrepStatusEl.textContent = t(outcome && outcome.reason === "too-long" ? "sermonPrep.tooLong" : "sermonPrep.failed")
        })
        .catch((err) => {
          console.error("sermon prep import failed", err)
          sermonPrepStatusEl.textContent = t("sermonPrep.failed")
        })
    })
    sermonPrepClearBtn.addEventListener("click", () => {
      window.churchOverlay
        .clearSermonPrep()
        .then(() => {
          sermonPrepInputEl.value = ""
          renderSermonPrep(null)
        })
        .catch((err) => console.error("sermon prep clear failed", err))
    })
    // A reloaded dashboard rebuilds its queue from the server's copy (the server is authoritative).
    window.churchOverlay
      .getSermonPrep()
      .then((result) => renderSermonPrep(result))
      .catch((err) => console.error("sermon prep unavailable", err))
  }

  // ---- Offline backup (Settings) -----------------------------------------
  const localAsrModelToggleEl = document.getElementById("local-asr-model-toggle")
  const localAsrEngineToggleEl = document.getElementById("local-asr-engine-toggle")
  const localAsrEngineHintEl = document.getElementById("local-asr-engine-hint")
  const localAsrStatusEl = document.getElementById("local-asr-status")
  const localAsrProgressEl = document.getElementById("local-asr-progress")
  const localAsrInstallBtn = document.getElementById("local-asr-install-btn")
  const localAsrEnabledEl = document.getElementById("local-asr-enabled")
  let localModel = "base"
  let localEngine = "whisper.cpp"
  let localInstall = null
  let localSizeMb = 0

  function renderLocalEngineHint() {
    const key = localEngine === "faster-whisper" ? "localAsr.engineHintFw" : "localAsr.engineHintCpp"
    localAsrEngineHintEl.dataset.i18n = key // keeps the hint right when the UI language changes
    localAsrEngineHintEl.textContent = t(key)
  }

  function renderLocalAsr(install, asr) {
    localInstall = install || localInstall
    if (asr) {
      localAsrEnabledEl.checked = Boolean(asr.localEnabled)
      if (asr.localModel && asr.localModel !== localModel) {
        localModel = asr.localModel
        setActiveOption(localAsrModelToggleEl, "localModel", localModel)
      }
      if (asr.localEngine && asr.localEngine !== localEngine) {
        localEngine = asr.localEngine
        setActiveOption(localAsrEngineToggleEl, "localEngine", localEngine)
        renderLocalEngineHint()
      }
    }
    const state = localInstall ? localInstall.state : "not-installed"
    localAsrProgressEl.style.display = state === "downloading" ? "block" : "none"
    localAsrInstallBtn.style.display = state === "ready" || state === "unsupported" ? "none" : ""
    localAsrInstallBtn.disabled = state === "downloading"
    localAsrInstallBtn.textContent = localSizeMb ? t("localAsr.installSize", { size: localSizeMb }) : t("localAsr.install")
    localAsrEnabledEl.disabled = state !== "ready"
    if (state === "downloading") {
      localAsrProgressEl.value = localInstall.progress || 0
      localAsrStatusEl.textContent = t(localInstall.step === "engine" ? "localAsr.downloadingEngine" : "localAsr.downloadingModel", {
        percent: Math.round((localInstall.progress || 0) * 100),
      })
    } else if (state === "ready") {
      localAsrStatusEl.textContent = localAsrEnabledEl.checked ? t("localAsr.readyOn") : t("localAsr.readyOff")
    } else if (state === "unsupported") {
      localAsrStatusEl.textContent = t("localAsr.unsupported")
    } else if (state === "error") {
      localAsrStatusEl.textContent = t("localAsr.error", { error: localInstall.error })
    } else {
      localAsrStatusEl.textContent = t("localAsr.notInstalled")
    }
  }

  function refreshLocalAsr() {
    if (!window.churchOverlay.getLocalAsrStatus) return
    window.churchOverlay
      .getLocalAsrStatus(localModel, localEngine)
      .then((status) => {
        localSizeMb = status.sizeMb || 0
        renderLocalAsr(status.install, status.asr)
      })
      .catch(() => {})
  }

  if (window.churchOverlay.onLocalAsrProgress) {
    window.churchOverlay.onLocalAsrProgress((state) => renderLocalAsr(state, null))
  }

  wireOptionGroup(localAsrModelToggleEl, "localModel", (model) => {
    localModel = model
    localInstall = null
    refreshLocalAsr()
  })

  wireOptionGroup(localAsrEngineToggleEl, "localEngine", (engine) => {
    localEngine = engine
    localInstall = null
    renderLocalEngineHint()
    refreshLocalAsr()
  })
  renderLocalEngineHint()

  localAsrInstallBtn.addEventListener("click", () => {
    renderLocalAsr({ state: "downloading", step: "engine", progress: 0 }, null)
    window.churchOverlay
      .installLocalAsr(localModel, localEngine)
      .then((state) => {
        renderLocalAsr(state, null)
        log(t(state.state === "ready" ? "log.localAsrInstalled" : "log.localAsrInstallFailed"), state.state === "ready" ? "received" : "error")
      })
      .catch((err) => renderLocalAsr({ state: "error", error: err.message }, null))
  })

  localAsrEnabledEl.addEventListener("change", () => {
    const enabled = localAsrEnabledEl.checked
    localAsrEnabledEl.disabled = true
    localAsrStatusEl.textContent = t("asrSettings.restarting")
    window.churchOverlay
      .setLocalAsr(enabled, localModel, localEngine)
      .then((status) => {
        renderAsrStatus(status)
        renderLocalAsr(null, status)
        log(t(enabled ? "log.localAsrOn" : "log.localAsrOff"), "sent")
      })
      .catch((err) => {
        localAsrEnabledEl.checked = !enabled
        renderLocalAsr({ state: "error", error: err.message }, null)
      })
  })

  // ---- Transcription strategy (Settings) ---------------------------------
  let asrStatus = null
  // ARCHITECTURE.md sections 123-126: the optional AI features. The server is the source of
  // truth; this only mirrors it. Disabled (not hidden) without an Anthropic key.
  const aiNoKeyHintEl = document.getElementById("ai-no-key-hint")
  const aiFeatureToggleEls = [...document.querySelectorAll(".ai-feature-toggle")]
  function renderAiFeatures(flags) {
    aiFeatureToggleEls.forEach((groupEl) => {
      setActiveOption(groupEl, "aiEnabled", flags && flags[groupEl.dataset.aiFeature] ? "on" : "off")
    })
    setCopilotFeatureOn(Boolean(flags && flags.sermonCopilot))
  }

  // ARCHITECTURE.md section 125: the copilot card. Suggestions are operator-only text; everything
  // is rendered with textContent, and "Show" is an ordinary verse:override (validated again).
  const copilotEmptyEl = document.getElementById("copilot-empty")
  const copilotBodyEl = document.getElementById("copilot-body")
  const copilotVersesSectionEl = document.getElementById("copilot-verses-section")
  const copilotVersesEl = document.getElementById("copilot-verses")
  const copilotPointSectionEl = document.getElementById("copilot-point-section")
  const copilotCaptionEl = document.getElementById("copilot-caption")
  const copilotSlideEl = document.getElementById("copilot-slide")
  const copilotCopyBtn = document.getElementById("copilot-copy-btn")
  let copilotFeatureOn = false
  let copilotCopyText = ""

  function setCopilotEmpty() {
    copilotBodyEl.hidden = true
    copilotEmptyEl.hidden = false
    const key = copilotFeatureOn ? "copilot.emptyOn" : "copilot.emptyOff"
    copilotEmptyEl.dataset.i18n = key // stays right if the UI language changes
    copilotEmptyEl.textContent = t(key)
  }

  function setCopilotFeatureOn(on) {
    copilotFeatureOn = on
    setCopilotEmpty()
  }

  function renderCopilotSuggestions(payload) {
    if (!copilotFeatureOn || !payload) return
    const verses = Array.isArray(payload.relatedVerses) ? payload.relatedVerses : []
    copilotVersesEl.textContent = ""
    verses.forEach((verse) => {
      const row = document.createElement("div")
      row.className = "copilot-verse"
      const ref = document.createElement("div")
      ref.className = "copilot-verse-ref"
      ref.textContent = formatDisplayedReference(verse)
      const text = document.createElement("div")
      text.className = "copilot-verse-text"
      text.textContent = verse.text
      const show = document.createElement("button")
      show.type = "button"
      show.className = "btn-secondary btn-small"
      show.textContent = t("copilot.show")
      show.addEventListener("click", () => {
        const r = verse.reference
        sendJson({ id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: { book: r.book, chapter: r.chapter, verse: r.verse } })
      })
      row.append(ref, text, show)
      copilotVersesEl.appendChild(row)
    })
    copilotVersesSectionEl.hidden = verses.length === 0
    const point = payload.keyPoint
    copilotSlideEl.textContent = ""
    if (point) {
      copilotCaptionEl.textContent = point.caption
      point.slide.forEach((line) => {
        const li = document.createElement("li")
        li.textContent = line
        copilotSlideEl.appendChild(li)
      })
      copilotCopyText = [point.caption].concat(point.slide).join("\n")
    } else {
      copilotCopyText = ""
    }
    copilotPointSectionEl.hidden = !point
    copilotEmptyEl.hidden = true
    copilotBodyEl.hidden = false
  }

  copilotCopyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText(copilotCopyText)
      .then(() => log(t("copilot.copied"), "sent", { toast: true }))
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
  })
  // ARCHITECTURE.md section 128: which service runs the helpers (an explicit choice, never a silent switch).
  const aiProviderToggleEl = document.getElementById("ai-provider-toggle")
  function renderAiProvider(status) {
    setActiveOption(aiProviderToggleEl, "aiProvider", status.aiProvider || "")
    const hintKey = status.aiProvider ? "ai.noKey" : "ai.noProvider"
    aiNoKeyHintEl.dataset.i18n = hintKey // stays right if the UI language changes
    aiNoKeyHintEl.textContent = t(hintKey)
  }
  aiProviderToggleEl.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = button.dataset.aiProvider
      if (!asrStatus || provider === asrStatus.aiProvider) return
      aiProviderToggleEl.querySelectorAll("button").forEach((b) => (b.disabled = true))
      log(t("ai.provider.restarting"), "sent")
      window.churchOverlay
        .setAiProvider(provider)
        .then((status) => {
          aiProviderToggleEl.querySelectorAll("button").forEach((b) => (b.disabled = false))
          renderAsrStatus(status)
          log(t("log.aiProviderChanged", { provider }), "sent")
        })
        .catch((err) => {
          aiProviderToggleEl.querySelectorAll("button").forEach((b) => (b.disabled = false))
          log(t("ai.toggleFailed", { error: err.message }), "error")
          renderAsrStatus(asrStatus)
        })
    })
  })
  function renderAiAvailability(hasKey) {
    aiNoKeyHintEl.hidden = Boolean(hasKey)
    aiFeatureToggleEls.forEach((groupEl) => {
      groupEl.querySelectorAll("button").forEach((button) => {
        button.disabled = !hasKey
      })
    })
  }

  function renderAsrStatus(status) {
    asrStatus = status || null
    if (!asrStatus) return
    renderAiAvailability(asrStatus.aiReady)
    renderAiProvider(asrStatus)
    const both = asrStatus.hasGroq && asrStatus.hasDeepgram
    setActiveOption(asrStrategyToggleEl, "asrStrategy", asrStatus.strategy)
    asrStrategyToggleEl.querySelectorAll("button").forEach((button) => {
      button.disabled = !both
    })
    asrStrategyNoteEl.textContent = both ? "" : t("asrSettings.needsBothKeys")
    let provider
    if (!asrStatus.hasDeepgram) provider = t("asrSettings.providerGroq")
    else if (!asrStatus.hasGroq) provider = t("asrSettings.providerDeepgram")
    else provider = asrStatus.strategy === "streaming-first" ? t("asrSettings.providerStreamingFirst") : t("asrSettings.providerBatchFirst")
    if (asrStatus.localActive) provider += t("asrSettings.plusOffline")
    asrProviderLineEl.textContent = provider
    statusbarAsrTextEl.textContent = provider
  }
  asrStrategyToggleEl.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const strategy = button.dataset.asrStrategy
      if (!asrStatus || strategy === asrStatus.strategy) return
      asrStrategyToggleEl.querySelectorAll("button").forEach((b) => (b.disabled = true))
      asrStrategyNoteEl.textContent = t("asrSettings.restarting")
      window.churchOverlay
        .setAsrStrategy(strategy)
        .then((status) => {
          renderAsrStatus(status)
          log(t("log.asrStrategyChanged", { strategy }), "sent")
        })
        .catch((err) => {
          asrStrategyNoteEl.textContent = err.message
          renderAsrStatus(asrStatus)
        })
    })
  })

  let nearMissHideTimer = null
  const NEAR_MISS_DISPLAY_MS = 6000
  function showNearMiss(text) {
    if (!nearMissIndicatorEl || !text) return
    nearMissIndicatorEl.textContent = t("mic.nearMiss", { text })
    nearMissIndicatorEl.style.display = "block"
    if (nearMissHideTimer) clearTimeout(nearMissHideTimer)
    nearMissHideTimer = setTimeout(() => {
      nearMissHideTimer = null
      nearMissIndicatorEl.style.display = "none"
    }, NEAR_MISS_DISPLAY_MS)
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
      '<svg class="icon media-tile-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
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
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M12 2v6.5M12 2 8 8.5h8L12 2Z"/><path d="M8.5 8.5 6 21l6-4 6 4-2.5-12.5"/>' +
    "</svg>"

  // ARCHITECTURE.md section 74 (production audit): an operator who
  // imported the wrong file, or named it wrong, needs a way to fix it
  // directly — not just prevented from repeating the mistake next time.
  const RENAME_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
    "</svg>"
  const DELETE_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/>' +
    "</svg>"

  // Library browsing state: per-view, in memory. Density alone is
  // remembered (a per-viewer convenience, same as the active view).
  let mediaFilterKind = "all"
  let mediaSearchQuery = ""
  let mediaSortMode = "library"
  const mediaSearchEl = document.getElementById("media-search")
  const mediaKindFilterEl = document.getElementById("media-kind-filter")
  const mediaSortEl = document.getElementById("media-sort")
  const mediaDensityEl = document.getElementById("media-density")
  const mediaCountEl = document.getElementById("media-count")

  function normalizeForSearch(text) {
    return String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  }

  function visibleCues() {
    const query = normalizeForSearch(mediaSearchQuery.trim())
    const cues = knownCues.filter(
      (cue) => (mediaFilterKind === "all" || cue.kind === mediaFilterKind) && (!query || normalizeForSearch(cue.title).includes(query))
    )
    if (mediaSortMode === "name") cues.sort((a, b) => a.title.localeCompare(b.title))
    else if (mediaSortMode === "kind") cues.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
    return cues
  }

  function renderMediaCounts() {
    const counts = { all: knownCues.length, image: 0, video: 0, audio: 0 }
    for (const cue of knownCues) counts[cue.kind] = (counts[cue.kind] || 0) + 1
    mediaKindFilterEl.querySelectorAll(".seg-count").forEach((el) => {
      el.textContent = String(counts[el.dataset.count] || 0)
    })
    mediaCountEl.textContent = t(knownCues.length === 1 ? "media.countOne" : "media.countMany", { count: knownCues.length })
  }

  function renderMediaGrid() {
    mediaGridEl.innerHTML = ""
    mediaGridEl.removeAttribute("aria-busy")
    renderMediaCounts()
    if (knownCues.length === 0) {
      const empty = document.createElement("div")
      empty.className = "media-empty"
      empty.innerHTML = mediaIconSvg("image")
      const text = document.createElement("div")
      text.textContent = t("media.empty")
      const cta = document.createElement("button")
      cta.type = "button"
      cta.className = "btn-pill"
      cta.textContent = t("media.importButton")
      cta.addEventListener("click", () => mediaImportBtn.click())
      const dropHint = document.createElement("div")
      dropHint.className = "media-empty-hint"
      dropHint.textContent = t("media.dropHint")
      empty.append(text, cta, dropHint)
      mediaGridEl.appendChild(empty)
      return
    }
    const cues = visibleCues()
    if (cues.length === 0) {
      const empty = document.createElement("div")
      empty.className = "media-empty"
      empty.textContent = t("media.noMatches")
      mediaGridEl.appendChild(empty)
      return
    }
    cues.forEach((cue, order) => {
      const isPoster = cue.id === principalPosterCueId
      const tile = document.createElement("div")
      tile.className = "media-tile kind-" + cue.kind + (cue.id === activeCueId ? " active" : "") + (isPoster ? " poster" : "")
      tile.style.setProperty("--stagger", String(Math.min(order, 12)))
      tile.title = cue.title
      tile.dataset.cueId = cue.id
      tile.innerHTML =
        '<div class="media-tile-frame">' + mediaThumbnailHtml(cue) + '<span class="media-kind-badge"></span></div>' +
        '<div class="media-tile-meta"><div class="media-tile-title"></div><div class="media-tile-sub"></div></div>'
      const frame = tile.querySelector(".media-tile-frame")
      frame.dataset.liveLabel = t("media.badge.live")
      frame.dataset.posterLabel = t("media.badge.poster")
      tile.querySelector(".media-kind-badge").textContent = t("media.kind." + cue.kind)
      tile.querySelector(".media-tile-title").textContent = cue.title
      tile.querySelector(".media-tile-sub").textContent = cue.autoClearMs
        ? t("media.autoClearsAfter", { minutes: Math.round(cue.autoClearMs / 60000) })
        : t("media.clickToShow")
      tile.setAttribute("aria-label", cue.title)
      // Muted, local hover preview of a video's motion. It plays only in
      // this tile; nothing is sent until the tile is clicked.
      const video = tile.querySelector("video")
      if (video) {
        tile.addEventListener("mouseenter", () => video.play().catch(() => {}))
        tile.addEventListener("mouseleave", () => {
          video.pause()
          video.currentTime = 0
        })
      }
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
          // Read at click time: updateMediaGridState() flips the poster in
          // place without rebuilding tiles, so a value captured at render
          // time would be stale.
          if (cue.id === principalPosterCueId) {
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
      tile.querySelector(".media-tile-frame").appendChild(tileActions)
      const posterBtnEl = tile.querySelector(".media-tile-poster-btn")
      if (posterBtnEl) tile.querySelector(".media-tile-frame").appendChild(posterBtnEl)
      tile.querySelector(".media-tile-meta").appendChild(timer)

      mediaGridEl.appendChild(tile)
    })
  }

  mediaSearchEl.addEventListener("input", () => {
    mediaSearchQuery = mediaSearchEl.value
    renderMediaGrid()
  })
  wireOptionGroup(mediaKindFilterEl, "filter", (kind) => {
    mediaFilterKind = kind
    renderMediaGrid()
  })
  mediaSortEl.addEventListener("change", () => {
    mediaSortMode = mediaSortEl.value
    renderMediaGrid()
  })
  function applyMediaDensity(value) {
    mediaGridEl.style.setProperty("--tile-min", value + "px")
  }
  mediaDensityEl.addEventListener("input", () => {
    applyMediaDensity(mediaDensityEl.value)
    try {
      localStorage.setItem("churchOverlay.mediaDensity", mediaDensityEl.value)
    } catch {
      // Blocked storage: density still applies for this session.
    }
  })
  try {
    const saved = localStorage.getItem("churchOverlay.mediaDensity")
    if (saved) mediaDensityEl.value = saved
  } catch {
    // Blocked storage: keep the default density.
  }
  applyMediaDensity(mediaDensityEl.value)

  /**
   * Active/poster changes arrive on every verse-adjacent media event. They only
   * flip a class and a tooltip, so they must not tear down and rebuild every
   * tile (thumbnails, inputs with half-typed values, focus). The full
   * renderMediaGrid() stays for changes to the cue list itself.
   */
  function updateMediaGridState() {
    for (const tile of mediaGridEl.querySelectorAll(".media-tile")) {
      const id = tile.dataset.cueId
      const isPoster = id === principalPosterCueId
      tile.classList.toggle("active", id === activeCueId)
      tile.classList.toggle("poster", isPoster)
      const btn = tile.querySelector(".media-tile-poster-btn")
      if (!btn) continue
      const cue = knownCues.find((c) => c.id === id)
      if (!cue) continue
      btn.classList.toggle("active", isPoster)
      btn.title = isPoster ? t("media.posterUnsetTooltip", { title: cue.title }) : t("media.posterSetTooltip", { title: cue.title })
      btn.setAttribute("aria-label", btn.title)
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
      '<svg class="icon chip-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
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
  // One timeline row: number, kind icon, summary, kind label. Shared by the
  // live running order and the builder's draft so both read the same way.
  function buildSceneRow(scene, index) {
    const row = document.createElement("div")
    row.className = "scene-row"
    row.setAttribute("role", "listitem")
    const num = document.createElement("span")
    num.className = "scene-num"
    num.textContent = String(index + 1).padStart(2, "0")
    const icon = document.createElement("span")
    icon.className = "scene-icon scene-icon-" + scene.kind
    icon.innerHTML = sceneIconSvg(scene.kind)
    const text = document.createElement("span")
    text.className = "scene-text"
    const title = document.createElement("span")
    title.className = "scene-title"
    title.textContent = sceneSummary(scene)
    const kind = document.createElement("span")
    kind.className = "scene-kind"
    kind.textContent = t("rundown.builder.kind." + scene.kind)
    text.append(title, kind)
    row.append(num, icon, text)
    return row
  }

  function renderSlot(titleEl, kindEl, scene) {
    titleEl.textContent = scene ? sceneSummary(scene) : "—"
    kindEl.innerHTML = ""
    if (!scene) return
    kindEl.innerHTML = sceneIconSvg(scene.kind)
    const label = document.createElement("span")
    label.textContent = t("rundown.builder.kind." + scene.kind)
    kindEl.appendChild(label)
  }

  // The currently-active rundown: Now/Next slots, progress, and the
  // running order (click-to-jump via scene:goto). Everything here is
  // derived from the last rundown:state; nothing is predicted locally.
  function renderRundownSceneList() {
    rundownSceneListEl.innerHTML = ""
    const nowEl = document.getElementById("rundown-now")
    if (!currentRundownState) {
      const empty = document.createElement("div")
      empty.className = "rundown-empty"
      empty.textContent = t("rundown.empty")
      rundownSceneListEl.appendChild(empty)
      rundownPrevBtn.disabled = true
      rundownNextBtn.disabled = true
      renderSlot(document.getElementById("rundown-now-title"), document.getElementById("rundown-now-kind"), null)
      renderSlot(document.getElementById("rundown-next-title"), document.getElementById("rundown-next-kind"), null)
      document.getElementById("rundown-now-index").textContent = ""
      document.getElementById("rundown-progress-text").textContent = t("rundown.empty")
      document.getElementById("rundown-progress-bar").style.transform = "scaleX(0)"
      nowEl.classList.remove("live", "interrupted")
      return
    }
    rundownPrevBtn.disabled = false
    rundownNextBtn.disabled = false

    const knowsFullList = loadedRundownId === currentRundownState.rundownId && loadedRundownScenes.length > 0
    const scenes = knowsFullList ? loadedRundownScenes : [currentRundownState.scene]
    const activeIndex = knowsFullList ? currentRundownState.cursor : 0
    const interrupted = currentRundownState.interrupted

    renderSlot(document.getElementById("rundown-now-title"), document.getElementById("rundown-now-kind"), currentRundownState.scene)
    renderSlot(
      document.getElementById("rundown-next-title"),
      document.getElementById("rundown-next-kind"),
      knowsFullList ? scenes[activeIndex + 1] || null : null
    )
    nowEl.classList.toggle("live", !interrupted)
    nowEl.classList.toggle("interrupted", interrupted)
    nowEl.title = interrupted ? t("rundown.interruptedHint") : ""
    if (knowsFullList) {
      document.getElementById("rundown-now-index").textContent = activeIndex + 1 + " / " + scenes.length
      document.getElementById("rundown-progress-text").textContent = t("rundown.progress", {
        current: activeIndex + 1,
        total: scenes.length,
      })
      document.getElementById("rundown-progress-bar").style.transform = "scaleX(" + (activeIndex + 1) / scenes.length + ")"
    } else {
      // Loaded elsewhere (another dashboard, or before this one connected):
      // the position is known, the length is not, so say only that.
      document.getElementById("rundown-now-index").textContent = "#" + (currentRundownState.cursor + 1)
      document.getElementById("rundown-progress-text").textContent = t("rundown.progressUnknown", {
        current: currentRundownState.cursor + 1,
      })
      document.getElementById("rundown-progress-bar").style.transform = "scaleX(0)"
    }

    scenes.forEach((scene, index) => {
      const row = buildSceneRow(scene, knowsFullList ? index : currentRundownState.cursor)
      const isActive = index === activeIndex
      if (index < activeIndex) row.classList.add("done")
      if (isActive) row.classList.add(interrupted ? "interrupted" : "active")
      if (index === activeIndex + 1) row.classList.add("next")
      if (isActive && interrupted) row.title = t("rundown.interruptedHint")
      row.setAttribute("aria-label", sceneSummary(scene))
      if (isActive) row.setAttribute("aria-current", "step")
      makeInteractive(row, () => {
        const target = knowsFullList ? index : currentRundownState.cursor
        sendJson({ id: crypto.randomUUID(), type: "scene:goto", timestamp: Date.now(), payload: { index: target } })
        log(t("log.sentSceneGoto", { index: target }), "sent")
      })
      rundownSceneListEl.appendChild(row)
    })
    const activeRow = rundownSceneListEl.querySelector(".active, .interrupted")
    if (activeRow && viewEls.rundown.classList.contains("active")) activeRow.scrollIntoView({ block: "nearest" })
  }

  function moveDraftScene(from, to) {
    if (to < 0 || to >= draftScenes.length || from === to) return
    const [scene] = draftScenes.splice(from, 1)
    draftScenes.splice(to, 0, scene)
    renderDraftSceneList()
  }

  function draftActionButton(label, iconSvg, onClick, extraClass) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "scene-action" + (extraClass ? " " + extraClass : "")
    btn.innerHTML = iconSvg
    btn.title = label
    btn.setAttribute("aria-label", label)
    btn.addEventListener("click", (event) => {
      event.stopPropagation()
      onClick()
    })
    return btn
  }

  // Draft rows reorder by drag and drop, with the arrow buttons kept for
  // keyboard users. The draft is dashboard-only until "Load rundown".
  let draggedDraftIndex = null
  function renderDraftSceneList() {
    rundownDraftListEl.innerHTML = ""
    const countEl = document.getElementById("rundown-draft-count")
    countEl.textContent = draftScenes.length ? String(draftScenes.length) : ""
    if (draftScenes.length === 0) {
      const empty = document.createElement("div")
      empty.className = "rundown-empty"
      empty.textContent = t("rundown.builder.draftEmpty")
      rundownDraftListEl.appendChild(empty)
      return
    }
    draftScenes.forEach((scene, index) => {
      const row = buildSceneRow(scene, index)
      row.classList.add("draft")
      row.draggable = true
      row.addEventListener("dragstart", (event) => {
        draggedDraftIndex = index
        row.classList.add("dragging")
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", String(index))
      })
      row.addEventListener("dragend", () => {
        draggedDraftIndex = null
        row.classList.remove("dragging")
        rundownDraftListEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"))
      })
      row.addEventListener("dragover", (event) => {
        if (draggedDraftIndex === null) return
        event.preventDefault()
        const rect = row.getBoundingClientRect()
        const after = event.clientY > rect.top + rect.height / 2
        row.classList.toggle("drop-after", after)
        row.classList.toggle("drop-before", !after)
      })
      row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"))
      row.addEventListener("drop", (event) => {
        event.preventDefault()
        if (draggedDraftIndex === null) return
        const after = row.classList.contains("drop-after")
        let to = index + (after ? 1 : 0)
        if (draggedDraftIndex < to) to -= 1
        moveDraftScene(draggedDraftIndex, to)
      })

      const actions = document.createElement("span")
      actions.className = "scene-actions"
      actions.append(
        draftActionButton(t("rundown.builder.moveUp"), ICONS.arrowUp, () => moveDraftScene(index, index - 1)),
        draftActionButton(t("rundown.builder.moveDown"), ICONS.arrowDown, () => moveDraftScene(index, index + 1)),
        draftActionButton(t("rundown.builder.duplicateScene"), ICONS.duplicate, () => {
          draftScenes.splice(index + 1, 0, JSON.parse(JSON.stringify(scene)))
          renderDraftSceneList()
        }),
        draftActionButton(t("rundown.builder.removeScene"), ICONS.close, () => {
          draftScenes.splice(index, 1)
          renderDraftSceneList()
        }, "scene-action-danger")
      )
      row.appendChild(actions)
      rundownDraftListEl.appendChild(row)
    })
  }

  // "From recent verses": the same session list the Live view recalls from.
  // Adding one only puts its reference into the draft; the verse is looked
  // up and validated by the server when the scene actually goes live.
  function renderRundownRecentChips() {
    const el = document.getElementById("rundown-recent-chips")
    el.innerHTML = ""
    if (recentVerses.length === 0) {
      const empty = document.createElement("span")
      empty.className = "recent-empty"
      empty.textContent = t("rundown.builder.noRecent")
      el.appendChild(empty)
      return
    }
    for (const entry of recentVerses) {
      const chip = document.createElement("button")
      chip.type = "button"
      chip.className = "recent-chip"
      const plus = document.createElement("span")
      plus.className = "recent-chip-key"
      plus.innerHTML = ICONS.plus
      const label = document.createElement("span")
      label.textContent = entry.label
      chip.append(plus, label)
      chip.addEventListener("click", () => {
        draftScenes.push({ kind: "verse", reference: { ...entry.reference } })
        renderDraftSceneList()
      })
      el.appendChild(chip)
    }
  }

  rundownBuilderToggleBtn.addEventListener("click", () => {
    const isHidden = rundownBuilderEl.style.display === "none"
    rundownBuilderEl.style.display = isHidden ? "block" : "none"
    if (isHidden) {
      renderRundownRecentChips()
      renderDraftSceneList()
      rundownBuilderEl.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    setBuilderToggleLabel(isHidden ? "rundown.buildButtonClose" : "rundown.buildButton")
  })

  // The toggle carries an icon, so only its label span changes; the
  // data-i18n key moves with it so a language switch keeps the right text.
  function setBuilderToggleLabel(key) {
    const label = document.getElementById("rundown-builder-toggle-label")
    label.dataset.i18n = key
    label.textContent = t(key)
    rundownBuilderToggleBtn.classList.toggle("is-open", key === "rundown.buildButtonClose")
  }

  function updateRundownBuilderFieldsVisibility() {
    rundownFieldVerseEl.style.display = draftSelectedKind === "verse" ? "block" : "none"
    rundownFieldMediaEl.style.display = draftSelectedKind === "media" ? "block" : "none"
    rundownFieldAnnouncementEl.style.display = draftSelectedKind === "announcement" ? "block" : "none"
    rundownFieldCanvasEl.style.display = draftSelectedKind === "canvas" ? "block" : "none"
  }

  rundownVerseInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      rundownAddSceneBtn.click()
    }
  })

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
    setBuilderToggleLabel("rundown.buildButton")
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
    // A drop of several files is named one at a time: closing the dialog
    // (confirmed or cancelled) moves on to the next queued file.
    if (dropQueue.length > 0) setTimeout(processNextDroppedFile, 120)
    else dropQueueTotal = 0
  }

  // ---- Drag-and-drop import (ARCHITECTURE.md section 112) ------------------
  // The renderer never reads a dropped file's path or bytes: each File goes
  // to the preload, which resolves the path and hands it to the main
  // process. From there it is the same pending-import -> title -> copy flow
  // as the Import button. Bounded queue (AGENTS.md section 36).
  const MAX_DROPPED_FILES = 20
  const dropOverlayEl = document.getElementById("drop-overlay")
  let dropQueue = []
  let dropQueueTotal = 0
  let dragDepth = 0

  function dragHasFiles(event) {
    return Boolean(event.dataTransfer) && Array.from(event.dataTransfer.types || []).includes("Files")
  }

  function processNextDroppedFile() {
    const file = dropQueue.shift()
    if (!file) {
      dropQueueTotal = 0
      return
    }
    const position = dropQueueTotal - dropQueue.length
    window.churchOverlay
      .importDroppedMedia(file)
      .then((result) => {
        if (result.error) {
          log(t("log.importFailed", { error: file.name + " — " + result.error }), "error")
          processNextDroppedFile()
          return
        }
        showMediaTitleModal("import", result.suggestedTitle)
        if (dropQueueTotal > 1) {
          mediaTitleModalHeadingEl.textContent =
            t("media.titleModal.heading") + " " + t("media.drop.progress", { current: position, total: dropQueueTotal })
        }
      })
      .catch((err) => {
        log(t("log.importFailed", { error: err.message }), "error")
        processNextDroppedFile()
      })
  }

  function setDropOverlay(visible) {
    dropOverlayEl.classList.toggle("visible", visible)
  }

  // Always cancel the browser default for file drags: an unhandled drop
  // would navigate the whole dashboard to the file.
  document.addEventListener("dragenter", (event) => {
    if (!dragHasFiles(event) || appShellEl.style.display === "none") return
    event.preventDefault()
    dragDepth += 1
    setDropOverlay(true)
  })
  document.addEventListener("dragover", (event) => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = appShellEl.style.display === "none" ? "none" : "copy"
  })
  document.addEventListener("dragleave", (event) => {
    if (!dragHasFiles(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDropOverlay(false)
  })
  document.addEventListener("drop", (event) => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    dragDepth = 0
    setDropOverlay(false)
    if (appShellEl.style.display === "none") return
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length === 0) return
    if (mediaTitleModalEl.style.display !== "none" || dropQueue.length > 0) {
      log(t("media.drop.busy"), "error")
      return
    }
    if (files.length > MAX_DROPPED_FILES) {
      log(t("media.drop.tooMany", { max: MAX_DROPPED_FILES, count: files.length }), "error")
    }
    showView("media")
    dropQueue = files.slice(0, MAX_DROPPED_FILES)
    dropQueueTotal = dropQueue.length
    processNextDroppedFile()
  })

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
    // Unicode letters so "Gen\u00e8se 1:1" and multi-word names ("Song of Solomon 2:1") parse; the server re-validates.
    // Quick entry: "jn 3 16", "1co 13 4", "gen 1:1" all work. The chapter and verse are
    // separated by a space, colon, dot or comma; the book may be a shortcut (the server
    // resolves it, see apps/server/detector/quick-book.ts).
    const match = /^\s*((?:[123]\s*)?\p{L}[\p{L}.'\u2019 ]*?)\s*(\d{1,3})(?:\s+|\s*[:.,]\s*)(\d{1,3})\s*$/u.exec(text)
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

  referenceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      showBtn.click()
    }
  })

  showBtn.addEventListener("click", () => {
    const reference = parseReference(referenceInput.value)
    if (!reference) {
      document.getElementById("reference-field").classList.add("invalid")
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

  function releaseMic() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      audioContext.close().catch(() => {})
      audioContext = null
    }
  }

  async function startMic() {
    // Disable at once: a double click used to open two streams.
    if (micStartBtn.disabled) return
    micStartBtn.disabled = true
    try {
      // ARCHITECTURE.md section 8.3's recommended baseline.
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      log(t("log.micPermissionDenied", { error: err.message }), "error")
      micStartBtn.disabled = false
      return
    }

    let source
    let workletNode
    try {
      // Requesting the canonical sample rate directly lets the browser
      // handle resampling from the device's native rate (ARCHITECTURE.md
      // section 8.1) — this codebase does not implement its own resampler.
      audioContext = new AudioContext({ sampleRate: CANONICAL_SAMPLE_RATE })
      await audioContext.audioWorklet.addModule("./pcm-worklet-processor.js")
      source = audioContext.createMediaStreamSource(mediaStream)
      workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor")
    } catch (err) {
      // Any failure after getUserMedia used to leave the microphone open and
      // the start button dead; release everything and let the operator retry.
      releaseMic()
      micStartBtn.disabled = false
      log(t("log.micPermissionDenied", { error: err.message }), "error")
      return
    }

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

    // Send mic:start command so the backend ASR and calibration initialize before first audio frame
    sendJson({ id: crypto.randomUUID(), type: "mic:start", timestamp: Date.now(), payload: null })
    source.connect(workletNode)

    micStartBtn.disabled = true
    micStopBtn.disabled = false
    micVisualEl.classList.add("active")
    log(t("log.micStarted"), "sent")
  }

  async function stopMic() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      await audioContext.close().catch(() => {})
      audioContext = null
    }
    sendJson({ id: crypto.randomUUID(), type: "mic:stop", timestamp: Date.now(), payload: null })

    micStartBtn.disabled = false
    micStopBtn.disabled = true
    micVisualEl.classList.remove("active")
    micCalibratingStatusEl.style.display = "none"
    resetMicLevel()
    renderMicHealth(null)
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
      log(t("log.disconnectedRetrying", { seconds: delaySeconds }), "error", { toast: false })
      setTimeout(() => connect(port, token), delay)
    })
    ws.addEventListener("error", () => log(t("log.connectionError"), "error", { toast: false }))
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
      // High-frequency telemetry would bury real events in the log.
      if (message.type !== "mic:health" && message.type !== "transcript:partial") {
        log(t("log.received", { type: message.type }), "received")
      }

      if (message.type === "transcript:partial" || message.type === "transcript:final") {
        // ARCHITECTURE.md section 70: the operator needs to see what was
        // actually heard, continuously, to judge transcription accuracy
        // and latency — this field always reflects the raw ASR output,
        // never something else (like verse text) overwriting it.
        const text = message.payload && message.payload.text
        if (text) {
          transcriptEl.textContent = text
          // A new final sentence invalidates the previous translation until its own arrives.
          if (message.type === "transcript:final") {
            lastFinalTranscriptId = message.payload.id
            transcriptTranslationEl.hidden = true
          }
          // Language badge (EN/FR) so the operator sees which voice was heard,
          // e.g. an English preacher and a French interpreter. Hidden when unsure.
          const lang = message.payload.language
          transcriptLangEl.hidden = lang !== "en" && lang !== "fr"
          if (!transcriptLangEl.hidden) transcriptLangEl.textContent = lang.toUpperCase()
        }
      } else if (message.type === "verse:show") {
        showLiveVerse()
        const ref = message.payload && message.payload.reference
        onScreen.verse = ref ? formatDisplayedReference(message.payload) : "…"
        if (ref) {
          rememberRecentVerse(message.payload)
          lastShownReference = { book: ref.book, chapter: ref.chapter, verse: ref.verse }
        }
        renderTally()
      } else if (message.type === "verse:clear") {
        onScreen.verse = null
        renderTally()
      } else if (message.type === "announcement:show" || message.type === "announcement:clear") {
        onScreen.announcement = message.type === "announcement:show"
        renderTally()
      } else if (message.type === "canvas:show" || message.type === "canvas:clear") {
        onScreen.canvas = message.type === "canvas:show"
        renderTally()
      } else if (message.type === "mic:health") {
        renderMicHealth(message.payload)
      } else if (message.type === "media:show") {
        activeCueId = message.payload.cue.id
        updateMediaGridState()
        updateNowPlayingBar(message.payload.cue, message.payload.playback)
        onScreen.media = message.payload.cue.title
        renderTally()
      } else if (message.type === "media:clear") {
        activeCueId = null
        updateMediaGridState()
        updateNowPlayingBar(null, null)
        onScreen.media = null
        renderTally()
      } else if (message.type === "poster:show") {
        principalPosterCueId = message.payload.cue.id
        updateMediaGridState()
      } else if (message.type === "poster:clear") {
        principalPosterCueId = null
        updateMediaGridState()
      } else if (message.type === "rundown:state") {
        currentRundownState = message.payload
        renderRundownSceneList()
      } else if (message.type === "status:update") {
        handleStatusUpdate(message.payload)
      } else if (message.type === "translation:final") {
        // Display-only FR<->EN translation (optional Anthropic helper); ignore stale ones.
        const p = message.payload
        if (p && p.id === lastFinalTranscriptId && typeof p.text === "string") {
          transcriptTranslationEl.textContent = p.to.toUpperCase() + " · " + p.text
          transcriptTranslationEl.hidden = false
        }
      } else if (message.type === "verse:pending") {
        showPendingVerse(message.payload)
      } else if (message.type === "copilot:suggestions") {
        renderCopilotSuggestions(message.payload)
      } else if (message.type === "sermonNotes:update") {
        appendSermonNote(message.payload.notes)
      } else if (message.type === "verse:preview-result") {
        showPreviewResult(message.payload)
      } else if (message.type === "detector:near-miss") {
        showNearMiss(message.payload && message.payload.text)
      }
    })
  }

  // ---- Recent verses (session-only quick recall) --------------------------
  // In-memory, this dashboard session only; the persistent cross-restart
  // record is the History view. Recalling sends an ordinary verse:override,
  // so the server validates and looks it up like a typed reference — this
  // never re-displays cached text on its own (AGENTS.md sections 14, 50).
  const MAX_RECENT_VERSES = 9
  const recentVersesEl = document.getElementById("recent-verses")
  let recentVerses = [] // [{ key, label, reference: { book, chapter, verse } }], newest first

  function rememberRecentVerse(verse) {
    const ref = verse.reference
    const reference = { book: ref.book, chapter: ref.chapter, verse: ref.verse }
    const key = referenceKey(reference)
    recentVerses = [{ key, label: formatDisplayedReference(verse), reference }]
      .concat(recentVerses.filter((entry) => entry.key !== key))
      .slice(0, MAX_RECENT_VERSES)
  }

  function recallRecentVerse(index) {
    const entry = recentVerses[index]
    if (!entry) return
    sendJson({ id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: entry.reference })
    log(t("log.sentVerseOverride", { reference: JSON.stringify(entry.reference) }), "sent")
  }

  function renderRecentVerses() {
    if (!recentVersesEl) return
    recentVersesEl.innerHTML = ""
    if (recentVerses.length === 0) {
      const empty = document.createElement("span")
      empty.className = "recent-empty"
      empty.textContent = t("recent.empty")
      recentVersesEl.appendChild(empty)
      return
    }
    recentVerses.forEach((entry, index) => {
      const chip = document.createElement("button")
      chip.type = "button"
      chip.className = "recent-chip" + (onScreen.verse === entry.label ? " live" : "")
      if (onScreen.verse === entry.label) chip.setAttribute("aria-current", "true")
      chip.title = t("recent.recallHint", { reference: entry.label, key: String(index + 1) })
      const num = document.createElement("span")
      num.className = "recent-chip-key"
      num.textContent = String(index + 1)
      const label = document.createElement("span")
      label.textContent = entry.label
      chip.append(num, label)
      chip.addEventListener("click", () => recallRecentVerse(index))
      recentVersesEl.appendChild(chip)
    })
  }

  // ---- Header clock and on-air timer ---------------------------------------
  const headerClockEl = document.getElementById("header-clock")
  const onAirTimerEl = document.getElementById("on-air-timer")
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
  }
  function renderClocks() {
    const now = new Date()
    headerClockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    onAirTimerEl.textContent = onAirSince === null ? "" : formatElapsed(now.getTime() - onAirSince)
  }
  setInterval(renderClocks, 1000)

  // ---- Keyboard shortcuts ---------------------------------------------------
  // Every shortcut triggers the same button/handler a click would, so no
  // shortcut is a second command path. Ctrl+M is avoided on purpose: the
  // default Electron menu binds it to Minimize.
  const shortcutsModalEl = document.getElementById("shortcuts-modal")
  const shortcutsBtn = document.getElementById("shortcuts-btn")
  const shortcutsCloseBtn = document.getElementById("shortcuts-close-btn")
  const VIEW_ORDER = ["live", "rundown", "media", "overlay", "history", "settings"]

  function openShortcuts() {
    shortcutsModalEl.style.display = "flex"
    shortcutsCloseBtn.focus()
  }
  function closeShortcuts() {
    shortcutsModalEl.style.display = "none"
  }
  shortcutsBtn.addEventListener("click", openShortcuts)
  shortcutsCloseBtn.addEventListener("click", closeShortcuts)
  shortcutsModalEl.addEventListener("click", (event) => {
    if (event.target === shortcutsModalEl) closeShortcuts()
  })

  function isTypingTarget(el) {
    if (!el) return false
    const tag = el.tagName
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable
  }

  function anyModalOpen() {
    return Array.from(document.querySelectorAll(".modal-overlay")).some((el) => el.style.display !== "none")
  }

  // Modal accessibility, shared by every .modal-overlay: focus moves into the
  // dialog when it opens and returns to the opener when it closes, Tab stays
  // inside it, and Escape triggers its own cancel/close button (so each
  // dialog's own cleanup still runs).
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  const modalOpeners = new WeakMap()
  function openModalEl() {
    return Array.from(document.querySelectorAll(".modal-overlay")).find((el) => el.style.display !== "none") || null
  }
  const modalObserver = new MutationObserver((records) => {
    for (const record of records) {
      const el = record.target
      const open = el.style.display !== "none"
      if (open && !modalOpeners.has(el)) {
        modalOpeners.set(el, document.activeElement)
        const first = el.querySelector("[autofocus], input, " + FOCUSABLE)
        if (first && !el.contains(document.activeElement)) first.focus()
      } else if (!open && modalOpeners.has(el)) {
        const opener = modalOpeners.get(el)
        modalOpeners.delete(el)
        if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus()
      }
    }
  })
  document.querySelectorAll(".modal-overlay").forEach((el) => modalObserver.observe(el, { attributes: true, attributeFilter: ["style"] }))
  document.addEventListener(
    "keydown",
    (event) => {
      const modal = openModalEl()
      if (!modal) return
      if (event.key === "Escape") {
        const cancel = modal.querySelector('[id$="cancel-btn"], [id$="close-btn"]')
        if (cancel) {
          event.preventDefault()
          event.stopPropagation()
          cancel.click()
        }
      } else if (event.key === "Tab") {
        const items = Array.from(modal.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null)
        if (items.length === 0) return
        const firstItem = items[0]
        const lastItem = items[items.length - 1]
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault()
          lastItem.focus()
        } else if (!event.shiftKey && (document.activeElement === lastItem || !modal.contains(document.activeElement))) {
          event.preventDefault()
          firstItem.focus()
        }
      }
    },
    true,
  )

  // ---- Command palette (Ctrl+Shift+P) -------------------------------------
  // Every action here just activates the control the operator could click, so
  // the palette can never do something the UI would not (same validation, same
  // disabled states). Matching ignores case and accents ("francais" finds
  // "français").
  const paletteModalEl = document.getElementById("palette-modal")
  const paletteInputEl = document.getElementById("palette-input")
  const paletteListEl = document.getElementById("palette-list")
  let paletteItems = []
  let paletteIndex = 0

  function foldText(text) {
    return String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  }

  function clickIf(el) {
    if (el && !el.disabled) el.click()
  }

  function buildPaletteActions() {
    const actions = []
    for (const view of VIEW_ORDER) {
      const label = document.querySelector("#nav-" + view + " span")
      actions.push({
        label: t("palette.goto", { view: label ? label.textContent.trim() : view }),
        hint: "Ctrl+" + (VIEW_ORDER.indexOf(view) + 1),
        run: () => showView(view),
      })
    }
    actions.push(
      { label: t("palette.micStart"), hint: "Ctrl+Shift+M", run: () => clickIf(micStartBtn) },
      { label: t("palette.micStop"), hint: "Ctrl+Shift+M", run: () => clickIf(micStopBtn) },
      { label: t("palette.clear"), hint: "Shift+Esc", run: () => clickIf(clearBtn) },
      { label: t("palette.nextScene"), hint: "PgDn", run: () => clickIf(rundownNextBtn) },
      { label: t("palette.prevScene"), hint: "PgUp", run: () => clickIf(rundownPrevBtn) },
      { label: t("palette.modeEnglish"), run: () => clickIf(displayModeToggleEl.querySelector('[data-mode="english"]')) },
      { label: t("palette.modeFrench"), run: () => clickIf(displayModeToggleEl.querySelector('[data-mode="french"]')) },
      { label: t("palette.modeBilingual"), run: () => clickIf(displayModeToggleEl.querySelector('[data-mode="bilingual"]')) },
      { label: t("palette.confirmAuto"), run: () => clickIf(verseConfirmationToggleEl.querySelector('[data-confirmation-mode="auto"]')) },
      { label: t("palette.confirmReview"), run: () => clickIf(verseConfirmationToggleEl.querySelector('[data-confirmation-mode="review"]')) },
      { label: t("palette.shortcuts"), hint: "?", run: () => openShortcuts() },
      { label: t("palette.voiceCommands"), run: () => clickIf(voiceCommandsBtn) },
    )
    return actions
  }

  function renderPalette() {
    const query = foldText(paletteInputEl.value.trim())
    const all = buildPaletteActions()
    paletteItems = query ? all.filter((a) => foldText(a.label).includes(query)) : all
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))
    paletteListEl.textContent = ""
    if (paletteItems.length === 0) {
      const empty = document.createElement("li")
      empty.className = "palette-empty"
      empty.textContent = t("palette.empty")
      paletteListEl.appendChild(empty)
      paletteInputEl.removeAttribute("aria-activedescendant")
      return
    }
    paletteItems.forEach((item, i) => {
      const li = document.createElement("li")
      li.id = "palette-item-" + i
      li.setAttribute("role", "option")
      li.setAttribute("aria-selected", String(i === paletteIndex))
      li.className = "palette-item" + (i === paletteIndex ? " active" : "")
      const text = document.createElement("span")
      text.textContent = item.label
      li.appendChild(text)
      if (item.hint) {
        const kbd = document.createElement("kbd")
        kbd.textContent = item.hint
        li.appendChild(kbd)
      }
      li.addEventListener("mousemove", () => {
        if (paletteIndex !== i) {
          paletteIndex = i
          renderPalette()
        }
      })
      li.addEventListener("click", () => runPaletteItem(i))
      paletteListEl.appendChild(li)
    })
    paletteInputEl.setAttribute("aria-activedescendant", "palette-item-" + paletteIndex)
    const active = document.getElementById("palette-item-" + paletteIndex)
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" })
  }

  function openPalette() {
    paletteInputEl.value = ""
    paletteIndex = 0
    paletteModalEl.style.display = "flex"
    renderPalette()
    paletteInputEl.focus()
  }

  function closePalette() {
    paletteModalEl.style.display = "none"
  }

  function runPaletteItem(index) {
    const item = paletteItems[index]
    if (!item) return
    closePalette()
    // After the modal closes so focus restoration cannot steal focus from the action.
    setTimeout(item.run, 0)
  }

  paletteInputEl.addEventListener("input", () => {
    paletteIndex = 0
    renderPalette()
  })
  paletteInputEl.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (paletteItems.length === 0) return
      const step = event.key === "ArrowDown" ? 1 : -1
      paletteIndex = (paletteIndex + step + paletteItems.length) % paletteItems.length
      renderPalette()
    } else if (event.key === "Enter") {
      event.preventDefault()
      runPaletteItem(paletteIndex)
    } else if (event.key === "Escape") {
      event.preventDefault()
      closePalette()
    }
  })
  paletteModalEl.addEventListener("click", (event) => {
    if (event.target === paletteModalEl) closePalette()
  })
  document.getElementById("palette-btn").addEventListener("click", openPalette)
  window.addEventListener("churchoverlay:languagechange", () => {
    if (paletteModalEl.style.display !== "none") renderPalette()
  })

  function focusReferenceInput() {
    showView("live")
    referenceInput.focus()
    referenceInput.select()
  }

  document.addEventListener("keydown", (event) => {
    if (appShellEl.style.display === "none") return
    const typing = isTypingTarget(event.target)
    const ctrl = event.ctrlKey || event.metaKey
    const key = event.key

    if (key === "Escape" && shortcutsModalEl.style.display !== "none") {
      event.preventDefault()
      closeShortcuts()
      return
    }
    if (anyModalOpen()) return
    const inRundownView = viewEls.rundown.classList.contains("active")

    if (ctrl && event.shiftKey && key.toLowerCase() === "p") {
      event.preventDefault()
      openPalette()
    } else if (ctrl && !event.shiftKey && key.toLowerCase() === "k") {
      event.preventDefault()
      focusReferenceInput()
    } else if (!typing && !ctrl && key === "/") {
      event.preventDefault()
      focusReferenceInput()
    } else if (ctrl && key === "Enter" && !event.repeat && versePendingBannerEl.style.display !== "none") {
      // A held key must not confirm twice.
      event.preventDefault()
      versePendingConfirmBtn.click()
    } else if (event.shiftKey && key === "Escape") {
      event.preventDefault()
      clearBtn.click()
    } else if (ctrl && event.shiftKey && key.toLowerCase() === "m") {
      event.preventDefault()
      if (!micStartBtn.disabled) micStartBtn.click()
      else if (!micStopBtn.disabled) micStopBtn.click()
    } else if (event.altKey && !ctrl && /^Digit[1-9]$/.test(event.code)) {
      event.preventDefault()
      recallRecentVerse(Number(event.code.slice(5)) - 1)
    } else if (event.altKey && !ctrl && !event.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      event.preventDefault()
      if (!event.repeat) stepVerse(key === "ArrowRight" ? 1 : -1)
    } else if (ctrl && !event.shiftKey && !event.altKey && /^(Digit|Numpad)[1-6]$/.test(event.code)) {
      // event.code, not key: on a French AZERTY keyboard the digit row types
      // "&", "\u00e9", ... unless Shift is held, so key never matched there.
      event.preventDefault()
      showView(VIEW_ORDER[Number(event.code.slice(-1)) - 1])
    } else if (inRundownView && !typing && !ctrl && !event.altKey && (key === "PageDown" || key === "PageUp")) {
      // Presentation clickers send PageDown/PageUp. Only while the Rundown
      // view is showing: scrolling Settings or History with PageDown must
      // never put the next scene on the congregation screen.
      const btn = key === "PageDown" ? rundownNextBtn : rundownPrevBtn
      if (!btn.disabled) {
        event.preventDefault()
        btn.click()
      }
    } else if (!typing && key === "?") {
      event.preventDefault()
      openShortcuts()
    } else if (typing && key === "Escape" && event.target === referenceInput) {
      referenceInput.blur()
    }
  })

  // Live validity hint on the reference field, using the same parser the
  // Show button uses — the server remains the authority on whether it exists.
  const referenceFieldEl = document.getElementById("reference-field")
  referenceInput.addEventListener("input", () => {
    const value = referenceInput.value.trim()
    referenceFieldEl.classList.toggle("valid", value !== "" && parseReference(value) !== null)
    referenceFieldEl.classList.remove("invalid")
    schedulePreview(value)
  })

  // ---- Typed-reference preview (ARCHITECTURE.md section 131) --------------
  // Operator-only look-ahead: shows what the typed reference would display,
  // under the box, labelled "not on screen". It never touches the overlay;
  // the server answers through the same validation as a real verse.
  const PREVIEW_DEBOUNCE_MS = 250
  const previewEl = document.getElementById("reference-preview")
  const previewRefEl = document.getElementById("reference-preview-ref")
  const previewTextEl = document.getElementById("reference-preview-text")
  let previewTimer = null
  let previewSeq = 0

  function hidePreview() {
    previewEl.hidden = true
    previewRefEl.textContent = ""
    previewTextEl.textContent = ""
  }

  function schedulePreview(value) {
    clearTimeout(previewTimer)
    // Any newer keystroke invalidates answers still in flight.
    previewSeq += 1
    const reference = value === "" ? null : parseReference(value)
    if (!reference) {
      hidePreview()
      return
    }
    const seq = previewSeq
    previewTimer = setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ id: crypto.randomUUID(), type: "verse:preview", timestamp: Date.now(), payload: { seq, reference } }))
    }, PREVIEW_DEBOUNCE_MS)
  }

  function showPreviewResult(payload) {
    // Only the newest answer is shown.
    if (!payload || payload.seq !== previewSeq) return
    previewEl.hidden = false
    if (payload.verse) {
      previewRefEl.textContent = formatDisplayedReference(payload.verse)
      previewTextEl.textContent = payload.verse.text
    } else {
      previewRefEl.textContent = ""
      previewTextEl.textContent = t("preview.notFound")
    }
  }

  // Alt+Left / Alt+Right: one verse back/forward from the last verse shown.
  // An ordinary verse:override, so the server validates it; past the end of a
  // chapter nothing is shown (no rollover to the next chapter).
  let lastShownReference = null
  function stepVerse(delta) {
    if (!lastShownReference) return
    const verse = lastShownReference.verse + delta
    if (verse < 1) return
    const reference = { book: lastShownReference.book, chapter: lastShownReference.chapter, verse }
    sendJson({ id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: reference })
    log(t("log.sentVerseOverride", { reference: JSON.stringify(reference) }), "sent")
  }

  // renderTally() also re-renders the recent-verse chips, and re-applies the
  // tally texts that applyTranslations() would otherwise reset to "off air".
  window.addEventListener("churchoverlay:languagechange", () => renderTally())

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
      const on = button.dataset.view === target
      button.classList.toggle("active", on)
      if (on) button.setAttribute("aria-current", "page")
      else button.removeAttribute("aria-current")
    })
    // Lazy views (Overlay, History) initialise from this, whichever way the
    // operator got here: sidebar, Ctrl+digit, or the view restored at launch.
    window.dispatchEvent(new CustomEvent("churchoverlay:viewchange", { detail: { view: target } }))
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

  let historyRenderToken = 0
  function renderHistoryView() {
    // A fast double open used to append every row twice when both fetches resolved.
    const token = ++historyRenderToken
    historySummaryEl.textContent = t("history.loading")
    historyMostShownEl.innerHTML = ""
    historyRecentServicesEl.innerHTML = ""
    // Loading placeholders, replaced as soon as the history arrives.
    for (const list of [historyMostShownEl, historyRecentServicesEl]) {
      for (let i = 0; i < 4; i++) {
        const placeholder = document.createElement("div")
        placeholder.className = "skeleton skeleton-row"
        placeholder.setAttribute("aria-hidden", "true")
        list.appendChild(placeholder)
      }
    }

    window.churchOverlay
      .getSessionHistory()
      .then((entries) => {
        if (token !== historyRenderToken) return
        historyMostShownEl.innerHTML = ""
        historyRecentServicesEl.innerHTML = ""
        if (entries.length === 0) {
          historySummaryEl.textContent = t("history.empty")
          for (const list of [historyMostShownEl, historyRecentServicesEl]) {
            const empty = document.createElement("p")
            empty.className = "history-empty"
            empty.textContent = t("history.emptyColumn")
            list.appendChild(empty)
          }
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
        if (token === historyRenderToken) {
          historyMostShownEl.innerHTML = ""
          historyRecentServicesEl.innerHTML = ""
        }
        log(t("log.historyLoadFailed", { error: err.message }), "error")
      })
  }

  window.addEventListener("churchoverlay:viewchange", (event) => {
    if (event.detail.view === "history") renderHistoryView()
  })

  function showSetupScreen() {
    appShellEl.style.display = "none"
    setupScreenEl.style.display = "flex"
  }

  // ARCHITECTURE.md section 65.6: the phone remote's own panel — one of
  // three states (disabled / enabled with a link / enabled but no LAN
  // address was found), never all three at once.
  function renderRemotePanel(remoteUrl, enabled) {
    allowPhoneRemoteEnabled = Boolean(enabled)
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
    remoteToggleBtn.disabled = false
    remoteToggleBtn.textContent = t(allowPhoneRemoteEnabled ? "remote.disable" : "remote.enable")
  }

  // ARCHITECTURE.md section 65.6's amendment: unlike NDI/sermon-notes,
  // flipping this requires tearing down and rebuilding AppCore (the WS
  // server's listen host is fixed at construction), a real interruption —
  // so unlike those toggles, this one confirms with the operator first,
  // and warns specifically about the network-exposure consequence when
  // turning it ON (nothing new when turning it off).
  remoteToggleBtn.addEventListener("click", () => {
    const enabling = !allowPhoneRemoteEnabled
    if (!window.confirm(t(enabling ? "remote.confirmEnable" : "remote.confirmDisable"))) return
    remoteToggleBtn.disabled = true
    window.churchOverlay
      .setAllowPhoneRemote(enabling)
      .then((info) => renderRemotePanel(info.remoteUrl, info.allowPhoneRemote))
      .catch((err) => {
        log(err.message, "error")
        remoteToggleBtn.disabled = false
      })
  })

  remoteCopyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText(remoteUrlInput.value)
      .then(() => log(t("log.remoteLinkCopied"), "sent", { toast: true }))
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
  //
  // The preview is a SECOND copy of the overlay page running beside the real
  // one (OBS / the audience window). If it also played the cue's audio, every
  // video/song would sound twice a few ms apart: an echo, and worse when the
  // same laptop feeds the mixer and listens to it. `muted=1` keeps the
  // preview silent; only the real output plays sound.
  function renderOverlayPreview(overlayUrl) {
    if (!overlayUrl) return
    const previewUrl = new URL(overlayUrl)
    previewUrl.searchParams.set("muted", "1")
    if (overlayPreviewFrameEl.src !== previewUrl.href) {
      overlayPreviewFrameEl.src = previewUrl.href
    }
  }

  obsCopyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText(obsUrlInput.value)
      .then(() => log(t("log.obsLinkCopied"), "sent", { toast: true }))
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
          log(t("log.sessionExported", { count: result.count, targetDir: result.targetDir }), "received", { toast: true })
        }
      })
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
      .finally(() => {
        exportSessionBtn.disabled = false
        exportSessionBtn.textContent = t("session.exportButton")
      })
  })

  exportRehearsalBtn.addEventListener("click", () => {
    exportRehearsalBtn.disabled = true
    exportRehearsalBtn.textContent = t("session.exporting")
    window.churchOverlay
      .exportRehearsal()
      .then((result) => {
        if (result.canceled) return
        if (result.error) {
          log(result.error, "error")
        } else {
          log(t("log.rehearsalExported", { count: result.count, targetDir: result.targetDir }), "received", { toast: true })
        }
      })
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
      .finally(() => {
        exportRehearsalBtn.disabled = false
        exportRehearsalBtn.textContent = t("session.exportRehearsalButton")
      })
  })

  exportDiagnosticsBtn.addEventListener("click", () => {
    exportDiagnosticsBtn.disabled = true
    window.churchOverlay
      .exportDiagnostics()
      .then((result) => {
        if (!result.canceled) log(t("log.diagnosticsExported", { path: result.path }), "received", { toast: true })
      })
      .catch((err) => log(err.message, "error"))
      .finally(() => {
        exportDiagnosticsBtn.disabled = false
      })
  })

  // ARCHITECTURE.md section 93: a strictly one-shot, operator-triggered
  // digest — reads the already-rendered sermon-notes feed text directly
  // (oldest first, since the feed itself prepends newest-first) rather
  // than keeping a second parallel buffer of the same content.
  function collectSermonNotesText() {
    return [...sermonNotesFeedEl.querySelectorAll(".sermon-notes-text")]
      .reverse()
      .map((el) => el.textContent)
      .join("\n")
  }

  generateServiceSummaryBtn.addEventListener("click", () => {
    generateServiceSummaryBtn.disabled = true
    generateServiceSummaryBtn.textContent = t("serviceSummary.generating")
    serviceSummaryResultEl.style.display = "none"
    window.churchOverlay
      .generateServiceSummary(collectSermonNotesText())
      .then((result) => {
        if (result.error) {
          log(t("serviceSummary.error", { error: result.error }), "error")
          return
        }
        serviceSummaryResultEl.textContent = result.summary
        serviceSummaryResultEl.style.display = "block"
      })
      .catch((err) => log(t("serviceSummary.error", { error: err.message }), "error"))
      .finally(() => {
        generateServiceSummaryBtn.disabled = false
        generateServiceSummaryBtn.textContent = t("serviceSummary.button")
      })
  })

  // ARCHITECTURE.md section 126: recap (FR + EN), AI-selected quote cards, notes export. All AI text
  // goes through textContent; the export itself is a main-process folder dialog.
  const generateServiceExtrasBtn = document.getElementById("generate-service-extras-btn")
  const serviceExtrasResultEl = document.getElementById("service-extras-result")
  const serviceExtrasFrEl = document.getElementById("service-extras-fr")
  const serviceExtrasEnEl = document.getElementById("service-extras-en")
  const serviceExtrasCardsEl = document.getElementById("service-extras-cards")
  const exportServiceExtrasBtn = document.getElementById("export-service-extras-btn")

  function renderServiceExtras(extras) {
    serviceExtrasFrEl.textContent = extras.recap.fr
    serviceExtrasEnEl.textContent = extras.recap.en
    serviceExtrasCardsEl.textContent = ""
    if (extras.cards.length === 0) {
      const li = document.createElement("li")
      li.textContent = t("serviceExtras.noCards")
      serviceExtrasCardsEl.appendChild(li)
    }
    extras.cards.forEach((card) => {
      const li = document.createElement("li")
      li.textContent = (card.kind === "note" ? t("serviceExtras.noteLabel") : card.label) + ": " + card.text
      serviceExtrasCardsEl.appendChild(li)
    })
    serviceExtrasResultEl.style.display = "block"
  }

  generateServiceExtrasBtn.addEventListener("click", () => {
    generateServiceExtrasBtn.disabled = true
    generateServiceExtrasBtn.textContent = t("serviceExtras.generating")
    serviceExtrasResultEl.style.display = "none"
    window.churchOverlay
      .generateServiceExtras(collectSermonNotesText())
      .then((result) => {
        if (result.error) {
          log(t("serviceExtras.error", { error: result.error }), "error")
          return
        }
        renderServiceExtras(result.extras)
      })
      .catch((err) => log(t("serviceExtras.error", { error: err.message }), "error"))
      .finally(() => {
        generateServiceExtrasBtn.disabled = false
        generateServiceExtrasBtn.textContent = t("serviceExtras.button")
      })
  })

  exportServiceExtrasBtn.addEventListener("click", () => {
    exportServiceExtrasBtn.disabled = true
    window.churchOverlay
      .exportServiceExtras()
      .then((result) => {
        if (result.canceled) return
        if (result.error) {
          log(t("serviceExtras.exportFailed", { error: result.error }), "error")
          return
        }
        log(t("serviceExtras.exported", { count: result.count, dir: result.targetDir }), "sent", { toast: true })
      })
      .catch((err) => log(t("serviceExtras.exportFailed", { error: err.message }), "error"))
      .finally(() => {
        exportServiceExtrasBtn.disabled = false
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
        groupEl.querySelectorAll("button").forEach((b) => {
          b.classList.remove("active")
          b.setAttribute("aria-pressed", "false")
        })
        button.classList.add("active")
        button.setAttribute("aria-pressed", "true")
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
  aiFeatureToggleEls.forEach((groupEl) => {
    wireOptionGroup(groupEl, "aiEnabled", (value) => {
      if (groupEl.dataset.aiFeature === "sermonCopilot") setCopilotFeatureOn(value === "on")
      window.churchOverlay
        .setAiFeature(groupEl.dataset.aiFeature, value === "on")
        .then((result) => {
          if (result && result.persisted === false) log(t("ai.toggleNotSaved"), "error")
        })
        .catch((err) => log(t("ai.toggleFailed", { error: err.message }), "error"))
    })
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
  wireOptionGroup(frenchTranslationToggleEl, "translation", (translation) => {
    window.churchOverlay
      .setFrenchTranslation(translation)
      .catch((err) => log(t("log.importFailed", { error: err.message }), "error"))
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
      const on = button.dataset[datasetKey] === value
      button.classList.toggle("active", on)
      button.setAttribute("aria-pressed", String(on))
    })
  }

  setupAccentColorResetBtn.addEventListener("click", () => {
    setupAccentColorEl.value = DEFAULT_ACCENT_COLOR
  })

  setupSaveBtn.addEventListener("click", () => {
    const apiKey = setupKeyInput.value.trim()
    const deepgramApiKey = setupDeepgramKeyInput.value.trim()
    if (!apiKey && !deepgramApiKey) {
      setSetupError(t("setup.enterKeyError"))
      return
    }
    setSetupError("")
    setupSaveBtn.disabled = true
    setupSaveBtn.textContent = t("setup.saving")

    window.churchOverlay
      .completeSetup(
        apiKey,
        deepgramApiKey,
        setupSelectedMode,
        setupSelectedUiLanguage,
        setupAllowPhoneRemoteEl.checked,
        setupAudioProfileEl.value,
        setupOrganizationNameEl.value.trim(),
        setupAccentColorEl.value,
        setupAnthropicKeyInput.value.trim()
      )
      .then((info) => {
        setActiveOption(displayModeToggleEl, "mode", setupSelectedMode)
        setActiveOption(uiLanguageToggleEl, "lang", setupSelectedUiLanguage)
        setActiveOption(verseConfirmationToggleEl, "confirmationMode", info.verseConfirmationMode || "auto")
        setActiveOption(sermonNotesToggleEl, "notesEnabled", info.enableSermonNotes ? "on" : "off")
        setActiveOption(verseLayoutToggleEl, "layout", info.verseLayout || "fullscreen")
        setActiveOption(frenchTranslationToggleEl, "translation", info.frenchTranslation || "ls1910")
        renderRemotePanel(info.remoteUrl, info.allowPhoneRemote)
        renderObsPanel(info.overlayUrl)
        renderOverlayPreview(info.overlayUrl)
        setMediaOrigin(info.overlayUrl)
        renderNdiStatus(info.ndi)
        applyBranding(info.organizationName, info.accentColor)
        renderTally()
        renderMicHealth(null)
        window.churchOverlay.getStartupStatus().then((status) => {
          renderAsrStatus(status.asr)
          renderAiFeatures(status.aiFeatures)
        }).catch(() => {})
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
        setActiveOption(frenchTranslationToggleEl, "translation", status.frenchTranslation || "ls1910")
        renderRemotePanel(status.remoteUrl, status.allowPhoneRemote)
        renderObsPanel(status.overlayUrl)
        renderOverlayPreview(status.overlayUrl)
        setMediaOrigin(status.overlayUrl)
        renderNdiStatus(status.ndi)
        applyBranding(status.organizationName, status.accentColor)
        renderAsrStatus(status.asr)
        renderAiFeatures(status.aiFeatures)
        refreshLocalAsr()
        renderTally()
        renderMicHealth(null)
        showAppShell()
        connect(status.port, status.token)
      } else {
        if (status.organizationName) setupOrganizationNameEl.value = status.organizationName
        if (status.accentColor) setupAccentColorEl.value = status.accentColor
        showSetupScreen()
      }
    })
    .catch((err) => {
      showSetupScreen()
      setSetupError("Could not check startup status: " + err.message)
    })
})()
