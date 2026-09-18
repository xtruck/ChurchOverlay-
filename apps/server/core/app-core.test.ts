import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"
import { startAppCore } from "./app-core"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { MediaLibrary } from "../media/media-library"
import { encodeAudioFrame } from "../../../packages/shared/audio-frame-codec"
import { Logger } from "../../../packages/shared/logger"
import type {
  AsrProvider,
  AudioFrame,
  Rundown,
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
  private errorCallback: ((error: Error) => void) | null = null

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
  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback
  }
  emitError(error: Error): void {
    this.errorCallback?.(error)
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

/**
 * For a single trigger that broadcasts multiple messages in quick
 * succession (e.g. a rundown scene activation's rundown:state plus its
 * content event) — a persistent listener accumulating into an array,
 * NOT multiple stacked `once` calls. Registering N `once` listeners
 * upfront does not give "first listener gets message 1, second gets
 * message 2": emit() invokes every currently-registered listener for
 * that event on EACH emission, so two once-listeners would both fire on
 * the first message and neither would see the second.
 */
function waitForMessages(socket: WebSocket, count: number): Promise<WsMessage[]> {
  return new Promise((resolve) => {
    const collected: WsMessage[] = []
    const handler = (data: { toString(): string }) => {
      collected.push(JSON.parse(data.toString()))
      if (collected.length === count) {
        socket.off("message", handler)
        resolve(collected)
      }
    }
    socket.on("message", handler)
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

test("AppCore: a loud binary audio frame from the operator reaches the injected AsrProvider", async () => {
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
    // Loud enough to clear the SilenceGate's default threshold — this is
    // a speech-like frame, not silence. See the dedicated silence test
    // below for the gate actually filtering something out.
    socket.send(
      encodeAudioFrame({ samples: Int16Array.from(new Array(160).fill(5000)), sampleRate: 16000, sequence: 5 })
    )
    await waitFor(() => asr.sentFrames.length === 1)
    assert.equal(asr.sentFrames[0]?.sequence, 5)
    socket.close()
  } finally {
    await app.stop()
  }
})

// This is the actual behavior ARCHITECTURE.md section 9's "silence
// gating works" checklist item means — not just that SilenceGate's own
// unit tests pass in isolation, but that AppCore genuinely applies it to
// every frame before the real ASR provider (and its real API cost) ever
// sees it.
test("AppCore: a frame of pure silence is filtered by the SilenceGate and never reaches the AsrProvider", async () => {
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
    socket.send(
      encodeAudioFrame({ samples: Int16Array.from(new Array(160).fill(0)), sampleRate: 16000, sequence: 1 })
    )
    // A loud frame afterward proves the connection/pipeline is still
    // alive and working — the silent one wasn't dropped by some
    // unrelated failure.
    socket.send(
      encodeAudioFrame({ samples: Int16Array.from(new Array(160).fill(5000)), sampleRate: 16000, sequence: 2 })
    )
    await waitFor(() => asr.sentFrames.length === 1)

    assert.equal(asr.sentFrames.length, 1)
    assert.equal(asr.sentFrames[0]?.sequence, 2)
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
    // ARCHITECTURE.md section 65.2: verse:show's payload is Verse plus a
    // trigger field — "override" here, since this came from a manual
    // verse:override command, not a live detection.
    assert.deepEqual(message.payload, { ...johnVerse, trigger: "override" })
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
    // ARCHITECTURE.md section 65.2: a live-detected verse's trigger is "detected".
    assert.deepEqual(message.payload, { ...johnVerse, trigger: "detected" })
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

async function withMediaLibrary(fn: (library: MediaLibrary, sourceDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "churchoverlay-appcore-media-test-"))
  try {
    const library = new MediaLibrary({ mediaDir: join(root, "media") })
    await fn(library, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("AppCore: media:select with a real imported id broadcasts media:show playing at position 0", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "clip.mp4")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Intro Clip", "video")

    const app = await startAppCore({
      asr: new FakeAsrProvider(),
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new StubVerseSource({}),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerReceived = waitForMessage(viewerSocket)

      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "media:select", timestamp: Date.now(), payload: { id: cue.id } })
      )

      const message = await viewerReceived
      assert.equal(message.type, "media:show")
      const payload = message.payload as { cue: unknown; playback: { state: string; positionMs: number } }
      assert.deepEqual(payload.cue, cue)
      assert.equal(payload.playback.state, "playing")
      assert.equal(payload.playback.positionMs, 0)
      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: media:select with an unknown id broadcasts nothing", async () => {
  await withMediaLibrary(async (mediaLibrary) => {
    const app = await startAppCore({
      asr: new FakeAsrProvider(),
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new StubVerseSource({}),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      let received = false
      viewerSocket.once("message", () => {
        received = true
      })

      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "media:select", timestamp: Date.now(), payload: { id: "unknown-id" } })
      )
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(received, false)
      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: media:pause after media:select broadcasts an updated media:show with state paused", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "clip.mp4")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Intro Clip", "video")

    const app = await startAppCore({
      asr: new FakeAsrProvider(),
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new StubVerseSource({}),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const firstShow = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "media:select", timestamp: Date.now(), payload: { id: cue.id } })
      )
      await firstShow

      const secondShow = waitForMessage(viewerSocket)
      operatorSocket.send(JSON.stringify({ id: "01B", type: "media:pause", timestamp: Date.now(), payload: null }))
      const message = await secondShow

      assert.equal(message.type, "media:show")
      assert.equal((message.payload as { playback: { state: string } }).playback.state, "paused")
      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a viewer connecting while a media cue is already active immediately receives a sync media:show", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Welcome Slide", "image")

    const app = await startAppCore({
      asr: new FakeAsrProvider(),
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new StubVerseSource({}),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const firstViewer = await connect(app.wsServer.port, TOKENS.viewerToken)
      const firstShow = waitForMessage(firstViewer)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "media:select", timestamp: Date.now(), payload: { id: cue.id } })
      )
      await firstShow

      const lateViewer = new WebSocket(`ws://127.0.0.1:${app.wsServer.port}`, [TOKENS.viewerToken])
      const syncMessage = await waitForMessage(lateViewer)

      assert.equal(syncMessage.type, "media:show")
      assert.deepEqual(syncMessage.payload, { cue })
      operatorSocket.close()
      firstViewer.close()
      lateViewer.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a spoken cue title in a final transcript automatically broadcasts media:show", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Welcome Slide", "image")

    const asr = new FakeAsrProvider()
    const app = await startAppCore({
      asr,
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new StubVerseSource({}),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
      const viewerReceived = waitForMessage(viewerSocket)

      asr.emitTranscript({
        id: "01T",
        correlationId: "01CORR",
        sequence: 1,
        text: "Let's put up the welcome slide now.",
        state: "final",
        timestamp: Date.now(),
      })

      const message = await viewerReceived
      assert.equal(message.type, "media:show")
      assert.deepEqual(message.payload, { cue })
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a spoken cue title in a partial transcript never triggers media:show", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    await mediaLibrary.import(source, "Welcome Slide", "image")

    const asr = new FakeAsrProvider()
    const app = await startAppCore({
      asr,
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new StubVerseSource({}),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
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
        text: "Let's put up the welcome slide now.",
        state: "partial",
        timestamp: Date.now(),
      })
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(received, false)
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: media:select without a configured mediaLibrary is handled gracefully, not a crash", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    // no mediaLibrary
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    operatorSocket.send(
      JSON.stringify({ id: "01A", type: "media:select", timestamp: Date.now(), payload: { id: "anything" } })
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Reaching here without the process crashing or the server dying is the assertion.
    operatorSocket.close()
  } finally {
    await app.stop()
  }
})

/**
 * Named per AGENTS.md section 45 — a test double, not a real verse
 * source. Echoes back whatever reference it's asked for as text, so
 * navigation tests can assert on WHICH reference got resolved and
 * broadcast (what matters for correctness here) without needing a full
 * book/chapter/verse -> text mapping the way StubVerseSource's
 * book-only keying can't provide.
 */
class EchoVerseSource implements VerseSource {
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    return { reference, text: `text for ${JSON.stringify(reference)}`, translation: "kjv", source: "test" }
  }
}

test("AppCore: 'next verse' spoken after a detected reference broadcasts the following verse", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const firstShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to John 3:15.",
      state: "final",
      timestamp: Date.now(),
    })
    const firstMessage = await firstShow
    assert.deepEqual((firstMessage.payload as Verse).reference, { book: "john", chapter: 3, verse: 15 })

    const secondShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Next verse.",
      state: "final",
      timestamp: Date.now(),
    })
    const secondMessage = await secondShow
    assert.equal(secondMessage.type, "verse:show")
    assert.deepEqual((secondMessage.payload as Verse).reference, { book: "john", chapter: 3, verse: 16 })

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: 'cancel' spoken after a shown verse broadcasts verse:clear", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const firstShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to John 3:16.",
      state: "final",
      timestamp: Date.now(),
    })
    await firstShow

    const secondShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Cancel.",
      state: "final",
      timestamp: Date.now(),
    })
    const message = await secondShow
    assert.equal(message.type, "verse:clear")

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: 'next verse' spoken with no prior verse shown broadcasts nothing", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
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
      text: "Next verse.",
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

test("AppCore: 'next verse' after a manual verse:override continues from the overridden reference", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const firstShow = waitForMessage(viewerSocket)
    operatorSocket.send(
      JSON.stringify({
        id: "01A",
        type: "verse:override",
        timestamp: Date.now(),
        payload: { book: "romans", chapter: 8, verse: 28 },
      })
    )
    await firstShow

    // Navigation is voice-only (ARCHITECTURE.md section 61.1) — simulated
    // here via a transcript, exactly as a real spoken "next verse" would
    // arrive, even though the position was set by a manual override, not
    // a detected reference.
    const secondShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01B",
      sequence: 1,
      text: "Next verse.",
      state: "final",
      timestamp: Date.now(),
    })
    const message = await secondShow
    assert.deepEqual((message.payload as Verse).reference, { book: "romans", chapter: 8, verse: 29 })

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: rundown:load activates the first scene, broadcasting rundown:state then its content", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const rundown: Rundown = {
      id: "01RUNDOWN",
      title: "Sunday Service",
      scenes: [{ kind: "announcement", title: "Welcome", body: "Glad you're here." }],
    }

    const messages = waitForMessages(viewerSocket, 2)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    const [stateMsg, contentMsg] = await messages

    assert.equal(stateMsg?.type, "rundown:state")
    assert.deepEqual(stateMsg?.payload, {
      rundownId: "01RUNDOWN",
      cursor: 0,
      scene: { kind: "announcement", title: "Welcome", body: "Glad you're here." },
      interrupted: false,
    })
    assert.equal(contentMsg?.type, "announcement:show")
    assert.deepEqual(contentMsg?.payload, { title: "Welcome", body: "Glad you're here." })

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a detected verse while a rundown's media scene is active immediately overlays the verse, then clearing it resumes the media scene", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Welcome Slide", "image")

    const asr = new FakeAsrProvider()
    const app = await startAppCore({
      asr,
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new EchoVerseSource(),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const rundown: Rundown = {
        id: "01RUNDOWN",
        title: "Sunday Service",
        scenes: [{ kind: "media", mediaCueId: cue.id }],
      }

      const loadMessages = waitForMessages(viewerSocket, 2)
      operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
      const [loadState, loadContent] = await loadMessages
      assert.equal(loadState?.type, "rundown:state")
      assert.equal(loadContent?.type, "media:show")

      // A live-detected verse must interrupt immediately, per ARCHITECTURE.md section 64.2.
      const interruptMessages = waitForMessages(viewerSocket, 2)
      asr.emitTranscript({
        id: "01T",
        correlationId: "01B",
        sequence: 1,
        text: "Turn to John 3:16.",
        state: "final",
        timestamp: Date.now(),
      })
      const [interruptState, verseShow] = await interruptMessages
      assert.equal(interruptState?.type, "rundown:state")
      assert.equal((interruptState?.payload as { interrupted: boolean }).interrupted, true)
      assert.equal(verseShow?.type, "verse:show")

      // Clearing the interrupting verse must resume exactly the paused media scene.
      const resumeMessages = waitForMessages(viewerSocket, 3)
      operatorSocket.send(JSON.stringify({ id: "01C", type: "verse:clear", timestamp: Date.now(), payload: null }))
      const [clearMsg, resumeState, resumedMedia] = await resumeMessages
      assert.equal(clearMsg?.type, "verse:clear")
      assert.equal(resumeState?.type, "rundown:state")
      assert.equal((resumeState?.payload as { interrupted: boolean }).interrupted, false)
      assert.equal(resumedMedia?.type, "media:show")
      assert.deepEqual((resumedMedia?.payload as { cue: unknown }).cue, cue)

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: an explicit scene:next during a verse interrupt switches scenes immediately and discards the paused scene instead of resuming it later", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Welcome Slide", "image")

    const asr = new FakeAsrProvider()
    const app = await startAppCore({
      asr,
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new EchoVerseSource(),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const rundown: Rundown = {
        id: "01RUNDOWN",
        title: "Sunday Service",
        scenes: [
          { kind: "announcement", title: "Welcome", body: "Glad you're here." },
          { kind: "media", mediaCueId: cue.id },
        ],
      }

      const loadMessages = waitForMessages(viewerSocket, 2)
      operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
      await loadMessages

      const interruptMessages = waitForMessages(viewerSocket, 2)
      asr.emitTranscript({
        id: "01T",
        correlationId: "01B",
        sequence: 1,
        text: "Turn to John 3:16.",
        state: "final",
        timestamp: Date.now(),
      })
      await interruptMessages

      // The operator explicitly advances the rundown while the verse is
      // still interrupting — this must win immediately and discard the pause.
      const nextMessages = waitForMessages(viewerSocket, 2)
      operatorSocket.send(JSON.stringify({ id: "01C", type: "scene:next", timestamp: Date.now(), payload: null }))
      const [nextState, nextContent] = await nextMessages
      assert.equal(nextState?.type, "rundown:state")
      assert.deepEqual(nextState?.payload, {
        rundownId: "01RUNDOWN",
        cursor: 1,
        scene: { kind: "media", mediaCueId: cue.id },
        interrupted: false,
      })
      assert.equal(nextContent?.type, "media:show")

      // Clearing the (already-superseded) verse now must NOT resurrect the
      // discarded announcement scene — only the plain clear should fire.
      let extraMessages = 0
      viewerSocket.on("message", () => {
        extraMessages += 1
      })
      operatorSocket.send(JSON.stringify({ id: "01D", type: "verse:clear", timestamp: Date.now(), payload: null }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(extraMessages, 1) // exactly the verse:clear itself, nothing resumed

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a 'blank' scene broadcasts verse:clear, media:clear, and announcement:clear together", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const rundown: Rundown = {
      id: "01RUNDOWN",
      title: "Sunday Service",
      scenes: [{ kind: "blank" }],
    }

    const messages = waitForMessages(viewerSocket, 4)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    const received = await messages
    const types = received.map((m) => m.type).sort()
    assert.deepEqual(types, ["announcement:clear", "media:clear", "rundown:state", "verse:clear"])

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// Regression coverage for the audit finding: activateScene()'s "verse"/
// "media" cases silently returned on a resolution failure, with zero
// diagnostic trace — violating AGENTS.md section 25's "never silently
// swallow errors" rule the sibling verse:override/media:select handlers
// already followed.
test("AppCore: a rundown verse scene that fails to resolve logs a diagnostic instead of doing nothing silently", async () => {
  const lines: unknown[] = []
  const logger = new Logger({ write: (line) => lines.push(JSON.parse(line)) })
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}), // always resolves to null — nothing configured
    logger,
    port: 0,
    tokens: TOKENS,
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const rundown: Rundown = {
      id: "01RUNDOWN",
      title: "Sunday Service",
      scenes: [{ kind: "verse", reference: { book: "john", chapter: 3, verse: 16 } }],
    }
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))

    await waitFor(() => lines.some((l) => (l as { event: string }).event === "rundown.scene-verse-unresolved"))
    operatorSocket.close()
  } finally {
    await app.stop()
  }
})

// Regression coverage for the audit finding: a viewer reconnecting during a
// verse-interrupt was resynced with the rundown's PAUSED scene's own
// content, not the verse that is actually visible on screen right now.
test("AppCore: a viewer connecting during a verse-interrupt is resynced with the live verse, not the rundown's paused scene", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Welcome Slide", "image")

    const asr = new FakeAsrProvider()
    const app = await startAppCore({
      asr,
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new EchoVerseSource(),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const rundown: Rundown = {
        id: "01RUNDOWN",
        title: "Sunday Service",
        scenes: [{ kind: "media", mediaCueId: cue.id }],
      }
      const loadMessages = waitForMessages(viewerSocket, 2)
      operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
      await loadMessages

      const interruptMessages = waitForMessages(viewerSocket, 2)
      asr.emitTranscript({
        id: "01T",
        correlationId: "01B",
        sequence: 1,
        text: "Turn to John 3:16.",
        state: "final",
        timestamp: Date.now(),
      })
      await interruptMessages

      // A late viewer connects WHILE the verse is interrupting the media scene.
      const lateViewer = new WebSocket(`ws://127.0.0.1:${app.wsServer.port}`, [TOKENS.viewerToken])
      // media:show (mediaPlayback's own independent resync, unaffected by the
      // interrupt) + rundown:state + verse:show (the fix under test).
      const synced = await waitForMessages(lateViewer, 3)
      const types = synced.map((m) => m.type).sort()
      assert.deepEqual(types, ["media:show", "rundown:state", "verse:show"])

      const verseMsg = synced.find((m) => m.type === "verse:show")
      assert.deepEqual((verseMsg?.payload as Verse).reference, { book: "john", chapter: 3, verse: 16 })
      const rundownStateMsg = synced.find((m) => m.type === "rundown:state")
      assert.equal((rundownStateMsg?.payload as { interrupted: boolean }).interrupted, true)

      operatorSocket.close()
      viewerSocket.close()
      lateViewer.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: scene:goto with an out-of-range index is a no-op, broadcasting nothing", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const rundown: Rundown = { id: "01RUNDOWN", title: "Sunday Service", scenes: [{ kind: "blank" }] }
    const loadMessages = waitForMessages(viewerSocket, 4)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    await loadMessages

    let received = false
    viewerSocket.once("message", () => {
      received = true
    })
    operatorSocket.send(JSON.stringify({ id: "01B", type: "scene:goto", timestamp: Date.now(), payload: { index: 99 } }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(received, false)

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// A web-research-driven addition: ASR failures were previously only ever a
// server-side log line, invisible to the operator dashboard mid-service.
test("AppCore: an ASR error broadcasts status:update, and the next successful transcript broadcasts recovery", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const errorMessage = waitForMessage(viewerSocket)
    asr.emitError(new Error("Groq connection lost"))
    const errorStatus = await errorMessage
    assert.equal(errorStatus.type, "status:update")
    assert.deepEqual(errorStatus.payload, { asrHealth: "error", error: "Groq connection lost" })

    const recoveryMessage = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Welcome everyone.",
      state: "final",
      timestamp: Date.now(),
    })
    const recoveryStatus = await recoveryMessage
    assert.equal(recoveryStatus.type, "status:update")
    assert.deepEqual(recoveryStatus.payload, { asrHealth: "ok" })

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a transcript with no prior ASR error broadcasts no status:update at all", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
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
      correlationId: "01A",
      sequence: 1,
      text: "Welcome everyone.",
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

// ARCHITECTURE.md section 65.1: elliptical/continuation references.
test("AppCore: a bare 'verse N' spoken after a detected reference continues from its book and chapter", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const firstShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to Romans 8:28.",
      state: "final",
      timestamp: Date.now(),
    })
    await firstShow

    const secondShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Now look at verse 29.",
      state: "final",
      timestamp: Date.now(),
    })
    const message = await secondShow
    assert.deepEqual((message.payload as Verse).reference, { book: "romans", chapter: 8, verse: 29 })

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

/** Named per AGENTS.md section 45 — a test double with the optional setMode() capability. */
class ModeAwareVerseSource implements VerseSource {
  modeChanges: string[] = []
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    return { reference, text: `text for ${JSON.stringify(reference)}`, translation: "kjv", source: "test" }
  }
  setMode(mode: string): void {
    this.modeChanges.push(mode)
  }
}

// ARCHITECTURE.md section 65.4: a spoken display-mode switch.
test("AppCore: 'switch to french' calls the source's setMode() and invokes onDisplayModeChanged", async () => {
  const asr = new FakeAsrProvider()
  const source = new ModeAwareVerseSource()
  const changedModes: string[] = []
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source,
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    onDisplayModeChanged: (mode) => changedModes.push(mode),
  })
  try {
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Let's switch to French for this next part.",
      state: "final",
      timestamp: Date.now(),
    })
    await waitFor(() => source.modeChanges.length === 1)
    assert.deepEqual(source.modeChanges, ["french"])
    assert.deepEqual(changedModes, ["french"])
  } finally {
    await app.stop()
  }
})

test("AppCore: 'switch to french' with a source that has no setMode() capability is handled gracefully, not a crash", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(), // no setMode()
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Switch to French.",
      state: "final",
      timestamp: Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Reaching here without the process crashing is the assertion.
  } finally {
    await app.stop()
  }
})

// ARCHITECTURE.md section 65.2: every verse:show trigger value, covering
// all four ways a verse can end up on screen.
test("AppCore: verse:show's trigger field reflects how each verse got there — detected, navigation, and rundown", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const detected = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to John 3:15.",
      state: "final",
      timestamp: Date.now(),
    })
    assert.equal(((await detected).payload as { trigger: string }).trigger, "detected")

    const navigated = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Next verse.",
      state: "final",
      timestamp: Date.now(),
    })
    assert.equal(((await navigated).payload as { trigger: string }).trigger, "navigation")

    const rundown: Rundown = {
      id: "01RUNDOWN",
      title: "Sunday Service",
      scenes: [{ kind: "verse", reference: { book: "romans", chapter: 8, verse: 28 } }],
    }
    const rundownMessages = waitForMessages(viewerSocket, 2) // rundown:state + verse:show
    operatorSocket.send(JSON.stringify({ id: "01C", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    const verseFromRundown = (await rundownMessages).find((m) => m.type === "verse:show")
    assert.equal((verseFromRundown?.payload as { trigger: string }).trigger, "rundown")

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// ARCHITECTURE.md section 65: end-to-end French speech, confirming the
// full pipeline (RegexDetector's Unicode-aware book-name matching,
// NavigationCommandDetector's French phrases) works together, not just
// each piece in isolation.
test("AppCore: a French spoken reference and a French 'verset suivant' navigation both reach the overlay correctly", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const firstShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Tournons-nous vers Jean 3:15 ce soir.",
      state: "final",
      timestamp: Date.now(),
    })
    const firstMessage = await firstShow
    assert.deepEqual((firstMessage.payload as Verse).reference, { book: "john", chapter: 3, verse: 15 })

    const secondShow = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Verset suivant.",
      state: "final",
      timestamp: Date.now(),
    })
    const secondMessage = await secondShow
    assert.deepEqual((secondMessage.payload as Verse).reference, { book: "john", chapter: 3, verse: 16 })

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// ARCHITECTURE.md section 65.5: on-demand glossary lookup by voice.
test("AppCore: a spoken 'define grace' broadcasts definition:show, and it auto-clears after the configured delay", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    definitionClearMs: 50, // short, for a fast test — not the real 12s default
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const shown = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Can you define grace for us?",
      state: "final",
      timestamp: Date.now(),
    })
    const shownMessage = await shown
    assert.equal(shownMessage.type, "definition:show")
    assert.deepEqual(shownMessage.payload, {
      term: "Grace",
      definition: "Unmerited favor from God — a gift given freely, not earned by good works.",
    })

    const cleared = waitForMessage(viewerSocket)
    const clearedMessage = await cleared
    assert.equal(clearedMessage.type, "definition:clear")

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a term not in the glossary broadcasts nothing", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
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
      correlationId: "01A",
      sequence: 1,
      text: "Define supercalifragilisticexpialidocious.",
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

// ARCHITECTURE.md section 65.3: auto-send vs. review-and-approve mode.
test("AppCore: in review mode, a detected verse broadcasts verse:pending, not verse:show", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    verseConfirmationMode: "review",
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const pending = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to John 3:16.",
      state: "final",
      timestamp: Date.now(),
    })
    const message = await pending
    assert.equal(message.type, "verse:pending")
    assert.deepEqual((message.payload as Verse).reference, { book: "john", chapter: 3, verse: 16 })

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: confirming a pending verse broadcasts verse:show with trigger 'detected'", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    verseConfirmationMode: "review",
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const pending = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to John 3:16.",
      state: "final",
      timestamp: Date.now(),
    })
    await pending

    const shown = waitForMessage(viewerSocket)
    operatorSocket.send(
      JSON.stringify({ id: "01B", type: "verse:confirm-pending", timestamp: Date.now(), payload: null })
    )
    const message = await shown
    assert.equal(message.type, "verse:show")
    assert.deepEqual(message.payload, {
      reference: { book: "john", chapter: 3, verse: 16 },
      text: 'text for {"book":"john","chapter":3,"verse":16}',
      translation: "kjv",
      source: "test",
      trigger: "detected",
    })

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a new pending detection replaces (not queues behind) an earlier unconfirmed one", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    verseConfirmationMode: "review",
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const firstPending = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to John 3:15.",
      state: "final",
      timestamp: Date.now(),
    })
    await firstPending

    const secondPending = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Turn to Romans 8:28.",
      state: "final",
      timestamp: Date.now(),
    })
    await secondPending

    const shown = waitForMessage(viewerSocket)
    operatorSocket.send(
      JSON.stringify({ id: "01C", type: "verse:confirm-pending", timestamp: Date.now(), payload: null })
    )
    const message = await shown
    // The confirmed verse is the SECOND (most recent) one, not the first.
    assert.deepEqual((message.payload as Verse).reference, { book: "romans", chapter: 8, verse: 28 })

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: confirming with nothing pending is a no-op, not a crash", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    verseConfirmationMode: "review",
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    let received = false
    viewerSocket.once("message", () => {
      received = true
    })

    operatorSocket.send(
      JSON.stringify({ id: "01A", type: "verse:confirm-pending", timestamp: Date.now(), payload: null })
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(received, false)
    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: setVerseConfirmationMode() switches modes live, without restarting the server", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    // starts in "auto" (the default)
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    app.setVerseConfirmationMode("review")

    const pending = waitForMessage(viewerSocket)
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Turn to John 3:16.",
      state: "final",
      timestamp: Date.now(),
    })
    const message = await pending
    assert.equal(message.type, "verse:pending")

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})
