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
    heartbeatIntervalMs: number
    maxBufferedBytes: number
    maxConnections: number
    maxCommandsPerSecond: number
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
  const viewers: number[] = []
  const server = await startServer({ onViewerConnected: () => viewers.push(1) })
  try {
    await expectConnectionRejected(server.port, "not-a-real-token")
    // The ws CLIENT aborts by itself when the server's 101 response doesn't
    // echo a subprotocol, which previously masked that the server had
    // accepted the socket and registered it as a viewer. Give the server's
    // connection handler a tick, then assert it never did.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(viewers, [], "the server admitted an unrecognized token as a viewer")
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a connection offering NO subprotocol at all is refused, never admitted as a viewer", async () => {
  const viewers: number[] = []
  const commands: unknown[] = []
  const server = await startServer({
    onCommand: (message, role) => commands.push({ message, role }),
    onViewerConnected: () => viewers.push(1),
  })
  try {
    // Deliberately no protocols argument: `ws` only calls handleProtocols
    // when at least one protocol is offered, so this socket used to reach
    // handleConnection with protocol === "" and be assigned the viewer
    // role — receiving broadcast verse text plus the layout/branding
    // late-join state without presenting any token. It must be terminated
    // on arrival instead.
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await new Promise<string>((resolve) => {
      socket.once("error", () => {
        if (closeTimer) clearTimeout(closeTimer)
        resolve("error")
      })
      socket.once("close", () => {
        if (closeTimer) clearTimeout(closeTimer)
        resolve("close")
      })
      closeTimer = setTimeout(
        () => resolve(socket.readyState === WebSocket.OPEN ? "still-open" : "closed"),
        500
      )
    })

    assert.notEqual(outcome, "still-open", "the server left an unauthenticated socket open")
    assert.deepEqual(viewers, [], "the server admitted an unauthenticated connection as a viewer")
    assert.deepEqual(commands, [], "the server processed a command from an unauthenticated connection")
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

test("ChurchOverlayWsServer: a message over the payload limit closes the connection instead of being buffered (viewer and operator alike)", async () => {
  let received = 0
  const rejections: string[] = []
  const server = await startServer({ onCommand: () => received++, onRejected: (reason) => rejections.push(reason) })
  try {
    for (const token of [TOKENS.viewerToken, TOKENS.operatorToken]) {
      const socket = await connect(server.port, token)
      const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)))
      const timedOut = new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3000))
      socket.send(Buffer.alloc(2 * 1024 * 1024, 0x20))
      // 1009 = "message too big", raised by ws itself once maxPayload is exceeded.
      const code = await Promise.race([closed, timedOut])
      if (code === -1) socket.terminate()
      assert.equal(code, 1009)
    }
    assert.equal(received, 0)
    // The oversized frame is reported through onRejected, not thrown as an uncaught exception.
    assert.equal(rejections.filter((reason) => reason.startsWith("socket error:")).length, 2)
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a normal-sized audio frame is still accepted under the payload limit", async () => {
  const frames: AudioFrame[] = []
  const server = await startServer({ onAudioFrame: (frame) => frames.push(frame) })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    // 10 seconds of 16 kHz audio (320 KB) — far larger than any real frame.
    socket.send(encodeAudioFrame({ samples: new Int16Array(160000), sampleRate: 16000, sequence: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(frames.length, 1)
    socket.close()
  } finally {
    await server.close()
  }
})

/** A client that never answers pings — models a phone that went to sleep or a dead network path. */
function connectWithoutPong(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token], { autoPong: false })
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

function whenClosed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) resolve()
    else socket.once("close", () => resolve())
  })
}

test("ChurchOverlayWsServer: heartbeat terminates a client that stops answering pings, and reports it", async () => {
  const rejections: { reason: string; role: WsRole | null }[] = []
  const server = await startServer({
    heartbeatIntervalMs: 40,
    onRejected: (reason, role) => rejections.push({ reason, role }),
  })
  try {
    const socket = await connectWithoutPong(server.port, TOKENS.viewerToken)
    await Promise.race([
      whenClosed(socket),
      new Promise((_, reject) => setTimeout(() => reject(new Error("silent client was never dropped")), 1500)),
    ])

    const timeout = rejections.find((entry) => entry.reason.startsWith("connection timed out"))
    assert.ok(timeout, "the drop must be observable through onRejected")
    assert.equal(timeout?.role, "viewer")
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: heartbeat leaves a healthy client connected across many intervals", async () => {
  const rejections: string[] = []
  const server = await startServer({ heartbeatIntervalMs: 30, onRejected: (reason) => rejections.push(reason) })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    await new Promise((resolve) => setTimeout(resolve, 350)) // ~10 heartbeat ticks
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.deepEqual(rejections, [])
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: inbound messages count as liveness, so a busy client is never dropped for a late pong", async () => {
  const rejections: string[] = []
  const server = await startServer({ heartbeatIntervalMs: 40, onRejected: (reason) => rejections.push(reason) })
  try {
    const socket = await connectWithoutPong(server.port, TOKENS.operatorToken)
    const message: WsMessage = { id: "01LIVE", type: "mic:start", timestamp: Date.now(), payload: null }
    const chatter = setInterval(() => socket.send(JSON.stringify(message)), 10)
    try {
      await new Promise((resolve) => setTimeout(resolve, 350))
    } finally {
      clearInterval(chatter)
    }
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.equal(rejections.filter((reason) => reason.startsWith("connection timed out")).length, 0)
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a disabled heartbeat (0) never drops a silent client", async () => {
  const rejections: string[] = []
  const server = await startServer({ heartbeatIntervalMs: 0, onRejected: (reason) => rejections.push(reason) })
  try {
    const socket = await connectWithoutPong(server.port, TOKENS.viewerToken)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.deepEqual(rejections, [])
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a consumer that stops reading is dropped once its queue passes the bound, and the server stays usable", async () => {
  const rejections: { reason: string; role: WsRole | null }[] = []
  const server = await startServer({
    heartbeatIntervalMs: 0, // isolate the backpressure guard from the heartbeat
    maxBufferedBytes: 256 * 1024,
    onRejected: (reason, role) => rejections.push({ reason, role }),
  })
  try {
    const stalled = await connect(server.port, TOKENS.viewerToken)
    // Stop the client's socket from reading: the kernel buffers fill, then ws
    // starts queueing in the server process — exactly a stalled consumer.
    ;(stalled as unknown as { _socket: { pause(): void } })._socket.pause()

    const bigPayload = "x".repeat(1024 * 1024)
    for (let i = 0; i < 200 && !rejections.some((entry) => entry.reason.startsWith("slow consumer dropped")); i++) {
      server.broadcast({ id: `01BIG${i}`, type: "status:update", timestamp: Date.now(), payload: bigPayload })
    }

    const dropped = rejections.find((entry) => entry.reason.startsWith("slow consumer dropped"))
    assert.ok(dropped, "a stalled consumer must be dropped instead of buffered without bound")
    assert.equal(dropped?.role, "viewer")

    // A fresh client still connects and still receives broadcasts.
    const fresh = await connect(server.port, TOKENS.viewerToken)
    const received = waitForMessage(fresh)
    server.broadcast({ id: "01OK", type: "status:update", timestamp: Date.now(), payload: { ok: true } })
    assert.match(await received, /"01OK"/)
    fresh.close()
    stalled.terminate()
  } finally {
    await server.close()
  }
})

// ---- Hardening (ARCHITECTURE.md section 112) ------------------------------

const MIC_START = (id: string): string => JSON.stringify({ id, type: "mic:start", timestamp: Date.now(), payload: null })
const audioFrame = (sequence: number): Uint8Array => encodeAudioFrame({ samples: new Int16Array(160), sampleRate: 16000, sequence })

test("ChurchOverlayWsServer: a throwing onCommand is reported and the connection and server stay up", async () => {
  const rejected: string[] = []
  let calls = 0
  const server = await startServer({
    onCommand: () => {
      calls += 1
      if (calls === 1) throw new Error("boom")
    },
    onRejected: (reason) => rejected.push(reason),
  })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    socket.send(MIC_START("01A"))
    socket.send(MIC_START("01B"))
    await waitFor(() => calls === 2)
    assert.ok(rejected.some((r) => r.includes("onCommand threw: boom")))
    assert.equal(socket.readyState, WebSocket.OPEN)
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: a throwing onAudioFrame or onViewerConnected does not crash the process", async () => {
  const rejected: string[] = []
  const server = await startServer({
    onAudioFrame: () => {
      throw new Error("audio boom")
    },
    onViewerConnected: () => {
      throw new Error("viewer boom")
    },
    onRejected: (reason) => rejected.push(reason),
  })
  try {
    const viewer = await connect(server.port, TOKENS.viewerToken)
    const operator = await connect(server.port, TOKENS.operatorToken)
    operator.send(audioFrame(1))
    await waitFor(() => rejected.some((r) => r.includes("onAudioFrame threw")))
    assert.ok(rejected.some((r) => r.includes("onViewerConnected threw")))
    assert.equal(viewer.readyState, WebSocket.OPEN)
    viewer.close()
    operator.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: commands past the per-second limit are dropped and reported once; audio is not limited", async () => {
  const received: string[] = []
  const rejected: string[] = []
  const frames: number[] = []
  const server = await startServer({
    maxCommandsPerSecond: 5,
    onCommand: (message) => received.push(message.id),
    onAudioFrame: (frame) => frames.push(frame.sequence),
    onRejected: (reason) => rejected.push(reason),
  })
  try {
    const socket = await connect(server.port, TOKENS.operatorToken)
    for (let i = 0; i < 30; i++) socket.send(MIC_START(`id-${i}`))
    for (let i = 0; i < 30; i++) socket.send(audioFrame(i))
    await waitFor(() => frames.length === 30)
    assert.equal(received.length, 5)
    assert.equal(rejected.filter((r) => r.includes("rate limit")).length, 1)
    socket.close()
  } finally {
    await server.close()
  }
})

test("ChurchOverlayWsServer: connections beyond the cap are refused and reported; earlier ones keep working", async () => {
  const rejected: string[] = []
  const server = await startServer({ maxConnections: 2, onRejected: (reason) => rejected.push(reason) })
  try {
    const a = await connect(server.port, TOKENS.viewerToken)
    const b = await connect(server.port, TOKENS.viewerToken)
    const c = new WebSocket(`ws://127.0.0.1:${server.port}`, [TOKENS.viewerToken])
    c.on("error", () => undefined)
    await waitFor(() => c.readyState === WebSocket.CLOSED)
    assert.ok(rejected.some((r) => r.includes("connection refused")))
    assert.equal(a.readyState, WebSocket.OPEN)
    assert.equal(b.readyState, WebSocket.OPEN)
    a.close()
    b.close()
  } finally {
    await server.close()
  }
})
