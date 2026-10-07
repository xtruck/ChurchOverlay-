export type WsRole = "operator" | "viewer"

/** Requests to the application. See ARCHITECTURE.md §30 — keep this set small. */
export type WsCommandType =
  | "mic:start"
  | "mic:stop"
  | "verse:clear"
  | "verse:override"
  | "media:select"
  | "media:play"
  | "media:pause"
  | "media:seek"
  | "media:clear"
  | "media:set-duration"
  | "rundown:load"
  | "scene:next"
  | "scene:previous"
  | "scene:goto"
  | "verse:confirm-pending"
  | "poster:set"
  | "poster:clear"
  | "poster:set-duration"
  | "layout:set"
  | "asr:return-primary"
  | "mic:auto-gain"
  | "timer:start"
  | "timer:stop"
  | "timer:reset"
  | "stage:alert"
  | "stage:clear-alert"
  | "outline:show"
  | "outline:clear"

/** Resulting state or information, consumed by the (read-only) overlay. */
export type WsEventType =
  | "status:update"
  | "transcript:partial"
  | "transcript:final"
  | "verse:show"
  | "verse:clear"
  | "media:show"
  | "media:clear"
  | "announcement:show"
  | "announcement:clear"
  | "rundown:state"
  | "definition:show"
  | "definition:clear"
  | "verse:pending"
  | "sermonNotes:update"
  | "canvas:show"
  | "canvas:clear"
  | "poster:show"
  | "poster:clear"
  | "layout:update"
  | "detector:near-miss"
  | "translation:final"
  | "copilot:suggestions"
  | "branding:update"
  | "overlay:style"
  | "mic:health"
  | "timer:state"
  | "stage:alert"
  | "outline:show"
  | "outline:clear"

/**
 * status:update's first real, concrete payload shape — ASR/transcription
 * health, surfaced to the operator dashboard so an ASR failure mid-service
 * is visible rather than only ever a server-side log line. Not a rigid
 * enum-of-everything: future status signals (a circuit-breaker state,
 * connection health) can be added as additional optional fields without
 * breaking this one, the same additive philosophy Verse.secondary uses.
 */
export type AsrStatusPayload = {
  readonly asrHealth: "ok" | "error" | "throttled" | "rate-limited" | "failover"
  readonly error?: string
  /**
   * ARCHITECTURE.md section 76 (silence-gate auto-calibration): true for
   * the brief window right after mic:start while the gate measures this
   * room's ambient noise, before any real speech is being listened for
   * yet. micThreshold carries the resulting calibrated RMS value once
   * calibration finishes (micCalibrating: false) — additive fields, the
   * same philosophy Verse.secondary already uses, so an operator dashboard
   * that predates this still works unmodified against asrHealth alone.
   */
  readonly micCalibrating?: boolean
  readonly micThreshold?: number
  readonly audioMetrics?: {
    readonly framesReceived: number
    readonly framesRejected: number
    readonly framesForwarded: number
    readonly averageRms: number
    readonly maxRms: number
  }
}

/**
 * ARCHITECTURE.md section 91: the operator-facing surface for
 * AppCore's existing "detector.near-miss" server log (a final transcript
 * that contained chapter/verse keywords or a recognized book name but
 * validated to zero references) — previously invisible outside raw
 * server logs, so an operator watching the dashboard had no way to know a
 * spoken reference had just failed to resolve versus simply not being
 * spoken at all.
 */
export type DetectorNearMissPayload = {
  readonly text: string
}

/**
 * ARCHITECTURE.md section 94: the overlay-facing counterpart to section
 * 92's dashboard-only branding — sent once on every viewer connect (the
 * same "late-join sync" pattern layout:update already uses), never a
 * live-toggle command. Both fields optional/absent means "show nothing
 * extra" on the overlay — never a product-name default forced onto the
 * congregation-facing display (unlike the dashboard's own neutral
 * "ChurchOverlay" fallback, which is the operator's own UI chrome, not
 * something the congregation needs to see).
 */
export type BrandingUpdatePayload = {
  readonly organizationName?: string
  readonly accentColor?: string
  /**
   * ARCHITECTURE.md section 108 — which preset visual template the overlay
   * renders a verse with ("classic", "banner", "minimal", "elegant").
   * Absent means "classic" (the overlay's one and only look before this
   * existed), same optional/backward-compatible shape as
   * organizationName/accentColor above.
   */
  readonly overlayTemplate?: string
}

/**
 * Live microphone diagnosis (server/audio/mic-health.ts), broadcast about
 * once per second of processed audio while the mic is on. Levels are dBFS
 * (0 = full scale); null until there is something to measure.
 */
export type MicHealthPayload = {
  readonly state: "warming-up" | "ok" | "listening" | "too-quiet" | "clipping" | "noisy" | "no-signal"
  readonly speechDbfs: number | null
  readonly noiseDbfs: number | null
  readonly snrDb: number | null
  readonly peakDbfs: number | null
  readonly clippingRatio: number
  readonly gainDb: number
  readonly autoGain: boolean
}

/** mic:auto-gain — operator toggles the adaptive gain applied to audio sent to ASR. */
export type MicAutoGainPayload = {
  readonly enabled: boolean
}

export type TimerStartPayload = {
  readonly durationMinutes: number
  readonly title?: string
}

export type TimerStatePayload = {
  readonly running: boolean
  readonly remainingSeconds: number
  readonly totalSeconds: number
  readonly title?: string
  readonly isOvertime: boolean
}

export type StageAlertPayload = {
  readonly message: string
  readonly durationSeconds?: number
}

export type OutlineShowPayload = {
  readonly pointNumber: number
  readonly title: string
  readonly text?: string
}

export type WsMessage<TPayload = unknown> = {
  id: string
  type: WsCommandType | WsEventType
  timestamp: number
  correlationId?: string
  sequence?: number
  payload: TPayload
}
