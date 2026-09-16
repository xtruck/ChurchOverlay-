import type {
  TranscriptResult,
  Verse,
  VerseReference,
  WsCommandType,
  WsEventType,
  WsMessage,
  WsRole,
} from "../../../packages/contracts"

/**
 * v1 WS Action Registry (ARCHITECTURE.md section 30, section 50 fourth
 * extension seam). The action set is deliberately small and fixed — do
 * not add a type here without an explicit product requirement
 * (ARCHITECTURE.md section 30, AGENTS.md section 19).
 *
 * This module validates message *shape* (schema + sender role) only, per
 * AGENTS.md section 17: every inbound message must be schema-validated
 * before any handler runs, and a malformed message must never crash the
 * server. It does not implement a real WebSocket server/connection layer,
 * actual handler business logic, or outbound broadcast helpers — those
 * depend on subsystems (audio capture, ASR, verse source) that do not
 * exist yet, and inventing them now would be scope creep.
 */

export type ActionKind = "command" | "event"

export type ActionDefinition<TPayload = unknown> = {
  readonly kind: ActionKind
  /** Which role(s) may send this type as an inbound message. Empty means
   * "server-originated only" — no client may ever send it inbound. */
  readonly allowedSenders: readonly WsRole[]
  readonly validatePayload: (payload: unknown) => payload is TPayload
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isNullPayload(payload: unknown): payload is null {
  return payload === null
}

function isVerseReferencePayload(payload: unknown): payload is VerseReference {
  if (!isPlainObject(payload)) return false
  return (
    isNonEmptyString(payload.book) &&
    isFiniteNumber(payload.chapter) &&
    isFiniteNumber(payload.verse)
  )
}

function isVersePayload(payload: unknown): payload is Verse {
  if (!isPlainObject(payload)) return false
  return (
    isVerseReferencePayload(payload.reference) &&
    typeof payload.text === "string" &&
    typeof payload.translation === "string" &&
    typeof payload.source === "string"
  )
}

function isTranscriptPartialPayload(payload: unknown): payload is TranscriptResult {
  if (!isPlainObject(payload)) return false
  return (
    isNonEmptyString(payload.id) &&
    isNonEmptyString(payload.correlationId) &&
    isFiniteNumber(payload.sequence) &&
    typeof payload.text === "string" &&
    payload.state === "partial" &&
    (payload.providerConfidence === undefined || isFiniteNumber(payload.providerConfidence)) &&
    isFiniteNumber(payload.timestamp)
  )
}

// status:update's payload shape is intentionally left unopinionated in v1:
// no component that produces or consumes it exists yet (no mic capture, no
// ASR, no connection-state tracker). Pinning down a rigid shape now would
// be inventing a requirement (AGENTS.md section 58) rather than
// implementing one. It is validated as "some plain object", which rejects
// garbage (arrays, primitives, null) without guessing at fields that have
// no real producer yet.
function isStatusUpdatePayload(payload: unknown): payload is Record<string, unknown> {
  return isPlainObject(payload)
}

/**
 * The v1 action set, exactly as listed in ARCHITECTURE.md section 30.
 * "verse:clear" is both a command (operator requests a clear) and an
 * event (the server confirms/broadcasts the clear to viewers) — see
 * packages/contracts/ws.ts. This registry validates it as the inbound
 * command case; the operator is the only role that ever sends it.
 */
export const ACTION_REGISTRY: Readonly<Record<WsCommandType | WsEventType, ActionDefinition>> = {
  "mic:start": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "mic:stop": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "verse:clear": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "verse:override": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isVerseReferencePayload,
  },
  "status:update": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isStatusUpdatePayload,
  },
  "transcript:partial": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isTranscriptPartialPayload,
  },
  "verse:show": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isVersePayload,
  },
}

export type WsRejection = {
  readonly ok: false
  readonly reason: string
}

export type WsAccepted = {
  readonly ok: true
  readonly message: WsMessage
}

export type WsValidationResult = WsAccepted | WsRejection

/**
 * Validates an inbound message's envelope, recognized type, sender-role
 * permission, and per-type payload schema. Never throws — a malformed
 * message must never crash the server (AGENTS.md section 17).
 *
 * Uses hasOwnProperty rather than `in` to look up the action type, so a
 * crafted `type` value like "constructor" or "__proto__" cannot resolve
 * through the prototype chain to something that isn't really a registered
 * action.
 */
export function validateWsMessage(raw: unknown, senderRole: WsRole): WsValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "message is not an object" }
  }
  if (!isNonEmptyString(raw.id)) {
    return { ok: false, reason: "message.id must be a non-empty string" }
  }
  if (
    !isNonEmptyString(raw.type) ||
    !Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, raw.type)
  ) {
    return { ok: false, reason: "message.type is not a recognized action" }
  }
  if (!isFiniteNumber(raw.timestamp)) {
    return { ok: false, reason: "message.timestamp must be a number" }
  }
  if (raw.correlationId !== undefined && !isNonEmptyString(raw.correlationId)) {
    return { ok: false, reason: "message.correlationId must be a non-empty string when present" }
  }
  if (
    raw.sequence !== undefined &&
    !(isFiniteNumber(raw.sequence) && Number.isInteger(raw.sequence) && raw.sequence >= 0)
  ) {
    return { ok: false, reason: "message.sequence must be a non-negative integer when present" }
  }

  const type = raw.type as WsCommandType | WsEventType
  const action = ACTION_REGISTRY[type]

  if (!action.allowedSenders.includes(senderRole)) {
    return { ok: false, reason: `role "${senderRole}" is not permitted to send "${type}"` }
  }
  if (!action.validatePayload(raw.payload)) {
    return { ok: false, reason: `message.payload does not match the schema for "${type}"` }
  }

  return {
    ok: true,
    message: {
      id: raw.id,
      type,
      timestamp: raw.timestamp,
      correlationId: raw.correlationId as string | undefined,
      sequence: raw.sequence as number | undefined,
      payload: raw.payload,
    },
  }
}
