export type WsRole = "operator" | "viewer"

/** Requests to the application. See ARCHITECTURE.md §30 — keep this set small. */
export type WsCommandType =
  | "mic:start"
  | "mic:stop"
  | "verse:clear"
  | "verse:override"

/** Resulting state or information, consumed by the (read-only) overlay. */
export type WsEventType =
  | "status:update"
  | "transcript:partial"
  | "verse:show"
  | "verse:clear"

export type WsMessage<TPayload = unknown> = {
  id: string
  type: WsCommandType | WsEventType
  timestamp: number
  correlationId?: string
  sequence?: number
  payload: TPayload
}
