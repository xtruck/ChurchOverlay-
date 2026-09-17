import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { startAppCore } from "./app-core"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { encodeAudioFrame } from "../../../packages/shared/audio-frame-codec"
import { Logger } from "../../../packages/shared/logger"
import type {
  AsrProvider,
  AudioFrame,
  TranscriptResult,
  Verse,
  VerseReference,
  VerseSource,
  WsMessage,
} from "../../../packages/contracts"

const TOKENS = { operatorToken: "op-token", viewerToken: "viewer-token" }

/** Named per AGENTS.md section 45 — a test double, not a real ASR provider. */
class FakeAsrProvider implements AsrProvider {
  startCalls = 0
  stopCalls = 0
  sentFrames: AudioFrame[] = []
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null

  async start(): Promise<void> {
    this.startCalls += 1
  }
  async sendAudio(audio: AudioFrame): Promise<void> {
    this.sentFrames.push(audio)
  }
  async stop(): Promise<void> {
    this.stopCalls += 1
  }
  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }
  emitTranscript(result: TranscriptResult): void {
    this.transcriptCallback?.(result)
  }
}

/** Named per AGENTS.md section 45 — a test double, not a real verse source. */
class StubVerseSource implements VerseSource {
  constructor(private readonly byBook: Record<string, Verse>) {}
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    return this.byBook[reference.book] ?? null
  }
}

function makeVerse(reference: VerseReference, text: string): Verse {
  return { reference, text, translation: "kjv", source: "bible-api.com" }
}

function silentLogger(): Logger {
  return new Logger({ write: () => {} })
}

async function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

function waitForMessage(socket: WebSocket): Promise<WsMessage> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())))
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor() timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("AppCore: mic:start and mic:stop commands reach the injected AsrProvider", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const socket = await connect(app.wsServer.port, TOKENS.operatorToken)
    socket.send(JSON.stringify({ id: "01A", type: "mic:start", timestamp: Date.now(), payload: null }))
    await waitFor(() => asr.startCalls === 1)

    socket.send(JSON.stringify({ id: "01B", type: "mic:stop", timestamp: Date.now(), payload: null }))
    await waitFor(() => asr.stopCalls === 1)

    socket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a binary audio frame from the operator reaches the injected AsrProvider", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const socket = await connect(app.wsServer.port, TOKENS.operatorToken)
    socket.send(encodeAudioFrame({ samples: Int16Array.from([1, 2, 3]), sampleRate: 16000, sequence: 5 }))
    await waitFor(() => asr.sentFrames.length === 1)
    assert.equal(asr.sentFrames[0]?.sequence, 5)
    socket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: verse:clear broadcasts a verse:clear event to all connected clients", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    const viewerReceived = waitForMessage(viewerSocket)

    operatorSocket.send(
      JSON.stringify({ id: "01A", type: "verse:clear", timestamp: Date.now(), payload: null })
    )

    const message = await viewerReceived
    assert.equal(message.type, "verse:clear")
    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: verse:override with a reference that resolves broadcasts verse:show — the same validation pipeline as detection, per AGENTS.md section 50", async () => {
  const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "For God so loved the world...")
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({ john: johnVerse }),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerReceived = waitForMessage(viewerSocket)

    operatorSocket.send(
      JSON.stringify({
        id: "01A",
        type: "verse:override",
        timestamp: Date.now(),
        payload: { book: "john", chapter: 3, verse: 16 },
      })
    )

    const message = await viewerReceived
    assert.equal(message.type, "verse:show")
    assert.deepEqual(message.payload, johnVerse)
    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: verse:override with a reference the source can't resolve broadcasts nothing", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}), // resolves everything to null
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    let received = false
    viewerSocket.once("message", () => {
      received = true
    })

    operatorSocket.send(
      JSON.stringify({
        id: "01A",
        type: "verse:override",
        timestamp: Date.now(),
        payload: { book: "john", chapter: 3, verse: 16 },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(received, false)
    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a real spoken reference in an ASR transcript automatically reaches the overlay as verse:show — the actual end-to-end value proposition", async () => {
  const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "For God so loved the world...")
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({ john: johnVerse }),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    const viewerReceived = waitForMessage(viewerSocket)

    // No WS message was ever sent by an operator — this is the ASR
    // provider emitting a transcript entirely on its own, exactly as it
    // would after real speech, per ARCHITECTURE.md section 44's dry-run
    // model (a synthetic final transcript exercising the full pipeline).
    asr.emitTranscript({
      id: "01T",
      correlationId: "01CORR",
      sequence: 1,
      text: "Please turn to John 3:16 tonight.",
      state: "final",
      timestamp: Date.now(),
    })

    const message = await viewerReceived
    assert.equal(message.type, "verse:show")
    assert.deepEqual(message.payload, johnVerse)
    assert.equal(message.correlationId, "01CORR")
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a hallucination-guard-rejected transcript reaches the overlay as nothing", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    let received = false
    viewerSocket.once("message", () => {
      received = true
    })

    asr.emitTranscript({
      id: "01T",
      correlationId: "01CORR",
      sequence: 1,
      text: "Frogs 3:16 is not a real verse.",
      state: "final",
      timestamp: Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(received, false)
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: stop() stops the ASR provider and closes the WS server", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  const port = app.wsServer.port
  await app.stop()

  assert.equal(asr.stopCalls, 1)
  await assert.rejects(() => connect(port, TOKENS.operatorToken))
})
