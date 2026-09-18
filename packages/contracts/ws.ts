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
  | "rundown:load"
  | "scene:next"
  | "scene:previous"
  | "scene:goto"
  | "verse:confirm-pending"

/** Resulting state or information, consumed by the (read-only) overlay. */
export type WsEventType =
  | "status:update"
  | "transcript:partial"
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

/**
 * status:update's first real, concrete payload shape — ASR/transcription
 * health, surfaced to the operator dashboard so an ASR failure mid-service
 * is visible rather than only ever a server-side log line. Not a rigid
 * enum-of-everything: future status signals (a circuit-breaker state,
 * connection health) can be added as additional optional fields without
 * breaking this one, the same additive philosophy Verse.secondary uses.
 */
export type AsrStatusPayload = {
  readonly asrHealth: "ok" | "error"
  readonly error?: string
}

export type WsMessage<TPayload = unknown> = {
  id: string
  type: WsCommandType | WsEventType
  timestamp: number
  correlationId?: string
  sequence?: number
  payload: TPayload
}
