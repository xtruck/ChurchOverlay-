import { test } from "node:test"
import assert from "node:assert/strict"
import { validateWsMessage, ACTION_REGISTRY } from "./action-registry"

test("ACTION_REGISTRY: contains exactly the seven v1 actions plus the Phase 2 media, rundown, glossary, verse-confirmation, sermon-notes, and canvas actions (ARCHITECTURE.md sections 30, 60, 64, 65.3, 65.5, 65.7, 66)", () => {
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
      "verse:pending",
      "verse:confirm-pending",
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
      "definition:show",
      "definition:clear",
      "sermonNotes:update",
      "canvas:show",
      "canvas:clear",
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

test("ACTION_REGISTRY['status:update'].validatePayload: accepts a valid ASR health payload, rejects an invalid or missing asrHealth", () => {
  assert.equal(ACTION_REGISTRY["status:update"].validatePayload({ asrHealth: "ok" }), true)
  assert.equal(ACTION_REGISTRY["status:update"].validatePayload({ asrHealth: "error", error: "network timeout" }), true)

  for (const payload of [{}, { asrHealth: "unknown" }, { asrHealth: "ok", error: 5 }, null]) {
    assert.equal(ACTION_REGISTRY["status:update"].validatePayload(payload), false, `payload ${JSON.stringify(payload)} must be rejected`)
  }
})

const VALID_CANVAS_LAYERS = [
  { id: "01LAYER-TEXT", kind: "text", x: 10, y: 10, width: 80, height: 20, zIndex: 1, text: "Welcome", fontFamily: "serif", fontSizePx: 48, color: "#ffffff", align: "center" },
  { id: "01LAYER-IMAGE", kind: "image", x: 20, y: 40, width: 60, height: 40, zIndex: 2, mediaCueId: "01MEDIA" },
  { id: "01LAYER-BG", kind: "background", x: 0, y: 0, width: 100, height: 100, zIndex: 0, color: "#000000", mediaCueId: null },
]

const VALID_RUNDOWN = {
  id: "01RUNDOWN",
  title: "Sunday Service",
  scenes: [
    { kind: "blank" },
    { kind: "announcement", title: "Welcome", body: "Glad you're here." },
    { kind: "media", mediaCueId: "01MEDIA" },
    { kind: "verse", reference: { book: "john", chapter: 3, verse: 16 } },
    { kind: "canvas", canvas: { layers: VALID_CANVAS_LAYERS } },
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
  const malformedCanvasLayer = validateWsMessage(
    {
      id: "01ABC",
      type: "rundown:load",
      timestamp: 1700000000000,
      payload: {
        rundown: {
          id: "01R",
          title: "X",
          scenes: [{ kind: "canvas", canvas: { layers: [{ id: "01L", kind: "text", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }] } }],
        },
      },
    },
    "operator"
  )
  assert.equal(malformedScene.ok, false)
  assert.equal(unknownKind.ok, false)
  assert.equal(missingTitle.ok, false)
  assert.equal(malformedCanvasLayer.ok, false, "a text layer missing text/fontFamily/fontSizePx/color/align must be rejected")
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

test("ACTION_REGISTRY['definition:show'].validatePayload: accepts a valid definition, rejects a malformed one", () => {
  assert.equal(
    ACTION_REGISTRY["definition:show"].validatePayload({ term: "Grace", definition: "Unmerited favor." }),
    true
  )
  for (const payload of [{}, { term: "Grace" }, { term: 5, definition: "x" }, null]) {
    assert.equal(
      ACTION_REGISTRY["definition:show"].validatePayload(payload),
      false,
      `payload ${JSON.stringify(payload)} must be rejected`
    )
  }
})

test("validateWsMessage: rejects any inbound sender for definition:show/definition:clear — server-only events", () => {
  const events: Array<[string, unknown]> = [
    ["definition:show", { term: "Grace", definition: "Unmerited favor." }],
    ["definition:clear", null],
  ]
  for (const [type, payload] of events) {
    const result = validateWsMessage({ id: "01ABC", type, timestamp: 1700000000000, payload }, "operator")
    assert.equal(result.ok, false, `no client role may send ${type} inbound`)
  }
})

const VALID_PENDING_VERSE = {
  reference: { book: "john", chapter: 3, verse: 16 },
  text: "For God so loved the world...",
  translation: "kjv",
  source: "bible-api.com",
}

test("validateWsMessage: accepts a valid verse:confirm-pending command (null payload) from an operator", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "verse:confirm-pending", timestamp: 1700000000000, payload: null },
    "operator"
  )
  assert.equal(result.ok, true)
})

test("validateWsMessage: rejects verse:confirm-pending with a non-null payload, and rejects a viewer sending it", () => {
  const withPayload = validateWsMessage(
    { id: "01ABC", type: "verse:confirm-pending", timestamp: 1700000000000, payload: {} },
    "operator"
  )
  assert.equal(withPayload.ok, false)
  const fromViewer = validateWsMessage(
    { id: "01ABC", type: "verse:confirm-pending", timestamp: 1700000000000, payload: null },
    "viewer"
  )
  assert.equal(fromViewer.ok, false)
})

test("ACTION_REGISTRY['verse:pending'].validatePayload: accepts a valid pending Verse (no trigger required), rejects a malformed one", () => {
  assert.equal(ACTION_REGISTRY["verse:pending"].validatePayload(VALID_PENDING_VERSE), true)
  for (const payload of [{}, { ...VALID_PENDING_VERSE, reference: null }, null]) {
    assert.equal(
      ACTION_REGISTRY["verse:pending"].validatePayload(payload),
      false,
      `payload ${JSON.stringify(payload)} must be rejected`
    )
  }
})

test("validateWsMessage: rejects any inbound sender for verse:pending — a server-only event", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "verse:pending", timestamp: 1700000000000, payload: VALID_PENDING_VERSE },
    "operator"
  )
  assert.equal(result.ok, false)
})

test("ACTION_REGISTRY['sermonNotes:update'].validatePayload: accepts a valid notes string, rejects a malformed one", () => {
  assert.equal(ACTION_REGISTRY["sermonNotes:update"].validatePayload({ notes: "- Point one\n- Point two" }), true)
  for (const payload of [{}, { notes: 5 }, { notes: null }, null]) {
    assert.equal(
      ACTION_REGISTRY["sermonNotes:update"].validatePayload(payload),
      false,
      `payload ${JSON.stringify(payload)} must be rejected`
    )
  }
})

test("validateWsMessage: rejects any inbound sender for sermonNotes:update — a server-only event", () => {
  const asOperator = validateWsMessage(
    { id: "01ABC", type: "sermonNotes:update", timestamp: 1700000000000, payload: { notes: "- A point" } },
    "operator"
  )
  const asViewer = validateWsMessage(
    { id: "01ABC", type: "sermonNotes:update", timestamp: 1700000000000, payload: { notes: "- A point" } },
    "viewer"
  )
  assert.equal(asOperator.ok, false)
  assert.equal(asViewer.ok, false)
})

// ARCHITECTURE.md section 66.4/66.7: the canvas scene editor's WS surface.
test("ACTION_REGISTRY['canvas:show'].validatePayload: accepts a valid mixed-layer list, rejects malformed layers", () => {
  assert.equal(ACTION_REGISTRY["canvas:show"].validatePayload({ layers: VALID_CANVAS_LAYERS }), true)
  assert.equal(ACTION_REGISTRY["canvas:show"].validatePayload({ layers: [] }), true)

  const outOfRangeX = { ...VALID_CANVAS_LAYERS[0], x: 150 }
  const unknownKind = { ...VALID_CANVAS_LAYERS[0], kind: "video" }
  const missingTextFields = { id: "01L", kind: "text", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }
  const missingImageMediaCueId = { id: "01L", kind: "image", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }
  const badBackgroundColor = { id: "01L", kind: "background", x: 0, y: 0, width: 10, height: 10, zIndex: 1, color: 5, mediaCueId: null }

  for (const layer of [outOfRangeX, unknownKind, missingTextFields, missingImageMediaCueId, badBackgroundColor]) {
    assert.equal(
      ACTION_REGISTRY["canvas:show"].validatePayload({ layers: [layer] }),
      false,
      `layer ${JSON.stringify(layer)} must be rejected`
    )
  }
  for (const payload of [{}, { layers: "not-an-array" }, null]) {
    assert.equal(
      ACTION_REGISTRY["canvas:show"].validatePayload(payload),
      false,
      `payload ${JSON.stringify(payload)} must be rejected`
    )
  }
})

test("validateWsMessage: rejects any inbound sender for canvas:show/canvas:clear — server-only events", () => {
  const events: Array<[string, unknown]> = [
    ["canvas:show", { layers: VALID_CANVAS_LAYERS }],
    ["canvas:clear", null],
  ]
  for (const [type, payload] of events) {
    const asOperator = validateWsMessage({ id: "01ABC", type, timestamp: 1700000000000, payload }, "operator")
    const asViewer = validateWsMessage({ id: "01ABC", type, timestamp: 1700000000000, payload }, "viewer")
    assert.equal(asOperator.ok, false, `no client role may send ${type} inbound (operator)`)
    assert.equal(asViewer.ok, false, `no client role may send ${type} inbound (viewer)`)
  }
})

test("validateWsMessage: rejects canvas:clear with a non-null payload", () => {
  const result = validateWsMessage(
    { id: "01ABC", type: "canvas:clear", timestamp: 1700000000000, payload: {} },
    "operator"
  )
  assert.equal(result.ok, false)
})
