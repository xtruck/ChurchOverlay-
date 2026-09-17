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
