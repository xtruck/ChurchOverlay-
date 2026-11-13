import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { startAppCore } from "./app-core"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { Logger } from "../../../packages/shared/logger"
import type { AsrProvider, AudioFrame, TranscriptResult, Verse, VerseReference, VerseSource, WsMessage } from "../../../packages/contracts"

// Regression suite for the owner's bug report: the operator says "John 11 verse 12", the ASR cuts the
// utterance as "... verse 1" | "2", and the overlay showed John 11:1 without consent. A reference whose
// trailing number could still grow must wait for a short settle window; a later fragment that completes
// the number must replace the truncated one BEFORE anything reaches the overlay.

const TOKENS = { operatorToken: "op-token", viewerToken: "viewer-token" }
const SETTLE_MS = 300

class FakeAsr implements AsrProvider {
  private cb: ((r: TranscriptResult) => void) | null = null
  async start(): Promise<void> {}
  async sendAudio(_a: AudioFrame): Promise<void> {}
  async stop(): Promise<void> {}
  onTranscript(cb: (r: TranscriptResult) => void): void {
    this.cb = cb
  }
  onError(): void {}
  say(text: string, state: "final" | "partial" = "final"): void {
    seq += 1
    this.cb?.({ id: `T${seq}`, correlationId: `C${seq}`, sequence: seq, text, state, timestamp: Date.now() })
  }
}
let seq = 0

class EchoSource implements VerseSource {
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    return { reference, text: `text ${reference.book} ${reference.chapter}:${reference.verse}`, translation: "kjv", source: "test" }
  }
}

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

class FakeClock {
  private time = 0
  private nextId = 0
  private readonly scheduled = new Map<number, { readonly at: number; readonly callback: () => void }>()
  readonly timers = {
    now: () => this.time,
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++this.nextId
      this.scheduled.set(id, { at: this.time + ms, callback })
      return id
    },
    clearTimeout: (handle: unknown) => {
      if (typeof handle === "number") this.scheduled.delete(handle)
    },
  }

  tick(ms: number): void {
    const target = this.time + ms
    while (true) {
      const next = [...this.scheduled.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, timer] = next
      this.scheduled.delete(id)
      this.time = timer.at
      timer.callback()
    }
    this.time = target
  }
}

async function flushEvents(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function harness(mode?: "review") {
  const asr = new FakeAsr()
  const clock = new FakeClock()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoSource(),
    logger: new Logger({ write: () => {} }),
    port: 0,
    tokens: TOKENS,
    referenceSettleMs: SETTLE_MS,
    timers: clock.timers,
    ...(mode ? { verseConfirmationMode: mode } : {}),
  })
  const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
  const shown: string[] = []
  const pending: string[] = []
  viewer.on("message", (data: { toString(): string }) => {
    const m = JSON.parse(data.toString()) as WsMessage
    const v = m.payload as Verse
    if (m.type === "verse:show") shown.push(`${v.reference.book} ${v.reference.chapter}:${v.reference.verse}`)
    if (m.type === "verse:pending") pending.push(`${v.reference.book} ${v.reference.chapter}:${v.reference.verse}`)
  })
  // S-01: pending verses are operator-only now; the overlay (viewer) only ever sees verse:show.
  const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
  operatorSocket.on("message", (data: { toString(): string }) => {
    const m = JSON.parse(data.toString()) as WsMessage
    const v = m.payload as Verse
    if (m.type === "verse:pending") pending.push(`${v.reference.book} ${v.reference.chapter}:${v.reference.verse}`)
  })
  return { asr, app, viewer, operatorSocket, shown, pending, clock }
}

async function run(fn: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>, mode?: "review"): Promise<void> {
  const h = await harness(mode)
  try {
    await fn(h)
  } finally {
    h.viewer.close()
    h.operatorSocket.close()
    await h.app.stop()
  }
}

test("settle: English 'verse 1' | '2' chunk split shows John 11:12, never John 11:1", () =>
  run(async ({ asr, shown }) => {
    asr.say("Turn with me to John 11 verse 1")
    await flushEvents()
    assert.deepEqual(shown, [], "a verse that may still grow must not reach the overlay yet")
    asr.say("2")
    await flushEvents()
    assert.deepEqual(shown, ["john 11:12"])
  }))

test("settle: French 'verset 1' | '2.' chunk split shows Jean 11:12 only", () =>
  run(async ({ asr, shown }) => {
    asr.say("Ouvrez vos Bibles dans Jean chapitre 11 verset 1")
    await flushEvents()
    asr.say("2.")
    await flushEvents()
    assert.deepEqual(shown, ["john 11:12"])
  }))

test("settle: compact colon form 'John 11:1' | '2' is completed too", () =>
  run(async ({ asr, shown }) => {
    asr.say("John 11:1")
    await flushEvents()
    asr.say("2")
    await flushEvents()
    assert.deepEqual(shown, ["john 11:12"])
  }))

test("settle: a three-way split 'verse' | '1' | '2' (assembler path) still ends on John 11:12", () =>
  run(async ({ asr, shown }) => {
    asr.say("John 11 verse")
    await flushEvents()
    asr.say("1")
    await flushEvents()
    asr.say("2")
    await flushEvents()
    assert.deepEqual(shown, ["john 11:12"])
  }))

test("settle: when nothing completes the number the held verse is shown after the settle window", () =>
  run(async ({ asr, shown, clock }) => {
    asr.say("Turn to John 11 verse 1")
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    assert.deepEqual(shown, ["john 11:1"])
  }))

test("settle: an unrelated next sentence flushes the held verse once, and is not merged into it", () =>
  run(async ({ asr, shown }) => {
    asr.say("Turn to John 11 verse 1")
    await flushEvents()
    asr.say("Let us read it together")
    await flushEvents()
    assert.deepEqual(shown, ["john 11:1"])
  }))

test("settle: a verse that cannot grow (John 3:16, John 11:12) is shown immediately, no added latency", () =>
  run(async ({ asr, shown }) => {
    asr.say("Jean 3 verset 16")
    await flushEvents()
    assert.deepEqual(shown, ["john 3:16"])
    asr.say("John 11 verse 12")
    await flushEvents()
    assert.deepEqual(shown, ["john 3:16", "john 11:12"])
  }))

test("settle: a later fragment never replaces an already-correct display", () =>
  run(async ({ asr, shown }) => {
    asr.say("John 11 verse 12")
    await flushEvents()
    asr.say("2")
    asr.say("1")
    await flushEvents()
    assert.deepEqual(shown, ["john 11:12"])
  }))

test("settle: a completion that makes the verse invalid is not merged; the original is kept", () =>
  run(async ({ asr, shown, clock }) => {
    asr.say("John 11 verse 1")
    await flushEvents()
    asr.say("99")
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    assert.deepEqual(shown, ["john 11:1"])
  }))

test("settle: a numbered book right after the held verse is not swallowed as its completion", () =>
  run(async ({ asr, shown }) => {
    asr.say("John 11 verse 1")
    await flushEvents()
    asr.say("2 Corinthians 5 verse 17")
    await flushEvents()
    assert.deepEqual(shown.sort(), ["2 corinthians 5:17", "john 11:1"].sort())
  }))

test("settle: partial transcripts never trigger or complete a held reference", () =>
  run(async ({ asr, shown }) => {
    asr.say("John 11 verse 1", "partial")
    asr.say("John 11 verse 12", "partial")
    await flushEvents()
    assert.deepEqual(shown, [])
  }))

test("settle: in review mode the completed reference becomes the pending suggestion, never the truncated one", () =>
  run(async ({ asr, shown, pending }) => {
    asr.say("John 11 verse 1")
    await flushEvents()
    asr.say("2")
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, ["john 11:12"])
  }, "review"))

test("settle: an operator Clear during the settle window cancels the held verse", () =>
  run(async ({ asr, app, shown, clock }) => {
    // Connect first: opening the socket under load can outlast the settle window.
    const op = await connect(app.wsServer.port, TOKENS.operatorToken)
    asr.say("John 11 verse 1")
    await flushEvents()
    op.send(JSON.stringify({ id: "x", type: "verse:clear", timestamp: Date.now(), payload: null }))
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    op.close()
    assert.deepEqual(shown, [])
  }))

// ---- chapter-only mentions and bare "verse N" continuations (navigation path) ----

test("nav: 'John 11' | 'verse 12' chunk split offers John 11:12 without showing an unconfirmed verse", () =>
  run(async ({ asr, shown, pending }) => {
    asr.say("Turn with me to John 11")
    await flushEvents()
    asr.say("verse 12")
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, ["john 11:1", "john 11:12"])
  }))

test("nav: a chapter-only mention ('In John 11 we read about Lazarus') is only offered, never shown", () =>
  run(async ({ asr, shown, pending, clock }) => {
    asr.say("In John 11 we read about Lazarus")
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, ["john 11:1"])
  }))

test("nav: French 'Jean chapitre 11' | 'verset 1' | '2' offers Jean 11:12, nothing is shown unconfirmed", () =>
  run(async ({ asr, shown, pending }) => {
    asr.say("Jean chapitre 11")
    await flushEvents()
    asr.say("verset 1")
    await flushEvents()
    asr.say("2")
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, ["john 11:1", "john 11:12"])
  }))

test("nav: a split chapter number 'Jean 1' | '1' offers John 11:1, never John 1:1", () =>
  run(async ({ asr, shown, pending, clock }) => {
    asr.say("Ouvrons dans Jean 1")
    await flushEvents()
    asr.say("1")
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, ["john 11:1"])
  }))

test("nav: Genesis chapter 1 followed by verse 5 is pending for operator confirmation", () =>
  run(async ({ asr, operatorSocket, viewer, shown, pending, clock }) => {
    asr.say("Genesis chapter 1")
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    asr.say("verse 5")
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, ["genesis 1:1", "genesis 1:5"])

    const confirmedMessage = new Promise<WsMessage>((resolve) => {
      viewer.once("message", (data: { toString(): string }) => resolve(JSON.parse(data.toString()) as WsMessage))
    })
    operatorSocket.send(JSON.stringify({ id: "confirm-context-verse", type: "verse:confirm-pending", timestamp: Date.now(), payload: null }))
    const message = await confirmedMessage
    assert.equal(message.type, "verse:show")
    assert.deepEqual((message.payload as Verse).reference, { book: "genesis", chapter: 1, verse: 5 })
    assert.deepEqual(shown, ["genesis 1:5"])
  }))

test("nav: a verse following a separately announced French chapter is also pending", () =>
  run(async ({ asr, shown, pending, clock }) => {
    asr.say("Dans Jean chapitre 3")
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    asr.say("verset 16")
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, ["john 3:1", "john 3:16"])
  }))

test("nav: a chapter heard only in a partial transcript cannot seed a verse suggestion", () =>
  run(async ({ asr, shown, pending }) => {
    asr.say("Genesis chapter 1", "partial")
    await flushEvents()
    asr.say("verse 5")
    await flushEvents()
    assert.deepEqual(shown, [])
    assert.deepEqual(pending, [])
  }))

// ---- review fix round: only a BARE number completes a held verse ----

test("settle: 'In Genesis 1 verse 1' + '3 things I want to say' keeps Genesis 1:1 (never 1:13)", () =>
  run(async ({ asr, shown }) => {
    asr.say("In Genesis 1 verse 1")
    await flushEvents()
    asr.say("3 things I want to say")
    await flushEvents()
    assert.deepEqual(shown, ["genesis 1:1"])
  }))

test("settle: 'Jean 3 verset 1.' + '2 choses à retenir' keeps Jean 3:1 (never 3:12)", () =>
  run(async ({ asr, shown }) => {
    asr.say("Jean 3 verset 1.")
    await flushEvents()
    asr.say("2 choses à retenir")
    await flushEvents()
    assert.deepEqual(shown, ["john 3:1"])
  }))

test("settle: 'Romans 8 verse 1' + '1 minute' keeps Romans 8:1", () =>
  run(async ({ asr, shown }) => {
    asr.say("Romans 8 verse 1")
    await flushEvents()
    asr.say("1 minute")
    await flushEvents()
    assert.deepEqual(shown, ["romans 8:1"])
  }))

test("settle: bare '2.' completes 'Jean 11 verset 1.' and bare '3' completes 'John 12 verse 1' (legitimate splits)", () =>
  run(async ({ asr, shown }) => {
    asr.say("Jean 11 verset 1.")
    await flushEvents()
    asr.say("2.")
    await flushEvents()
    asr.say("John 12 verse 1")
    await flushEvents()
    asr.say("3")
    await flushEvents()
    assert.deepEqual(shown, ["john 11:12", "john 12:13"])
  }))

test("settle: an operator Clear during the window is logged as verse.settle-dropped", async () => {
  const lines: string[] = []
  const asr = new FakeAsr()
  const clock = new FakeClock()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoSource(),
    logger: new Logger({ write: (l: string) => void lines.push(l) }),
    port: 0,
    tokens: TOKENS,
    referenceSettleMs: SETTLE_MS,
    timers: clock.timers,
  })
  try {
    asr.say("John 11 verse 1")
    await flushEvents()
    const op = await connect(app.wsServer.port, TOKENS.operatorToken)
    op.send(JSON.stringify({ id: "x", type: "verse:clear", timestamp: Date.now(), payload: null }))
    await flushEvents()
    clock.tick(SETTLE_MS)
    await flushEvents()
    op.close()
    assert.ok(lines.some((l) => l.includes("verse.settle-dropped") && l.includes("operator-clear")))
  } finally {
    await app.stop()
  }
})
