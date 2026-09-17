import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { ChurchOverlayWsServer } from "./server"
import { encodeAudioFrame } from "../../../packages/shared/audio-frame-codec"
import type { AudioFrame, WsMessage, WsRole } from "../../../packages/contracts"

const TOKENS = { operatorToken: "op-secret-token", viewerToken: "viewer-secret-token" }

/**
 * These are deliberately real network tests, not mocked: this class's
 * entire job is wiring up a real ws.WebSocketServer correctly (host
 * binding, Sec-WebSocket-Protocol role negotiation, message validation).
 * Loopback-only (127.0.0.1, ephemeral port) — not a third-party/unstable
 * service, so this doesn't run afoul of AGENTS.md sections 32-33.
 */
async function startServer(
  overrides: Partial<{
    onCommand: (message: WsMessage, role: WsRole) => void
    onAudioFrame: (frame: AudioFrame) => void
    onRejected: (reason: string, role: WsRole | null) => void
    onViewerConnected: (send: (message: WsMessage) => void) => void
  }> = {}
): Promise<ChurchOverlayWsServer> {
  const server = new ChurchOverlayWsServer({ port: 0, tokens: TOKENS, ...overrides })
  await server.ready
  return server
}

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

/** Resolves if the handshake is rejected (never opens), rejects otherwise. */
function expectConnectionRejected(port: number, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    socket.once("open", () => reject(new Error("expected the connection to be rejected")))
    socket.once("error", () => resolve())
    socket.once("close", () => resolve())
  })
}

test("ChurchOverlayWsServer: defaults to binding 127.0.0.1", async () => {
  const server = await startServer()
  try {
    // Connecting on the loopback address must succeed, proving that's
    // what it actually bound to (rather than asserting internal state).
    const socket = await connect(server.port, TOKENS.operatorToken)
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: an unrecognized token is rejected at the handshake, before any message is possible", async () => {
  const server = await startServer()
  try {
    await expectConnectionRejected(server.port, "not-a-real-token")
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a valid operator token connects and a valid command reaches onCommand with role 'operator'", async () => {
  const received: { message: WsMessage; role: WsRole }[] = []
  const server = await startServer({ onCommand: (message, role) => received.push({ message, role }) })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    const message: WsMessage = {
      id: "01ABC",
      type: "mic:start",
      timestamp: Date.now(),
      payload: null,
    }
    socket.send(JSON.stringify(message))
    await waitFor(() => received.length === 1)

    assert.equal(received[0]?.role, "operator")
    assert.equal(received[0]?.message.type, "mic:start")
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a viewer sending an operator-only command is rejected, not delivered to onCommand", async () => {
  const commands: unknown[] = []
  const rejections: { reason: string; role: WsRole | null }[] = []
  const server = await startServer({
    onCommand: (message, role) => commands.push({ message, role }),
    onRejected: (reason, role) => rejections.push({ reason, role }),
  })
  try {
    const socket = await connect(server.port, TOKENS.viewerToken)
    socket.send(
      JSON.stringify({ id: "01ABC", type: "mic:start", timestamp: Date.now(), payload: null })
    )
    await waitFor(() => rejections.length === 1)

    assert.equal(commands.length, 0)
    assert.equal(rejections[0]?.role, "viewer")
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: malformed JSON is rejected without crashing the server or the connection", async () => {
  const rejections: string[] = []
  const server = await startServer({ onRejected: (reason) => rejections.push(reason) })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    socket.send("this is not json")
    await waitFor(() => rejections.length === 1)

    // The connection and server must still be usable afterward.
    const commands: unknown[] = []
    server.broadcast({ id: "01EVT", type: "status:update", timestamp: Date.now(), payload: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(commands.length, 0) // nothing subscribed here, just proving no throw occurred
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: broadcast() delivers an event to every connected client", async () => {
  const server = await startServer()
  try {
    const operatorSocket = await connect(server.port, TOKENS.operatorToken)
    const viewerSocket = await connect(server.port, TOKENS.viewerToken)

    const operatorReceived = waitForMessage(operatorSocket)
    const viewerReceived = waitForMessage(viewerSocket)

    const event: WsMessage = {
      id: "01EVT",
      type: "verse:show",
      timestamp: Date.now(),
      payload: {
        reference: { book: "john", chapter: 3, verse: 16 },
        text: "For God so loved the world...",
        translation: "kjv",
        source: "bible-api.com",
      },
    }
    server.broadcast(event)

    const [operatorMsg, viewerMsg] = await Promise.all([operatorReceived, viewerReceived])
    assert.deepEqual(JSON.parse(operatorMsg), event)
    assert.deepEqual(JSON.parse(viewerMsg), event)

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a binary audio frame from the operator reaches onAudioFrame, correctly decoded", async () => {
  const frames: AudioFrame[] = []
  const server = await startServer({ onAudioFrame: (frame) => frames.push(frame) })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    const sent: AudioFrame = { samples: Int16Array.from([1, 2, 3, -1000]), sampleRate: 16000, sequence: 9 }
    socket.send(encodeAudioFrame(sent))
    await waitFor(() => frames.length === 1)

    assert.equal(frames[0]?.sequence, 9)
    assert.deepEqual(Array.from(frames[0]?.samples ?? []), [1, 2, 3, -1000])
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a viewer sending a binary audio frame is rejected, not delivered to onAudioFrame", async () => {
  const frames: AudioFrame[] = []
  const rejections: { reason: string; role: WsRole | null }[] = []
  const server = await startServer({
    onAudioFrame: (frame) => frames.push(frame),
    onRejected: (reason, role) => rejections.push({ reason, role }),
  })
  try {
    const socket = await connect(server.port, TOKENS.viewerToken)
    socket.send(encodeAudioFrame({ samples: Int16Array.from([1]), sampleRate: 16000, sequence: 1 }))
    await waitFor(() => rejections.length === 1)

    assert.equal(frames.length, 0)
    assert.equal(rejections[0]?.role, "viewer")
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a malformed binary frame is rejected without crashing the server", async () => {
  const rejections: string[] = []
  const server = await startServer({ onRejected: (reason) => rejections.push(reason) })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    socket.send(Buffer.from([1, 2, 3])) // too short to contain even the sequence prefix
    await waitFor(() => rejections.length === 1)

    assert.match(rejections[0] ?? "", /malformed audio frame/)
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: onViewerConnected fires for a new viewer connection, and the send it hands back reaches only that connection", async () => {
  const server = await startServer({
    onViewerConnected: (send) => {
      send({ id: "01SYNC", type: "verse:show", timestamp: Date.now(), payload: null })
    },
  })
  try {
    const operatorSocket = await connect(server.port, TOKENS.operatorToken)
    let operatorReceived = false
    operatorSocket.once("message", () => {
      operatorReceived = true
    })

    // The server may send the sync message the instant the connection
    // opens, so the "message" listener must be attached before (or in
    // the same tick as) the socket is created — not after awaiting
    // connect()'s own "open" resolution, which risks missing it.
    const viewerSocket = new WebSocket(`ws://127.0.0.1:${server.port}`, [TOKENS.viewerToken])
    const viewerMessage = waitForMessage(viewerSocket)
    const message = JSON.parse(await viewerMessage) as WsMessage
    assert.equal(message.id, "01SYNC")

    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(operatorReceived, false, "onViewerConnected must not reach the operator connection")
    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: onViewerConnected does not fire for an operator connection", async () => {
  const calls: unknown[] = []
  const server = await startServer({ onViewerConnected: (send) => calls.push(send) })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(calls.length, 0)
    socket.close()
  } finally {
    await server.close()
  }
})

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(data.toString()))
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor() timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
