import type {
  AnnouncementShowPayload,
  AsrStatusPayload,
  DefinitionShowPayload,
  MediaCue,
  MediaShowPayload,
  Rundown,
  RundownScene,
  RundownStatePayload,
  TranscriptResult,
  VerseShowPayload,
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

function isVerseSecondaryPayload(
  payload: unknown
): payload is { text: string; translation: string; source: string } {
  if (!isPlainObject(payload)) return false
  return (
    typeof payload.text === "string" &&
    typeof payload.translation === "string" &&
    typeof payload.source === "string"
  )
}

const VERSE_TRIGGERS = ["detected", "override", "navigation", "rundown"] as const

/** The Verse shape alone, shared by isVersePayload (adds `trigger`) and isVersePendingPayload (adds nothing — a pending suggestion has no trigger yet, since it hasn't been shown). */
function isBareVersePayload(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) return false
  if (
    !(
      isVerseReferencePayload(payload.reference) &&
      typeof payload.text === "string" &&
      typeof payload.translation === "string" &&
      typeof payload.source === "string"
    )
  ) {
    return false
  }
  // secondary (ARCHITECTURE.md section 63.3): optional, bilingual mode only.
  return payload.secondary === undefined || isVerseSecondaryPayload(payload.secondary)
}

function isVersePayload(payload: unknown): payload is VerseShowPayload {
  return isBareVersePayload(payload) && (VERSE_TRIGGERS as readonly unknown[]).includes(payload.trigger)
}

/** ARCHITECTURE.md section 65.3: verse:pending's payload — a plain Verse, no trigger (it hasn't been shown yet). */
function isVersePendingPayload(payload: unknown): payload is Record<string, unknown> {
  return isBareVersePayload(payload)
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

// status:update now has a real producer: AppCore broadcasts ASR/
// transcription health (asrHealth: "ok"/"error") when GroqProvider's
// onError fires and again on the next successful transcript (the
// recovery signal) — previously only ever a server-side log line, with
// no way for the operator dashboard to know transcription had failed
// mid-service. Additional status signals (a circuit-breaker state,
// connection health) can still be added as further optional fields on
// AsrStatusPayload later without a breaking change, the same additive
// philosophy Verse.secondary already uses — this is not a closed enum of
// everything status:update will ever carry.
//
// transcript:partial is in a similar "not yet produced" position, for a different reason:
// GroqProvider (v1's only AsrProvider) never emits state: "partial" at
// all — see its own doc comment — because Groq's transcription API has no
// partial-result concept. isTranscriptPartialPayload below still requires
// state === "partial", so nothing may legitimately relabel a final
// transcript as one just to give the dashboard something to show; a
// dashboard.js handler for this event already exists and is harmless,
// forward-compatible dead code until a future AsrProvider (still within
// the fixed extension seam, ARCHITECTURE.md section 50) actually streams
// partials.
function isStatusUpdatePayload(payload: unknown): payload is AsrStatusPayload {
  if (!isPlainObject(payload)) return false
  return (
    (payload.asrHealth === "ok" || payload.asrHealth === "error") &&
    (payload.error === undefined || typeof payload.error === "string")
  )
}

function isMediaSelectPayload(payload: unknown): payload is { id: string } {
  return isPlainObject(payload) && isNonEmptyString(payload.id)
}

function isMediaSeekPayload(payload: unknown): payload is { positionMs: number } {
  return isPlainObject(payload) && isFiniteNumber(payload.positionMs) && payload.positionMs >= 0
}

function isMediaCuePayload(payload: unknown): payload is MediaCue {
  if (!isPlainObject(payload)) return false
  return (
    (payload.kind === "image" || payload.kind === "video" || payload.kind === "audio") &&
    isNonEmptyString(payload.id) &&
    isNonEmptyString(payload.title)
  )
}

function isMediaPlaybackStatePayload(
  payload: unknown
): payload is { state: "playing" | "paused"; positionMs: number; asOfServerTime: number } {
  if (!isPlainObject(payload)) return false
  return (
    (payload.state === "playing" || payload.state === "paused") &&
    isFiniteNumber(payload.positionMs) &&
    isFiniteNumber(payload.asOfServerTime)
  )
}

function isMediaShowPayload(payload: unknown): payload is MediaShowPayload {
  if (!isPlainObject(payload)) return false
  if (!isMediaCuePayload(payload.cue)) return false
  return payload.playback === undefined || isMediaPlaybackStatePayload(payload.playback)
}

// ARCHITECTURE.md section 64: Service Rundown & Scenes.

function isRundownScenePayload(payload: unknown): payload is RundownScene {
  if (!isPlainObject(payload)) return false
  switch (payload.kind) {
    case "verse":
      return isVerseReferencePayload(payload.reference)
    case "media":
      return isNonEmptyString(payload.mediaCueId)
    case "announcement":
      return typeof payload.title === "string" && typeof payload.body === "string"
    case "blank":
      return true
    default:
      return false
  }
}

function isRundownPayload(payload: unknown): payload is Rundown {
  if (!isPlainObject(payload)) return false
  return (
    isNonEmptyString(payload.id) &&
    isNonEmptyString(payload.title) &&
    Array.isArray(payload.scenes) &&
    payload.scenes.every(isRundownScenePayload)
  )
}

function isRundownLoadPayload(payload: unknown): payload is { rundown: Rundown } {
  return isPlainObject(payload) && isRundownPayload(payload.rundown)
}

function isSceneGotoPayload(payload: unknown): payload is { index: number } {
  return (
    isPlainObject(payload) &&
    isFiniteNumber(payload.index) &&
    Number.isInteger(payload.index) &&
    payload.index >= 0
  )
}

function isRundownStatePayload(payload: unknown): payload is RundownStatePayload {
  if (!isPlainObject(payload)) return false
  return (
    isNonEmptyString(payload.rundownId) &&
    isFiniteNumber(payload.cursor) &&
    isRundownScenePayload(payload.scene) &&
    typeof payload.interrupted === "boolean"
  )
}

function isAnnouncementShowPayload(payload: unknown): payload is AnnouncementShowPayload {
  return isPlainObject(payload) && typeof payload.title === "string" && typeof payload.body === "string"
}

function isDefinitionShowPayload(payload: unknown): payload is DefinitionShowPayload {
  return isPlainObject(payload) && typeof payload.term === "string" && typeof payload.definition === "string"
}

/**
 * The v1 action set from ARCHITECTURE.md section 30, plus the Phase 2
 * media actions approved and specified in section 60 (media:select/
 * play/pause/seek/clear/show) — an explicit, documented scope amendment
 * (section 59), not a silent addition (AGENTS.md section 19 still keeps
 * this registry small and purpose-built; every entry maps to a real,
 * approved feature requirement).
 *
 * "verse:clear" and "media:clear" are both a command (operator requests
 * a clear) and an event (the server confirms/broadcasts the clear to
 * viewers) — see packages/contracts/ws.ts. This registry validates each
 * as the inbound command case; the operator is the only role that ever
 * sends either.
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
  "verse:confirm-pending": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
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
  "verse:pending": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isVersePendingPayload,
  },
  "media:select": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isMediaSelectPayload,
  },
  "media:play": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "media:pause": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "media:seek": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isMediaSeekPayload,
  },
  "media:clear": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "media:show": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isMediaShowPayload,
  },
  "rundown:load": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isRundownLoadPayload,
  },
  "scene:next": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "scene:previous": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isNullPayload,
  },
  "scene:goto": {
    kind: "command",
    allowedSenders: ["operator"],
    validatePayload: isSceneGotoPayload,
  },
  "rundown:state": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isRundownStatePayload,
  },
  "announcement:show": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isAnnouncementShowPayload,
  },
  "announcement:clear": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isNullPayload,
  },
  "definition:show": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isDefinitionShowPayload,
  },
  "definition:clear": {
    kind: "event",
    allowedSenders: [],
    validatePayload: isNullPayload,
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
