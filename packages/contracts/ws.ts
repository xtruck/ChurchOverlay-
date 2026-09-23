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

export type WsMessage<TPayload = unknown> = {
  id: string
  type: WsCommandType | WsEventType
  timestamp: number
  correlationId?: string
  sequence?: number
  payload: TPayload
}
