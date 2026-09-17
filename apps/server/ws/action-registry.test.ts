import { test } from "node:test"
import assert from "node:assert/strict"
import { validateWsMessage, ACTION_REGISTRY } from "./action-registry"

test("ACTION_REGISTRY: contains exactly the seven v1 actions plus the Phase 2 media and rundown actions (ARCHITECTURE.md sections 30, 60, 64)", () => {
  assert.deepEqual(
    Object.keys(ACTION_REGISTRY).sort(),
    [
      "mic:start",
      "mic:stop",
      "status:update",
      "transcript:partial",
      "verse:clear",
      "verse:override",
      "verse:show",
      "media:select",
      "media:play",
      "media:pause",
      "media:seek",
      "media:clear",
      "media:show",
      "rundown:load",
      "scene:next",
      "scene:previous",
      "scene:goto",
      "rundown:state",
      "announcement:show",
      "announcement:clear",
    ].sort()
  )
})

test("validateWsMessage: accepts a valid mic:start command from an operator", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "mic:start", timestamp: 1700000000000, payload: null },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: accepts a valid verse:override command with a VerseReference payload", () => {
  const result = validateWsMessage(
    {
      id: "01ABC",
      type: "verse:override",
      timestamp: 1700000000000,
      payload: { book: "john", chapter: 3, verse: 16 },
    },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: accepts optional correlationId and sequence when valid", () => {
  const result = validateWsMessage(
    {
      id: "01ABC",
      type: "mic:start",
      timestamp: 1700000000000,
      correlationId: "01CORR",
      sequence: 0,
      payload: null,
    },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: rejects a viewer sending an operator-only command (role boundary)", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "mic:start", timestamp: 1700000000000, payload: null },
    "viewer"
  )
  assert.equal(result.ok, false)
})

test("validateWsMessage: rejects any inbound sender for a server-only event (verse:show)", () => {
  const asOperator = validateWsMessage(
    {
      id: "01ABC",
      type: "verse:show",
      timestamp: 1700000000000,
      payload: {
        reference: { book: "john", chapter: 3, verse: 16 },
        text: "For God so loved the world...",
        translation: "kjv",
        source: "free-api",
      },
    },
    "operator"
  )
  const asViewer = validateWsMessage(
    {
      id: "01ABC",
      type: "verse:show",
      timestamp: 1700000000000,
      payload: {
        reference: { book: "john", chapter: 3, verse: 16 },
        text: "For God so loved the world...",
        translation: "kjv",
        source: "free-api",
      },
    },
    "viewer"
  )
  assert.equal(asOperator.ok, false)
  assert.equal(asViewer.ok, false)
})

test("validateWsMessage: rejects an unrecognized type", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "verse:delete-everything", timestamp: 1700000000000, payload: null },
    "operator"
  )
  assert.equal(result.ok, false)
})

// Security-relevant: prototype-chain properties must never be treated as
// registered actions just because `someObject.constructor` etc. resolves
// via the prototype chain.
test("validateWsMessage: rejects prototype-pollution-style type strings", () => {
  for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const result = validateWsMessage(
      { id: "01ABC", type, timestamp: 1700000000000, payload: null },
      "operator"
    )
    assert.equal(result.ok, false, `type "${type}" must not validate`)
  }
})

test("validateWsMessage: rejects a message that is not an object, without throwing", () => {
  for (const raw of [null, undefined, "mic:start", 42, ["mic:start"]]) {
    assert.doesNotThrow(() => validateWsMessage(raw, "operator"))
    assert.equal(validateWsMessage(raw, "operator").ok, false)
  }
})

test("validateWsMessage: rejects a missing or empty id", () => {
  const missing = validateWsMessage(
    { type: "mic:start", timestamp: 1700000000000, payload: null },
    "operator"
  )
  const empty = validateWsMessage(
    { id: "", type: "mic:start", timestamp: 1700000000000, payload: null },
    "operator"
  )
  assert.equal(missing.ok, false)
  assert.equal(empty.ok, false)
})

test("validateWsMessage: rejects a non-numeric or missing timestamp", () => {
  const missing = validateWsMessage({ id: "01ABC", type: "mic:start", payload: null }, "operator")
  const wrongType = validateWsMessage(
    { id: "01ABC", type: "mic:start", timestamp: "not-a-number", payload: null },
    "operator"
  )
  assert.equal(missing.ok, false)
  assert.equal(wrongType.ok, false)
})

test("validateWsMessage: rejects an invalid sequence (negative, non-integer, wrong type)", () => {
  for (const sequence of [-1, 1.5, "1", Number.NaN]) {
    const result = validateWsMessage(
      { id: "01ABC", type: "mic:start", timestamp: 1700000000000, sequence, payload: null },
      "operator"
    )
    assert.equal(result.ok, false, `sequence ${String(sequence)} must be rejected`)
  }
})

test("validateWsMessage: rejects a verse:override payload missing required fields", () => {
  const missingVerse = validateWsMessage(
    {
      id: "01ABC",
      type: "verse:override",
      timestamp: 1700000000000,
      payload: { book: "john", chapter: 3 },
    },
    "operator"
  )
  const wrongTypes = validateWsMessage(
    {
      id: "01ABC",
      type: "verse:override",
      timestamp: 1700000000000,
      payload: { book: "john", chapter: "3", verse: 16 },
    },
    "operator"
  )
  assert.equal(missingVerse.ok, false)
  assert.equal(wrongTypes.ok, false)
})

test("validateWsMessage: rejects mic:start/mic:stop/verse:clear with a non-null payload", () => {
  for (const type of ["mic:start", "mic:stop", "verse:clear"]) {
    const result = validateWsMessage(
      { id: "01ABC", type, timestamp: 1700000000000, payload: {} },
      "operator"
    )
    assert.equal(result.ok, false, `${type} with a non-null payload must be rejected`)
  }
})

test("validateWsMessage: accepts a valid media:select command with an id", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "media:select", timestamp: 1700000000000, payload: { id: "01MEDIA" } },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: rejects media:select without a non-empty id", () => {
  for (const payload of [{}, { id: "" }, { id: 5 }, null]) {
    const result = validateWsMessage(
      { id: "01ABC", type: "media:select", timestamp: 1700000000000, payload },
      "operator"
    )
    assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} must be rejected`)
  }
})

test("validateWsMessage: rejects media:play/media:pause/media:clear with a non-null payload", () => {
  for (const type of ["media:play", "media:pause", "media:clear"]) {
    const result = validateWsMessage(
      { id: "01ABC", type, timestamp: 1700000000000, payload: {} },
      "operator"
    )
    assert.equal(result.ok, false, `${type} with a non-null payload must be rejected`)
  }
})

test("validateWsMessage: accepts a valid media:seek command with a non-negative positionMs", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "media:seek", timestamp: 1700000000000, payload: { positionMs: 1500 } },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: rejects media:seek with a negative or missing positionMs", () => {
  for (const payload of [{}, { positionMs: -1 }, { positionMs: "1500" }]) {
    const result = validateWsMessage(
      { id: "01ABC", type: "media:seek", timestamp: 1700000000000, payload },
      "operator"
    )
    assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} must be rejected`)
  }
})

test("validateWsMessage: rejects any inbound sender for the media:show/media:select/media:play/media:pause/media:seek/media:clear role boundaries", () => {
  const commands: Array<[string, unknown]> = [
    ["media:select", { id: "01MEDIA" }],
    ["media:play", null],
    ["media:pause", null],
    ["media:seek", { positionMs: 0 }],
    ["media:clear", null],
  ]
  for (const [type, payload] of commands) {
    const result = validateWsMessage(
      { id: "01ABC", type, timestamp: 1700000000000, payload },
      "viewer"
    )
    assert.equal(result.ok, false, `viewer sending ${type} must be rejected`)
  }
  const showResult = validateWsMessage(
    {
      id: "01ABC",
      type: "media:show",
      timestamp: 1700000000000,
      payload: { cue: { kind: "image", id: "01MEDIA", title: "Welcome Slide" } },
    },
    "operator"
  )
  assert.equal(showResult.ok, false, "no client role may send media:show inbound")
})

const VALID_RUNDOWN = {
  id: "01RUNDOWN",
  title: "Sunday Service",
  scenes: [
    { kind: "blank" },
    { kind: "announcement", title: "Welcome", body: "Glad you're here." },
    { kind: "media", mediaCueId: "01MEDIA" },
    { kind: "verse", reference: { book: "john", chapter: 3, verse: 16 } },
  ],
}

test("validateWsMessage: accepts a valid rundown:load command covering every scene kind", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "rundown:load", timestamp: 1700000000000, payload: { rundown: VALID_RUNDOWN } },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: rejects rundown:load with a malformed scene or missing fields", () => {
  const malformedScene = validateWsMessage(
    {
      id: "01ABC",
      type: "rundown:load",
      timestamp: 1700000000000,
      payload: { rundown: { id: "01R", title: "X", scenes: [{ kind: "media" }] } },
    },
    "operator"
  )
  const unknownKind = validateWsMessage(
    {
      id: "01ABC",
      type: "rundown:load",
      timestamp: 1700000000000,
      payload: { rundown: { id: "01R", title: "X", scenes: [{ kind: "song" }] } },
    },
    "operator"
  )
  const missingTitle = validateWsMessage(
    {
      id: "01ABC",
      type: "rundown:load",
      timestamp: 1700000000000,
      payload: { rundown: { id: "01R", scenes: [] } },
    },
    "operator"
  )
  assert.equal(malformedScene.ok, false)
  assert.equal(unknownKind.ok, false)
  assert.equal(missingTitle.ok, false)
})

test("validateWsMessage: rejects scene:next/scene:previous with a non-null payload", () => {
  for (const type of ["scene:next", "scene:previous"]) {
    const result = validateWsMessage(
      { id: "01ABC", type, timestamp: 1700000000000, payload: {} },
      "operator"
    )
    assert.equal(result.ok, false, `${type} with a non-null payload must be rejected`)
  }
})

test("validateWsMessage: accepts a valid scene:goto command with a non-negative integer index", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "scene:goto", timestamp: 1700000000000, payload: { index: 2 } },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: rejects scene:goto with a negative, fractional, or missing index", () => {
  for (const payload of [{}, { index: -1 }, { index: 1.5 }, { index: "2" }]) {
    const result = validateWsMessage(
      { id: "01ABC", type: "scene:goto", timestamp: 1700000000000, payload },
      "operator"
    )
    assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} must be rejected`)
  }
})

test("validateWsMessage: rejects any inbound sender for the rundown:load/scene:*/rundown:state/announcement:* role boundaries", () => {
  const commands: Array<[string, unknown]> = [
    ["rundown:load", { rundown: VALID_RUNDOWN }],
    ["scene:next", null],
    ["scene:previous", null],
    ["scene:goto", { index: 0 }],
  ]
  for (const [type, payload] of commands) {
    const result = validateWsMessage(
      { id: "01ABC", type, timestamp: 1700000000000, payload },
      "viewer"
    )
    assert.equal(result.ok, false, `viewer sending ${type} must be rejected`)
  }
  const events: Array<[string, unknown]> = [
    ["rundown:state", { rundownId: "01R", cursor: 0, scene: { kind: "blank" }, interrupted: false }],
    ["announcement:show", { title: "Welcome", body: "Glad you're here." }],
    ["announcement:clear", null],
  ]
  for (const [type, payload] of events) {
    const result = validateWsMessage(
      { id: "01ABC", type, timestamp: 1700000000000, payload },
      "operator"
    )
    assert.equal(result.ok, false, `no client role may send ${type} inbound`)
  }
})
