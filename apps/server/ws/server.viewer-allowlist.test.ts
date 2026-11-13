import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { ChurchOverlayWsServer, VIEWER_OUTBOUND_EVENTS } from "./server"
import { ACTION_REGISTRY } from "./action-registry"
import type { WsMessage } from "../../../packages/contracts"

const TOKENS = { operatorToken: "op-allow-token", viewerToken: "viewer-allow-token" }

async function startServer(onViewerConnected?: (send: (message: WsMessage) => void) => void): Promise<ChurchOverlayWsServer> {
  const server = new ChurchOverlayWsServer({ port: 0, tokens: TOKENS, onViewerConnected })
  await server.ready
  return server
}

function connect(port: number, token: string): Promise<{ socket: WebSocket; received: WsMessage[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    const received: WsMessage[] = []
    socket.on("message", (data) => received.push(JSON.parse(data.toString())))
    socket.once("open", () => resolve({ socket, received }))
    socket.once("error", reject)
  })
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

function message(type: string, payload: unknown = null): WsMessage {
  return { id: `id-${type}`, type: type as WsMessage["type"], timestamp: Date.now(), payload }
}

// AUDIT S-01: a viewer-token client (overlay, stage, live, an OBS source) must never be
// handed the raw microphone transcript, pending verses, near-misses or translations.
const OPERATOR_ONLY = [
  "transcript:final",
  "transcript:partial",
  "translation:final",
  "detector:near-miss",
  "verse:pending",
  "verse:lookup-failed",
  "mic:health",
  "rundown:state",
  "sermonNotes:update",
  "copilot:suggestions",
  "verse:preview-result",
] as const

test("S-01: broadcast() never delivers operator-only events to a viewer socket, but the operator gets them", async () => {
  const server = await startServer()
  try {
    const operator = await connect(server.port, TOKENS.operatorToken)
    const viewer = await connect(server.port, TOKENS.viewerToken)
    for (const type of OPERATOR_ONLY) server.broadcast(message(type, { text: "secret heard text" }))
    server.broadcast(message("verse:show", { reference: { book: "john", chapter: 3, verse: 16 } }))
    await settle()
    assert.deepEqual(viewer.received.map((m) => m.type), ["verse:show"], "viewer only sees what the overlay renders")
    assert.deepEqual(operator.received.map((m) => m.type), [...OPERATOR_ONLY, "verse:show"])
    operator.socket.close()
    viewer.socket.close()
  } finally {
    await server.close()
  }
})

test("S-01: a late-join resync sent through onViewerConnected obeys the same allow-list", async () => {
  const server = await startServer((send) => {
    send(message("transcript:final", { text: "secret" }))
    send(message("rundown:state", { scenes: [] }))
    send(message("layout:update", { layout: "fullscreen" }))
  })
  try {
    const viewer = await connect(server.port, TOKENS.viewerToken)
    await settle()
    assert.deepEqual(viewer.received.map((m) => m.type), ["layout:update"])
    viewer.socket.close()
  } finally {
    await server.close()
  }
})

test("S-01: every event the overlay, stage and live pages render is on the viewer allow-list", () => {
  for (const type of [
    "verse:show", "verse:clear", "media:show", "media:clear", "announcement:show", "announcement:clear",
    "definition:show", "definition:clear", "canvas:show", "canvas:clear", "poster:show", "poster:clear",
    "layout:update", "branding:update", "overlay:style", "outline:show", "outline:clear",
    "timer:state", "stage:alert", "stage:clear-alert", "status:update",
  ]) {
    assert.ok(VIEWER_OUTBOUND_EVENTS.has(type), type)
  }
  for (const type of OPERATOR_ONLY) assert.equal(VIEWER_OUTBOUND_EVENTS.has(type), false, type)
})

// AUDIT SF-03: the new operator-only event is registered, server-only, and shape-validated.
test("SF-03: verse:lookup-failed is a server-only event with a bounded, validated payload", () => {
  const def = ACTION_REGISTRY["verse:lookup-failed"]
  assert.equal(def.kind, "event")
  assert.deepEqual(def.allowedSenders, [])
  const ok = { reference: { book: "john", chapter: 3, verse: 16 }, reason: "unavailable", origin: "override" }
  assert.equal(def.validatePayload(ok), true)
  for (const reason of ["unavailable", "not-found", "invalid"]) assert.equal(def.validatePayload({ ...ok, reason }), true)
  for (const origin of ["detected", "override", "navigate"]) assert.equal(def.validatePayload({ ...ok, origin }), true)
  assert.equal(def.validatePayload({ ...ok, reason: "boom" }), false)
  assert.equal(def.validatePayload({ ...ok, origin: "x" }), false)
  assert.equal(def.validatePayload({ ...ok, reference: { book: "x".repeat(65), chapter: 1, verse: 1 } }), false)
  assert.equal(def.validatePayload({ ...ok, reference: { book: "john", chapter: 1.5, verse: 1 } }), false)
  assert.equal(def.validatePayload({ ...ok, reference: { book: "john", chapter: 1, verse: 100000 } }), false)
  assert.equal(def.validatePayload({ ...ok, reference: null }), false)
  assert.equal(def.validatePayload(null), false)
  assert.equal(def.validatePayload("unavailable"), false)
})
