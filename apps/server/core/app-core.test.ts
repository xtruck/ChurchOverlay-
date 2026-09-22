import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"
import { DEFAULT_VERSE_AUTO_CLEAR_MS, startAppCore } from "./app-core"
import { RateLimitError } from "../asr/groq-provider"
import { RegexDetector } from "../detector/regex-detector"
import { correctTranscription } from "../asr/transcription-corrector"
import { SilenceGate } from "../audio/silence-gate"
import { SessionHistoryStore } from "./session-history-store"
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
  private sustainedCallback: (() => void) | null = null

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
  onRateLimitedSustained(callback: () => void): void {
    this.sustainedCallback = callback
  }
  emitError(error: Error): void {
    this.errorCallback?.(error)
  }
  emitRateLimitedSustained(): void {
    this.sustainedCallback?.()
  }
  emitTranscript(result: TranscriptResult): void {
    this.transcriptCallback?.(result)
  }
}

class FakeFailoverAsrProvider extends FakeAsrProvider {
    private failoverCallback: (() => void) | null = null
    returnToPrimaryCalls = 0

    onFailoverActivated(callback: () => void): void {
      this.failoverCallback = callback
    }

    async returnToPrimary(): Promise<void> {
      this.returnToPrimaryCalls += 1
    }

    emitFailoverActivated(): void {
      this.failoverCallback?.()
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

// ARCHITECTURE.md section 70: every real transcript now also broadcasts a
// transcript:partial/transcript:final echo, unconditionally, before any of
// the semantic work (verse detection, media triggers, etc.) it's about to
// test even runs. Almost every test in this file's actual intent is "wait
// for the interesting event this action causes," not literally "the very
// next WS frame of any kind" — so both wait helpers below filter this
// echo out, keeping the other ~40 emitTranscript-driven tests correct in
// intent without individually rewriting each one. Tests for the echo
// itself use the raw socket "message" event directly, not these helpers.
//
// ARCHITECTURE.md section 82: onViewerConnected now ALSO unconditionally
// sends layout:update to every new connection (before any other resync
// content), for exactly the same reason transcript echoes needed
// filtering here — dozens of existing tests connect a fresh viewer and
// assert "the next/first message is X," and would otherwise all break on
// this new, unrelated-to-them first message. Tests for layout:update
// itself use the raw socket "message" event directly, same precedent.
function isTranscriptEcho(message: WsMessage): boolean {
  return message.type === "transcript:partial" || message.type === "transcript:final"
}

// broadcastAsrStatus() always attaches a live SilenceGate metrics snapshot
// to every status:update now; these tests never send an audio frame first,
// so it's always this all-zero shape.
const ZERO_AUDIO_METRICS = { framesReceived: 0, framesRejected: 0, framesForwarded: 0, averageRms: 0, maxRms: 0 }

function isAutoSyncNoise(message: WsMessage): boolean {
  return isTranscriptEcho(message) || message.type === "layout:update"
}

function waitForMessage(socket: WebSocket): Promise<WsMessage> {
  return new Promise((resolve) => {
    const handler = (data: { toString(): string }) => {
      const message = JSON.parse(data.toString())
      if (isAutoSyncNoise(message)) return
      socket.off("message", handler)
      resolve(message)
    }
    socket.on("message", handler)
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
      const message = JSON.parse(data.toString())
      if (isAutoSyncNoise(message)) return
      collected.push(message)
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

// ARCHITECTURE.md section 76: mic:start now triggers a brief ambient-
// noise calibration before any audio is actually forwarded — this is
// the end-to-end wiring test (SilenceGate's own unit tests already cover
// the calibration math itself), confirming AppCore actually starts it,
// broadcasts the in-progress status, forwards nothing while calibrating,
// and broadcasts the finished status with a real threshold once enough
// audio has accumulated.
test("AppCore: mic:start triggers calibration — nothing is forwarded to ASR until it finishes, and the dashboard is told both times", async () => {
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    silenceGate: new SilenceGate({ calibrationDurationMs: 10 }), // short, for a fast test
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const calibratingStarted = waitForMessage(viewerSocket)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "mic:start", timestamp: Date.now(), payload: null }))
    const startedMsg = await calibratingStarted
    assert.equal(startedMsg.type, "status:update")
    // ARCHITECTURE.md: broadcastAsrStatus() now always includes a live
    // audioMetrics snapshot from the SilenceGate alongside asrHealth, so
    // VAD starvation is diagnosable from the dashboard, not just server
    // logs. No frame has reached the gate yet at this point, so every
    // counter is zero.
    assert.deepEqual(startedMsg.payload, { asrHealth: "ok", micCalibrating: true, audioMetrics: ZERO_AUDIO_METRICS })

    // 10ms at 16kHz is a small handful of samples — one loud frame is
    // enough to finish calibration, but it must still be REJECTED (part
    // of the calibration measurement, not real speech being forwarded).
    const calibratingFinished = waitForMessage(viewerSocket)
    operatorSocket.send(
      encodeAudioFrame({ samples: Int16Array.from(new Array(200).fill(5000)), sampleRate: 16000, sequence: 1 })
    )
    const finishedMsg = await calibratingFinished
    assert.equal(finishedMsg.type, "status:update")
    const finishedPayload = finishedMsg.payload as { asrHealth: string; micCalibrating: boolean; micThreshold: number }
    assert.equal(finishedPayload.micCalibrating, false)
    assert.ok(finishedPayload.micThreshold > 0)
    assert.equal(asr.sentFrames.length, 0) // the calibration frame itself was never forwarded

    // A genuinely loud frame AFTER calibration finishes reaches the ASR normally.
    operatorSocket.send(
      encodeAudioFrame({ samples: Int16Array.from(new Array(160).fill(10000)), sampleRate: 16000, sequence: 2 })
    )
    await waitFor(() => asr.sentFrames.length === 1)

    operatorSocket.close()
    viewerSocket.close()
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
    // ARCHITECTURE.md section 82: layout:update is now sent unconditionally
    // on connect — expected noise here too, same reasoning as the
    // transcript-echo exclusions elsewhere in this file.
    let received = false
    viewerSocket.on("message", (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === "layout:update") return
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
    // ARCHITECTURE.md section 70: a transcript:final echo is now expected
    // and correct for every transcript, rejected or not (that's the whole
    // point of the fix — the operator sees what was heard regardless of
    // whether a verse was found in it). What this test actually asserts
    // is "no verse is shown," not "literally nothing is ever broadcast."
    let verseShown = false
    viewerSocket.on("message", (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === "verse:show") verseShown = true
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

    assert.equal(verseShown, false)
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

    test("AppCore: an active media cue auto-clears after its persisted duration", async () => {
      await withMediaLibrary(async (mediaLibrary, dir) => {
        const source = join(dir, "timed.png")
        await writeFile(source, "x")
        const cue = await mediaLibrary.import(source, "Timed Slide", "image")
        await mediaLibrary.setAutoClearDuration(cue.id, 30)

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
          const messages: WsMessage[] = []
          viewerSocket.on("message", (data) => {
            const message = JSON.parse(data.toString()) as WsMessage
            if (!isAutoSyncNoise(message)) messages.push(message)
          })
          operatorSocket.send(JSON.stringify({ id: "01TIMER", type: "media:select", timestamp: Date.now(), payload: { id: cue.id } }))
          await waitFor(() => messages.some((message) => message.type === "media:show"))
          await waitFor(() => messages.some((message) => message.type === "media:clear"))
          assert.equal(messages.filter((message) => message.type === "media:clear").length, 1)
          operatorSocket.close()
          viewerSocket.close()
        } finally {
          await app.stop()
        }
      })
    })

    test("AppCore: replacing or manually clearing media cancels the previous auto-clear timer", async () => {
      await withMediaLibrary(async (mediaLibrary, dir) => {
        const firstSource = join(dir, "first.png")
        const secondSource = join(dir, "second.png")
        await writeFile(firstSource, "x")
        await writeFile(secondSource, "y")
        const first = await mediaLibrary.import(firstSource, "First Slide", "image")
        const second = await mediaLibrary.import(secondSource, "Second Slide", "image")
        // A generous duration relative to the WS round-trip + waitFor
        // polling overhead below (a real race, not a mocked clock): under
        // heavy parallel test-suite load, the time between arming this
        // timer and the server processing the replacing media:select can
        // occasionally stretch well past a couple dozen ms, which
        // previously (40ms) made this test genuinely flaky rather than
        // actually catching a cancellation bug.
        await mediaLibrary.setAutoClearDuration(first.id, 300)
        await mediaLibrary.setAutoClearDuration(second.id, null)

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
          const messages: WsMessage[] = []
          viewerSocket.on("message", (data) => {
            const message = JSON.parse(data.toString()) as WsMessage
            if (!isAutoSyncNoise(message)) messages.push(message)
          })
          operatorSocket.send(JSON.stringify({ id: "01FIRST", type: "media:select", timestamp: Date.now(), payload: { id: first.id } }))
          await waitFor(() => messages.some((message) => message.type === "media:show"))
          operatorSocket.send(JSON.stringify({ id: "01SECOND", type: "media:select", timestamp: Date.now(), payload: { id: second.id } }))
          await waitFor(() => messages.filter((message) => message.type === "media:show").length === 2)
          await new Promise((resolve) => setTimeout(resolve, 150))
          assert.equal(messages.some((message) => message.type === "media:clear"), false)

          operatorSocket.send(JSON.stringify({ id: "01CLEAR", type: "media:clear", timestamp: Date.now(), payload: null }))
          await waitFor(() => messages.some((message) => message.type === "media:clear"))
          await new Promise((resolve) => setTimeout(resolve, 50))
          assert.equal(messages.filter((message) => message.type === "media:clear").length, 1)
          operatorSocket.close()
          viewerSocket.close()
        } finally {
          await app.stop()
        }
      })
    })
    try {
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      // ARCHITECTURE.md section 82: layout:update is now sent
      // unconditionally on connect — expected noise here too.
      let received = false
      viewerSocket.on("message", (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === "layout:update") return
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
      // ARCHITECTURE.md section 70: a transcript:partial echo is expected
      // here too (the raw text is always echoed, regardless of gating) —
      // what this test actually asserts is that media:show specifically
      // never fires for a partial transcript.
      let mediaShown = false
      viewerSocket.on("message", (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === "media:show") mediaShown = true
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

      assert.equal(mediaShown, false)
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
    // ARCHITECTURE.md section 70: a transcript:final echo is expected
    // here too — this test's actual assertion is that verse:show
    // specifically never fires with no prior verse position to advance
    // from.
    let verseShown = false
    viewerSocket.on("message", (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === "verse:show") verseShown = true
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

    assert.equal(verseShown, false)
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

    const messages = waitForMessages(viewerSocket, 5)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    const received = await messages
    const types = received.map((m) => m.type).sort()
    assert.deepEqual(types, ["announcement:clear", "canvas:clear", "media:clear", "rundown:state", "verse:clear"])

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

const SAMPLE_CANVAS_LAYERS = [
  {
    id: "01LAYER-BG",
    kind: "background" as const,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 0,
    color: "#0a0a12",
    mediaCueId: null,
    mediaKind: null,
  },
  {
    id: "01LAYER-TEXT",
    kind: "text" as const,
    x: 10,
    y: 40,
    width: 80,
    height: 20,
    zIndex: 1,
    text: "Welcome",
    fontFamily: "serif" as const,
    fontSizePx: 48,
    color: "#ffffff",
    align: "center" as const,
  },
]

// ARCHITECTURE.md section 66.4/66.7: activating a canvas scene broadcasts
// its layers exactly as authored, with no resolveVerse()/hallucination-
// guard involvement (invariant 23 — every layer here is operator-authored).
test("AppCore: activating a 'canvas' scene broadcasts rundown:state then canvas:show with the exact layer list", async () => {
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
      scenes: [{ kind: "canvas", canvas: { layers: SAMPLE_CANVAS_LAYERS } }],
    }

    const messages = waitForMessages(viewerSocket, 2)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    const [stateMessage, showMessage] = await messages

    assert.equal(stateMessage?.type, "rundown:state")
    assert.deepEqual(stateMessage?.payload, {
      rundownId: "01RUNDOWN",
      cursor: 0,
      scene: { kind: "canvas", canvas: { layers: SAMPLE_CANVAS_LAYERS } },
      interrupted: false,
    })
    assert.equal(showMessage?.type, "canvas:show")
    assert.deepEqual(showMessage?.payload, { layers: SAMPLE_CANVAS_LAYERS })

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// Invariant 24 regression test: a canvas scene must never survive
// underneath a subsequent blank scene.
test("AppCore: a 'blank' scene after a 'canvas' scene also broadcasts canvas:clear", async () => {
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
      scenes: [{ kind: "canvas", canvas: { layers: SAMPLE_CANVAS_LAYERS } }, { kind: "blank" }],
    }

    const loadMessages = waitForMessages(viewerSocket, 2)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    await loadMessages

    const nextMessages = waitForMessages(viewerSocket, 5)
    operatorSocket.send(JSON.stringify({ id: "01B", type: "scene:next", timestamp: Date.now(), payload: null }))
    const received = await nextMessages
    const types = received.map((m) => m.type).sort()
    assert.deepEqual(types, ["announcement:clear", "canvas:clear", "media:clear", "rundown:state", "verse:clear"])

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// The late-join/reconnect resync path (syncSceneContent) for a canvas
// scene — a newly-connecting viewer must see it immediately, direct-sent
// rather than broadcast (same pattern as every other non-media scene kind).
test("AppCore: a viewer connecting while a 'canvas' scene is active immediately receives a sync canvas:show", async () => {
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
    const firstViewer = await connect(app.wsServer.port, TOKENS.viewerToken)

    const rundown: Rundown = {
      id: "01RUNDOWN",
      title: "Sunday Service",
      scenes: [{ kind: "canvas", canvas: { layers: SAMPLE_CANVAS_LAYERS } }],
    }
    const loadMessages = waitForMessages(firstViewer, 2)
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    await loadMessages

    // A second viewer connects after the canvas scene is already active.
    // Deliberately NOT using the connect() helper here: it resolves only
    // after the "open" event fires, and the server sends its sync
    // messages as soon as it accepts the connection — possibly before
    // "open" is even processed client-side. Registering the message
    // listener via a raw WebSocket first (matching the existing
    // media-sync test's own pattern) avoids racing and missing them.
    const secondViewer = new WebSocket(`ws://127.0.0.1:${app.wsServer.port}`, [TOKENS.viewerToken])
    const syncMessages = waitForMessages(secondViewer, 2)
    const [syncState, syncShow] = await syncMessages
    assert.equal(syncState?.type, "rundown:state")
    assert.equal(syncShow?.type, "canvas:show")
    assert.deepEqual(syncShow?.payload, { layers: SAMPLE_CANVAS_LAYERS })

    operatorSocket.close()
    firstViewer.close()
    secondViewer.close()
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

// ARCHITECTURE.md production audit (section 74): a real, structural gap
// found alongside the interrupt case above — a verse shown OUTSIDE any
// rundown (no rundown loaded at all, the common live-service case) was
// never resynced to a reconnecting viewer, since the old code only ever
// checked lastShownVerse inside the rundown-interrupted branch. A
// dropped OBS/overlay WS connection reconnecting while a verse was
// showing would silently never see it again.
test("AppCore: a viewer connecting while a verse is showing with NO rundown loaded is still resynced with verse:show", async () => {
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
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const shown = waitForMessage(viewerSocket)
    operatorSocket.send(
      JSON.stringify({
        id: "01A",
        type: "verse:override",
        timestamp: Date.now(),
        payload: { book: "john", chapter: 3, verse: 16 },
      })
    )
    await shown

    // A late viewer connects while the verse is showing — no rundown was
    // ever loaded, so rundownController.currentState() is null.
    const lateViewer = new WebSocket(`ws://127.0.0.1:${app.wsServer.port}`, [TOKENS.viewerToken])
    const syncMessage = await waitForMessage(lateViewer)

    assert.equal(syncMessage.type, "verse:show")
    assert.deepEqual((syncMessage.payload as Verse).reference, { book: "john", chapter: 3, verse: 16 })

    operatorSocket.close()
    viewerSocket.close()
    lateViewer.close()
  } finally {
    await app.stop()
  }
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
    const loadMessages = waitForMessages(viewerSocket, 5)
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

  test("AppCore: normal ASR throttling is not an error and recovers without error-state semantics", async () => {
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

      const throttledMessage = waitForMessage(viewerSocket)
      asr.emitError(new RateLimitError("Transcription en pause", undefined, "throttling"))
      assert.deepEqual((await throttledMessage).payload, {
        asrHealth: "throttled",
        error: "Transcription en pause",
        audioMetrics: ZERO_AUDIO_METRICS,
      })

      const recoveryMessage = waitForMessage(viewerSocket)
      asr.emitTranscript({
        id: "01THROTTLED",
        correlationId: "01A",
        sequence: 1,
        text: "Welcome everyone.",
        state: "final",
        timestamp: Date.now(),
      })
      assert.deepEqual((await recoveryMessage).payload, { asrHealth: "ok", audioMetrics: ZERO_AUDIO_METRICS })

      const sustainedMessage = waitForMessage(viewerSocket)
      asr.emitRateLimitedSustained()
      assert.deepEqual((await sustainedMessage).payload, {
        asrHealth: "rate-limited",
        error: "Limite de débit Groq atteinte, envisagez une mise à jour du palier",
        audioMetrics: ZERO_AUDIO_METRICS,
      })

      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const errorMessage = waitForMessage(viewerSocket)
    asr.emitError(new Error("Groq connection lost"))
    const errorStatus = await errorMessage
    assert.equal(errorStatus.type, "status:update")
    assert.deepEqual(errorStatus.payload, { asrHealth: "error", error: "Groq connection lost", audioMetrics: ZERO_AUDIO_METRICS })

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
    assert.deepEqual(recoveryStatus.payload, { asrHealth: "ok", audioMetrics: ZERO_AUDIO_METRICS })

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

  test("AppCore: getDiagnostics returns safe operational state without secrets", async () => {
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
      asr.emitError(new RateLimitError("Transcription en pause", undefined, "throttling"))
      const diagnostics = app.getDiagnostics()
      assert.equal(diagnostics.asrHealth, "throttled")
      assert.equal(typeof diagnostics.generatedAt, "number")
      assert.equal(typeof diagnostics.silenceGate.framesReceived, "number")
      assert.equal(diagnostics.sessionEntries, 0)
      assert.equal(diagnostics.sessionHistoryEntries, 0)
      assert.equal("groqApiKey" in diagnostics, false)
      assert.equal("operatorToken" in diagnostics, false)
    } finally {
      await app.stop()
    }
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    // ARCHITECTURE.md section 70: a transcript:final echo is expected for
    // every transcript now — this test's actual assertion is that
    // status:update specifically never fires absent a prior ASR error.
    let statusUpdateReceived = false
    viewerSocket.on("message", (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === "status:update") statusUpdateReceived = true
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

    assert.equal(statusUpdateReceived, false)
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// ARCHITECTURE.md section 65.1: elliptical/continuation references.
test("AppCore: successful ASR failover is informational and manual return restores ok", async () => {
 const asr = new FakeFailoverAsrProvider()
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
   const failoverMessage = waitForMessage(viewerSocket)
   asr.emitFailoverActivated()
   assert.deepEqual((await failoverMessage).payload, {
     asrHealth: "failover",
     error: "Bascule automatique vers Deepgram active",
     audioMetrics: ZERO_AUDIO_METRICS,
   })

   const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
   const returnMessage = waitForMessage(viewerSocket)
   operatorSocket.send(JSON.stringify({
     id: "01RETURNPRIMARY",
     type: "asr:return-primary",
     timestamp: Date.now(),
     payload: null,
   }))
   assert.deepEqual((await returnMessage).payload, { asrHealth: "ok", audioMetrics: ZERO_AUDIO_METRICS })
   assert.equal(asr.returnToPrimaryCalls, 1)
   operatorSocket.close()
   viewerSocket.close()
 } finally {
   await app.stop()
 }
})

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
    // ARCHITECTURE.md section 70: a transcript:final echo is expected here
    // too — this test's actual assertion is that definition:show
    // specifically never fires for an unknown term.
    let definitionShown = false
    viewerSocket.on("message", (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === "definition:show") definitionShown = true
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

    assert.equal(definitionShown, false)
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
    // ARCHITECTURE.md section 82: layout:update is now sent
    // unconditionally on connect — expected noise here too.
    let received = false
    viewerSocket.on("message", (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === "layout:update") return
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

// ARCHITECTURE.md section 65.8: post-service content export.
test("AppCore: getSessionEntries() records every verse actually shown, regardless of trigger", async () => {
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

    // Detected.
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

    // Manual override.
    const secondShow = waitForMessage(viewerSocket)
    operatorSocket.send(
      JSON.stringify({
        id: "01B",
        type: "verse:override",
        timestamp: Date.now(),
        payload: { book: "romans", chapter: 8, verse: 28 },
      })
    )
    await secondShow

    const entries = app.getSessionEntries()
    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0]?.reference, { book: "john", chapter: 3, verse: 16 })
    assert.deepEqual(entries[1]?.reference, { book: "romans", chapter: 8, verse: 28 })
    assert.equal(typeof entries[0]?.timestamp, "number")

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// ARCHITECTURE.md section 79: the persistent, cross-restart counterpart
// to getSessionEntries() above — a real SessionHistoryStore against a
// temp dir (not a fake), the same "real integration, not a mock of our
// own code" discipline withMediaLibrary already uses elsewhere in this
// file.
test("AppCore: getSessionHistory() records every shown verse to the configured SessionHistoryStore, and survives via it independent of getSessionEntries()", async () => {
  const root = await mkdtemp(join(tmpdir(), "churchoverlay-appcore-history-test-"))
  try {
    const sessionHistoryStore = new SessionHistoryStore({ historyDir: root })
    const asr = new FakeAsrProvider()
    const app = await startAppCore({
      asr,
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new EchoVerseSource(),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      sessionHistoryStore,
    })
    try {
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
      const shown = waitForMessage(viewerSocket)
      asr.emitTranscript({
        id: "01T",
        correlationId: "01A",
        sequence: 1,
        text: "Turn to John 3:16.",
        state: "final",
        timestamp: Date.now(),
      })
      await shown
      // record() is fire-and-forget from showVerse()'s perspective — give
      // its own async file write a turn to actually land before asserting.
      await waitFor(() => app.getSessionHistory().length === 1)

      const history = app.getSessionHistory()
      assert.equal(history.length, 1)
      assert.deepEqual(history[0]?.reference, { book: "john", chapter: 3, verse: 16 })

      // Independently persisted — a FRESH store instance loading from the
      // same directory eventually sees it too, without going through
      // AppCore at all. Polled, not checked once immediately: the actual
      // disk write is fire-and-forget from showVerse()'s perspective (verse
      // display must never be blocked by it), while getSessionHistory()
      // above reflects the in-memory push that happens synchronously,
      // before that write has necessarily landed — checking once right
      // after would race the write itself.
      let reloadedCount = 0
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && reloadedCount !== 1) {
        const reloaded = new SessionHistoryStore({ historyDir: root })
        await reloaded.load()
        reloadedCount = reloaded.getEntries().length
        if (reloadedCount !== 1) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(reloadedCount, 1)

      viewerSocket.close()
    } finally {
      await app.stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("AppCore: getSessionHistory() is an empty array when no SessionHistoryStore is configured, not an error", async () => {
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
    assert.deepEqual(app.getSessionHistory(), [])
  } finally {
    await app.stop()
  }
})

/**
 * Named per AGENTS.md section 45 — a test double, not a real
 * SermonNotesGenerator (which would make a real Groq API call).
 */
class FakeSermonNotesGenerator {
  calls: string[] = []
  private response: string | Error = "- A point"

  setResponse(response: string | Error): void {
    this.response = response
  }

  async summarize(transcriptText: string): Promise<string> {
    this.calls.push(transcriptText)
    if (this.response instanceof Error) throw this.response
    return this.response
  }
}

// ARCHITECTURE.md section 65.7: AI sermon-notes copilot — a strictly
// separate, dashboard-only side channel gated by a live enable/disable
// flag, never touching the verse-detection pipeline.
test("AppCore: sermon notes stay off by default even with a generator configured — no summarize() call, no broadcast", async () => {
  const asr = new FakeAsrProvider()
  const generator = new FakeSermonNotesGenerator()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    sermonNotesGenerator: generator,
    sermonNotesIntervalMs: 30,
    // sermonNotesEnabled deliberately omitted — must default to off.
  })
  try {
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Today we are talking about grace and forgiveness.",
      state: "final",
      timestamp: Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(generator.calls.length, 0)
  } finally {
    await app.stop()
  }
})

test("AppCore: once enabled, sermon notes accumulate final-transcript text and broadcast sermonNotes:update on the configured cadence", async () => {
  const asr = new FakeAsrProvider()
  const generator = new FakeSermonNotesGenerator()
  generator.setResponse("- Grace is unmerited favor\n- Forgiveness is offered freely")
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    sermonNotesGenerator: generator,
    sermonNotesEnabled: true,
    sermonNotesIntervalMs: 30,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Today we are talking about grace.",
      state: "final",
      timestamp: Date.now(),
    })
    // A partial transcript must never reach the accumulated buffer
    // (same invariant every other detector already respects).
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Today we are talking about grace and forgi",
      state: "partial",
      timestamp: Date.now(),
    })
    asr.emitTranscript({
      id: "01T3",
      correlationId: "01C",
      sequence: 3,
      text: "And forgiveness is offered freely to all.",
      state: "final",
      timestamp: Date.now(),
    })

    const update = await waitForMessage(viewerSocket)
    assert.equal(update.type, "sermonNotes:update")
    assert.deepEqual(update.payload, {
      notes: "- Grace is unmerited favor\n- Forgiveness is offered freely",
    })
    assert.equal(generator.calls.length, 1)
    assert.equal(
      generator.calls[0],
      "Today we are talking about grace. And forgiveness is offered freely to all."
    )

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: an empty accumulated buffer never calls summarize(), and a failed cycle recovers cleanly on the next one", async () => {
  const asr = new FakeAsrProvider()
  const generator = new FakeSermonNotesGenerator()
  generator.setResponse(new Error("rate limited"))
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    sermonNotesGenerator: generator,
    sermonNotesEnabled: true,
    sermonNotesIntervalMs: 30,
  })
  try {
    // Nothing accumulated yet — the first cycle(s) must not call summarize().
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.equal(generator.calls.length, 0)

    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "A failing cycle should not crash anything.",
      state: "final",
      timestamp: Date.now(),
    })
    await waitFor(() => generator.calls.length === 1)

    // The failure must not affect mic/ASR/verse display: recover and
    // succeed cleanly on the very next cycle with fresh text.
    generator.setResponse("- Recovered")
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "New text after the failure.",
      state: "final",
      timestamp: Date.now(),
    })
    const update = await waitForMessage(viewerSocket)
    assert.equal(update.type, "sermonNotes:update")
    assert.deepEqual(update.payload, { notes: "- Recovered" })
    // The failed cycle's text must have been cleared, not retried
    // alongside the new text.
    assert.equal(generator.calls[1], "New text after the failure.")

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: setSermonNotesEnabled() is a live toggle — turning it on starts accumulating, turning it off discards the buffer", async () => {
  const asr = new FakeAsrProvider()
  const generator = new FakeSermonNotesGenerator()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    sermonNotesGenerator: generator,
    sermonNotesIntervalMs: 30,
  })
  try {
    // Off by default: accumulated text must be discarded, not queued.
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Said while disabled.",
      state: "final",
      timestamp: Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.equal(generator.calls.length, 0)

    app.setSermonNotesEnabled(true)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    asr.emitTranscript({
      id: "01T2",
      correlationId: "01B",
      sequence: 2,
      text: "Said after enabling.",
      state: "final",
      timestamp: Date.now(),
    })
    const update = await waitForMessage(viewerSocket)
    assert.equal(update.type, "sermonNotes:update")
    // Only the text spoken after enabling — "Said while disabled" must
    // not have been silently queued up and summarized once turned on.
    assert.equal(generator.calls[0], "Said after enabling.")

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// ARCHITECTURE.md section 67: Principal Poster & Verse Auto-Clear.

test("AppCore: poster:set with a real imported image cue broadcasts poster:show", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")

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
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )

      const message = await viewerReceived
      assert.equal(message.type, "poster:show")
      assert.deepEqual((message.payload as { cue: unknown }).cue, cue)
      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: poster:set with a non-image cue id is rejected — no broadcast", async () => {
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
      // ARCHITECTURE.md section 82: layout:update is now sent
      // unconditionally on connect — expected noise here too.
      let received = false
      viewerSocket.on("message", (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === "layout:update") return
        received = true
      })

      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
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

test("AppCore: poster:set with an unknown id is rejected — no broadcast", async () => {
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
      // ARCHITECTURE.md section 82: layout:update is now sent
      // unconditionally on connect — expected noise here too.
      let received = false
      viewerSocket.on("message", (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === "layout:update") return
        received = true
      })

      operatorSocket.send(
        JSON.stringify({
          id: "01A",
          type: "poster:set",
          timestamp: Date.now(),
          payload: { mediaCueId: "unknown-id" },
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
})

test("AppCore: poster:clear broadcasts poster:clear", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")

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

      const shown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await shown

      const cleared = waitForMessage(viewerSocket)
      operatorSocket.send(JSON.stringify({ id: "01B", type: "poster:clear", timestamp: Date.now(), payload: null }))
      const message = await cleared

      assert.equal(message.type, "poster:clear")
      assert.equal(message.payload, null)
      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

// ARCHITECTURE.md section 82.
test("AppCore: a new connection is synced with the current verse layout via layout:update, before anything else", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    verseLayout: "lower-third",
  })
  try {
    const viewerSocket = new WebSocket(`ws://127.0.0.1:${app.wsServer.port}`, [TOKENS.viewerToken])
    const message = await new Promise<WsMessage>((resolve) => {
      viewerSocket.once("message", (data: { toString(): string }) => resolve(JSON.parse(data.toString())))
    })
    assert.equal(message.type, "layout:update")
    assert.deepEqual(message.payload, { layout: "lower-third" })
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: layout:set from the operator broadcasts layout:update and calls onVerseLayoutChanged", async () => {
  const changes: string[] = []
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    onVerseLayoutChanged: (layout) => changes.push(layout),
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const update = new Promise<WsMessage>((resolve) => {
      viewerSocket.once("message", (data: { toString(): string }) => resolve(JSON.parse(data.toString())))
    })
    operatorSocket.send(
      JSON.stringify({ id: "01A", type: "layout:set", timestamp: Date.now(), payload: { layout: "lower-third" } })
    )
    const message = await update

    assert.equal(message.type, "layout:update")
    assert.deepEqual(message.payload, { layout: "lower-third" })
    assert.deepEqual(changes, ["lower-third"])

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: poster:set-duration auto-clears the poster after the configured delay, and a new poster:set resets the countdown", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")

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

      operatorSocket.send(
        JSON.stringify({
          id: "01A",
          type: "poster:set-duration",
          timestamp: Date.now(),
          payload: { durationMs: 50 },
        })
      )

      const shown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01B", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await shown

      const autoCleared = await waitForMessage(viewerSocket)
      assert.equal(autoCleared.type, "poster:clear")

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: with no poster:set-duration configured, a poster never auto-clears (manual-only default)", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")

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

      const shown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await shown

      let clearReceived = false
      const listener = (data: { toString(): string }) => {
        const message = JSON.parse(data.toString())
        if (message.type === "poster:clear") clearReceived = true
      }
      viewerSocket.on("message", listener)
      await new Promise((resolve) => setTimeout(resolve, 80))
      viewerSocket.off("message", listener)
      assert.equal(clearReceived, false)

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a viewer connecting while a principal poster is active immediately receives a sync poster:show", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")

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
      const shown = waitForMessage(firstViewer)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await shown
      firstViewer.close()

      // Deliberately not `await connect(...)` here: the server sends the
      // sync message the instant it accepts the connection, which can be
      // before this socket's own "open" event fires. Constructing it
      // directly and attaching the message listener synchronously (same
      // pattern as the media:show sync test above) guarantees the
      // listener is in place before any data could possibly arrive —
      // awaiting "open" first would introduce a race that can drop it.
      const lateViewer = new WebSocket(`ws://127.0.0.1:${app.wsServer.port}`, [TOKENS.viewerToken])
      const message = await waitForMessage(lateViewer)

      assert.equal(message.type, "poster:show")
      assert.deepEqual((message.payload as { cue: unknown }).cue, cue)
      operatorSocket.close()
      lateViewer.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a verse shown while a principal poster is active auto-clears after the configured delay", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")
    const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "For God so loved the world...")

    const app = await startAppCore({
      asr: new FakeAsrProvider(),
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new StubVerseSource({ john: johnVerse }),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
      verseAutoClearMs: 50, // short, for a fast test — not the real 2-minute default
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const posterShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await posterShown

      const verseShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({
          id: "01B",
          type: "verse:override",
          timestamp: Date.now(),
          payload: { book: "john", chapter: 3, verse: 16 },
        })
      )
      const shownMessage = await verseShown
      assert.equal(shownMessage.type, "verse:show")

      // No operator action clears this — the server does it on its own,
      // unprompted, so the poster underneath reappears.
      const autoCleared = await waitForMessage(viewerSocket)
      assert.equal(autoCleared.type, "verse:clear")

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a second verse shown before the auto-clear timer fires resets the countdown rather than stacking", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")

    const app = await startAppCore({
      asr: new FakeAsrProvider(),
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new EchoVerseSource(),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
      verseAutoClearMs: 80,
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const posterShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await posterShown

      const firstShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({
          id: "01B",
          type: "verse:override",
          timestamp: Date.now(),
          payload: { book: "john", chapter: 3, verse: 16 },
        })
      )
      await firstShown

      // Well inside the first verse's 80ms window.
      await new Promise((resolve) => setTimeout(resolve, 40))

      const secondShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({
          id: "01C",
          type: "verse:override",
          timestamp: Date.now(),
          payload: { book: "john", chapter: 3, verse: 17 },
        })
      )
      await secondShown
      const secondShownAt = Date.now()

      const clearedMessage = await waitForMessage(viewerSocket)
      assert.equal(clearedMessage.type, "verse:clear")
      // If the first verse's timer had kept running unreset, it would
      // have fired ~40ms after the second verse (80ms after the first).
      // A properly reset timer fires ~80ms after the SECOND verse instead.
      const elapsedSinceSecondShow = Date.now() - secondShownAt
      assert.ok(
        elapsedSinceSecondShow >= 65,
        `expected the timer to reset to the second verse's own window, got ${elapsedSinceSecondShow}ms`
      )

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: correctTranscription is wired into the transcript pipeline — 'V.C.' hallucination reaches the dashboard as 'verset'", async () => {
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

    // Collect the transcript:final broadcast on the raw socket. This is the
    // operator-dashboard echo (ARCHITECTURE.md section 70) and, crucially, it
    // is the SAME corrected text every downstream detector now consumes.
    let finalText: string | null = null
    viewerSocket.on("message", (data) => {
      const message: WsMessage = JSON.parse(data.toString())
      if (message.type === "transcript:final") {
        finalText = (message.payload as { text: string }).text ?? null
      }
    })

    // Production hallucination observed in agent-transcripts / sermon-notes
    // buffer: "verset" was regularly ASR-transcribed as "V.C." (6 of 34
    // transcripts in one service). Without the fix, this raw text reaches
    // the broadcast — and every detector — unchanged.
    asr.emitTranscript({
      id: "01T",
      correlationId: "01CORRC",
      sequence: 1,
      text: "le V.C. 6",
      state: "final",
      timestamp: Date.now(),
    })

    await waitFor(() => finalText !== null)

    // The broadcast text must equal EXACTLY what correctTranscription()
    // produces — i.e. the correction is applied before the text reaches any
    // consumer (dashboard, detectors, near-miss log).
    const expected = correctTranscription("le V.C. 6").correctedText
    assert.equal(finalText, expected)
    // The raw, uncorrected hallucination token must never be present.
    assert.ok(
      !String(finalText).includes("V.C."),
      `expected the 'V.C.' hallucination to be corrected away, got ${finalText}`
    )

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a manual verse:clear before the auto-clear timer fires cancels it — no later spurious clear", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")

    const app = await startAppCore({
      asr: new FakeAsrProvider(),
      detector: new RegexDetector(),
      index: new KnownValidVerseIndex(),
      source: new EchoVerseSource(),
      logger: silentLogger(),
      port: 0,
      tokens: TOKENS,
      mediaLibrary,
      verseAutoClearMs: 60,
    })
    try {
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const posterShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await posterShown

      const verseShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({
          id: "01B",
          type: "verse:override",
          timestamp: Date.now(),
          payload: { book: "john", chapter: 3, verse: 16 },
        })
      )
      await verseShown

      const manualClear = waitForMessage(viewerSocket)
      operatorSocket.send(JSON.stringify({ id: "01C", type: "verse:clear", timestamp: Date.now(), payload: null }))
      const manualClearMessage = await manualClear
      assert.equal(manualClearMessage.type, "verse:clear")

      // Past the 60ms window the (now-cancelled) auto-clear would have
      // fired at — a second, spurious verse:clear here means the manual
      // clear failed to cancel the timer.
      let secondClearReceived = false
      const listener = (data: { toString(): string }) => {
        const message = JSON.parse(data.toString()) as WsMessage
        if (message.type === "verse:clear") secondClearReceived = true
      }
      viewerSocket.on("message", listener)
      await new Promise((resolve) => setTimeout(resolve, 90))
      viewerSocket.off("message", listener)
      assert.equal(secondClearReceived, false)

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: a verse shown with no principal poster configured still auto-clears after the configured delay (section 82.1 — unconditional, not poster-gated)", async () => {
  const app = await startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    verseAutoClearMs: 40,
  })

  test("AppCore: the default verse auto-clear ceiling is exactly 2 minutes 30 seconds", () => {
    assert.equal(DEFAULT_VERSE_AUTO_CLEAR_MS, 2 * 60 * 1000 + 30 * 1000)
  })
  try {
    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    const verseShown = waitForMessage(viewerSocket)
    operatorSocket.send(
      JSON.stringify({
        id: "01A",
        type: "verse:override",
        timestamp: Date.now(),
        payload: { book: "john", chapter: 3, verse: 16 },
      })
    )
    await verseShown

    const autoCleared = await waitForMessage(viewerSocket)
    assert.equal(autoCleared.type, "verse:clear")

    operatorSocket.close()
    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: speaking a poster-marked cue's title re-shows it as poster:show, not media:show", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "poster.png")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Sunday Service Poster", "image")
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
      const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
      const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

      const posterShown = waitForMessage(viewerSocket)
      operatorSocket.send(
        JSON.stringify({ id: "01A", type: "poster:set", timestamp: Date.now(), payload: { mediaCueId: cue.id } })
      )
      await posterShown

      // Simulates it having been covered by other content, and someone
      // later speaking its name to bring it back — the exact scenario the
      // voice-trigger amendment (section 67.1) was requested for.
      const spokenAgain = waitForMessage(viewerSocket)
      asr.emitTranscript({
        id: "01T",
        correlationId: "01B",
        sequence: 1,
        text: "Let's put up the Sunday Service Poster now.",
        state: "final",
        timestamp: Date.now(),
      })
      const message = await spokenAgain

      assert.equal(message.type, "poster:show")
      assert.deepEqual((message.payload as { cue: unknown }).cue, cue)

      operatorSocket.close()
      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

test("AppCore: speaking a cue's title that was never appointed as a poster still triggers ordinary media:show", async () => {
  await withMediaLibrary(async (mediaLibrary, dir) => {
    const source = join(dir, "clip.mp4")
    await writeFile(source, "x")
    const cue = await mediaLibrary.import(source, "Welcome Video", "video")
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
      const shown = waitForMessage(viewerSocket)

      asr.emitTranscript({
        id: "01T",
        correlationId: "01A",
        sequence: 1,
        text: "Let's roll the Welcome Video.",
        state: "final",
        timestamp: Date.now(),
      })
      const message = await shown

      assert.equal(message.type, "media:show")
      assert.deepEqual((message.payload as { cue: unknown }).cue, cue)

      viewerSocket.close()
    } finally {
      await app.stop()
    }
  })
})

// TASK 0: near-miss log should NOT fire when BOOK_CHAPTER_VERSE_PATTERN
// successfully matches. This test verifies that a transcript containing
// chapter/verse keywords that successfully matches the new pattern does
// NOT produce a "detector.near-miss" log event.
test("AppCore: near-miss log does NOT fire when BOOK_CHAPTER_VERSE_PATTERN matches", async () => {
  const lines: unknown[] = []
  const logger = new Logger({ minLevel: "warn", write: (line) => lines.push(JSON.parse(line)) })
  const johnVerse = makeVerse({ book: "john", chapter: 3, verse: 16 }, "For God so loved the world...")
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({ john: johnVerse }),
    logger,
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)
    const shown = waitForMessage(viewerSocket)

    // This transcript contains "chapitre" and "verset" keywords but should
    // match BOOK_CHAPTER_VERSE_PATTERN and produce a verse:show, NOT a
    // detector.near-miss log event.
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Jean chapitre 3 verset 16",
      state: "final",
      timestamp: Date.now(),
    })

    await shown
    await new Promise((resolve) => setTimeout(resolve, 10))

    const nearMissLogs = lines.filter((l) => (l as { event: string }).event === "detector.near-miss")
    assert.equal(nearMissLogs.length, 0, "near-miss should not fire when pattern matches successfully")

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})

// TASK 0: near-miss log SHOULD fire when chapter/verse keywords are present
// but NO pattern matches (e.g., malformed reference that doesn't match any
// pattern and doesn't resolve to a valid verse).
test("AppCore: near-miss log fires when chapter/verse keywords present but no pattern matches", async () => {
  const lines: unknown[] = []
  const logger = new Logger({ minLevel: "warn", write: (line) => lines.push(JSON.parse(line)) })
  const asr = new FakeAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new StubVerseSource({}),
    logger,
    port: 0,
    tokens: TOKENS,
  })
  try {
    const viewerSocket = await connect(app.wsServer.port, TOKENS.viewerToken)

    // This transcript contains "chapitre" and "verset" but "frogs" is not
    // a valid book, so no pattern should match and no verse should be shown.
    asr.emitTranscript({
      id: "01T",
      correlationId: "01A",
      sequence: 1,
      text: "Ouvrons Frogs chapitre 3 verset 16",
      state: "final",
      timestamp: Date.now(),
    })

    // Wait a bit for processing
    await new Promise((resolve) => setTimeout(resolve, 50))

    const nearMissLogs = lines.filter((l) => (l as { event: string }).event === "detector.near-miss")
    assert.equal(nearMissLogs.length, 1, "near-miss should fire when keywords present but no match")

    viewerSocket.close()
  } finally {
    await app.stop()
  }
})
