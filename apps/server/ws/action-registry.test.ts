import { test } from "node:test"
import assert from "node:assert/strict"
import { validateWsMessage, ACTION_REGISTRY } from "./action-registry"

test("ACTION_REGISTRY: contains exactly the seven v1 actions from ARCHITECTURE.md section 30", () => {
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
