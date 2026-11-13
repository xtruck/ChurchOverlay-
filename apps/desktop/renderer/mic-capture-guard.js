// Pure, DOM-free helpers for the dashboard's microphone capture (audit B2 /
// SF-02). Plain browser JS like audio-stream.js (no build step), loaded before
// dashboard.js, unit-tested by running the source in a vm context.
//
// The old capture code set "mic active" the moment getUserMedia resolved and
// never looked again: an unplugged USB mic, a track the OS ended, a context
// suspended by sleep, or a device that delivered nothing all kept saying
// "listening" while the service ran deaf. This module holds the decisions:
//   - classifyMicError: WHY acquiring the microphone failed (different advice
//     for permission, missing device, device busy, constraints).
//   - createMicWatchdog: an explicit state machine; "live" only while audio
//     frames are really flowing.
//   - createRecoveryPolicy: bounded, backed-off re-acquire attempts.
// dashboard.js owns the DOM, the timers and the MediaStream/AudioContext.
;(function () {
  // How long (ms) without a frame before capture counts as lost. The worklet
  // delivers a block every ~8 ms, so this is generous and still quick.
  const DEFAULT_NO_FRAME_MS = 3000
  // Grace after start for the first frame (worklet module load, device warm-up).
  const DEFAULT_STARTUP_GRACE_MS = 5000
  // Frames that are ALL digital zero for this long: a muted or dead device
  // (a live room mic always has some noise floor).
  const DEFAULT_SILENT_MS = 20000

  const ERROR_KINDS = Object.freeze({
    "permission-denied": { retryable: false },
    "not-found": { retryable: true },
    "in-use": { retryable: true },
    overconstrained: { retryable: false },
    other: { retryable: true },
  })

  /**
   * Maps a getUserMedia / AudioContext failure to a stable kind. The caller
   * turns kind into an operator message ("mic.error." + kind in i18n.js).
   */
  function classifyMicError(error) {
    const name = error && typeof error.name === "string" ? error.name : ""
    let kind = "other"
    switch (name) {
      case "NotAllowedError":
      case "SecurityError":
      case "PermissionDeniedError":
        kind = "permission-denied"
        break
      case "NotFoundError":
      case "DevicesNotFoundError":
        kind = "not-found"
        break
      case "NotReadableError":
      case "TrackStartError":
      case "AbortError":
        kind = "in-use"
        break
      case "OverconstrainedError":
      case "ConstraintNotSatisfiedError":
        kind = "overconstrained"
        break
      default:
        kind = "other"
    }
    return { kind, retryable: ERROR_KINDS[kind].retryable, name }
  }

  /**
   * Capture health. States:
   *   idle       not capturing (never started / operator stopped)
   *   starting   capturing was started, first frame not seen yet (inside the grace)
   *   live       frames are flowing                       <- the only "listening" state
   *   muted      the track is muted (OS/hardware mute); frames are silence
   *   suspended  the AudioContext is suspended/interrupted (sleep, OS policy)
   *   no-frames  no audio frames for too long: device lost or capture stalled
   *   ended      the track ended (device unplugged / revoked) or the context closed
   *   silent     frames arrive but are digital zero for a long time
   * recoveryAction() says what the caller may try for the current state.
   */
  function createMicWatchdog(options) {
    const noFrameMs = (options && options.noFrameMs) || DEFAULT_NO_FRAME_MS
    const startupGraceMs = (options && options.startupGraceMs) || DEFAULT_STARTUP_GRACE_MS
    const silentMs = (options && options.silentMs) || DEFAULT_SILENT_MS

    let active = false
    let startedAt = 0
    let lastFrameAt = null
    let lastActivityAt = 0
    let trackEnded = false
    let trackMuted = false
    let contextState = "running"
    let frames = 0

    function status(now) {
      if (!active) return "idle"
      if (trackEnded || contextState === "closed") return "ended"
      if (trackMuted) return "muted"
      if (contextState === "suspended" || contextState === "interrupted") return "suspended"
      if (lastFrameAt === null) return now - startedAt > startupGraceMs ? "no-frames" : "starting"
      if (now - lastFrameAt > noFrameMs) return "no-frames"
      if (now - lastActivityAt > silentMs) return "silent"
      return "live"
    }

    return Object.freeze({
      /** Begin watching a freshly acquired capture (resets per-capture flags, keeps nothing stale). */
      start(now) {
        active = true
        startedAt = now
        lastFrameAt = null
        lastActivityAt = now
        trackEnded = false
        trackMuted = false
        contextState = "running"
        frames = 0
      },
      stop() {
        active = false
      },
      /** One audio block arrived; peak is its largest absolute Int16 sample. */
      frame(peak, now) {
        if (!active) return
        frames++
        lastFrameAt = now
        if (peak > 0) lastActivityAt = now
      },
      trackEnded() {
        trackEnded = true
      },
      trackMuted(muted) {
        trackMuted = Boolean(muted)
      },
      contextState(state) {
        contextState = state
      },
      status,
      /** True only while audio is genuinely flowing. */
      isLive(now) {
        return status(now) === "live"
      },
      frameCount() {
        return frames
      },
      /**
       * "reacquire": drop the capture and open the device again.
       * "resume-context": audioContext.resume() is worth trying first.
       * "none": nothing the app can fix (muted, silent, idle, healthy).
       */
      recoveryAction(now) {
        switch (status(now)) {
          case "ended":
          case "no-frames":
            return "reacquire"
          case "suspended":
            return "resume-context"
          default:
            return "none"
        }
      },
    })
  }

  /**
   * Bounded re-acquire attempts with exponential backoff. After maxAttempts
   * without a stable live period the policy gives up and the operator must
   * act; a capture that stays live for stableMs earns the full budget back.
   */
  function createRecoveryPolicy(options) {
    const maxAttempts = (options && options.maxAttempts) || 5
    const baseDelayMs = (options && options.baseDelayMs) || 1000
    const maxDelayMs = (options && options.maxDelayMs) || 15000
    const stableMs = (options && options.stableMs) || 30000
    let attempts = 0
    let liveSince = null

    return Object.freeze({
      /** The next attempt: { retry, delayMs, attempt } or { retry: false, attempts }. */
      next() {
        if (attempts >= maxAttempts) return { retry: false, attempts }
        attempts++
        liveSince = null
        return { retry: true, attempt: attempts, delayMs: Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs) }
      },
      /** Call on every healthy observation; a long enough streak refills the budget. */
      noteLive(now) {
        if (liveSince === null) liveSince = now
        if (attempts > 0 && now - liveSince >= stableMs) attempts = 0
      },
      noteNotLive() {
        liveSince = null
      },
      /** The operator restarted capture by hand: start over. */
      reset() {
        attempts = 0
        liveSince = null
      },
      attempts() {
        return attempts
      },
      maxAttempts() {
        return maxAttempts
      },
    })
  }

  /** Largest absolute value in an Int16Array (cheap "is this block pure zero" check). */
  function peakInt16(samples) {
    let peak = 0
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i] < 0 ? -samples[i] : samples[i]
      if (value > peak) peak = value
    }
    return peak
  }

  globalThis.ChurchOverlayMicGuard = Object.freeze({
    classifyMicError,
    createMicWatchdog,
    createRecoveryPolicy,
    peakInt16,
    DEFAULT_NO_FRAME_MS,
    DEFAULT_STARTUP_GRACE_MS,
    DEFAULT_SILENT_MS,
  })
})()
