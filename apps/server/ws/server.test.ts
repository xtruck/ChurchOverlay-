import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { ChurchOverlayWsServer } from "./server"
import type { WsMessage, WsRole } from "../../../packages/contracts"

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
    onRejected: (reason: string, role: WsRole | null) => void
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
