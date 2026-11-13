import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { startAppCore } from "./app-core"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { Logger } from "../../../packages/shared/logger"
import type { AsrProvider, AudioFrame, TranscriptResult, Verse, VerseReference, VerseSource, WsMessage } from "../../../packages/contracts"

const TOKENS = { operatorToken: "op-token", viewerToken: "viewer-token" }

class FakeAsr implements AsrProvider {
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  async start(): Promise<void> {}
  async sendAudio(_audio: AudioFrame): Promise<void> {}
  async stop(): Promise<void> {}
  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }
  onError(_callback: (error: Error) => void): void {}
  emit(text: string, state: "final" | "partial" = "final"): void {
    this.transcriptCallback?.({ id: "01T", correlationId: "01A", sequence: 1, text, state, timestamp: Date.now() })
  }
}

class EchoVerseSource implements VerseSource {
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    return { reference, text: `text for ${reference.book} ${reference.chapter}:${reference.verse}`, translation: "kjv", source: "test" }
  }
}

class FailingVerseSource implements VerseSource {
  calls = 0
  constructor(private readonly mode: "throw" | "null") {}
  async getVerse(_reference: VerseReference): Promise<Verse | null> {
    this.calls += 1
    if (this.mode === "throw") throw new Error("source down")
    return null
  }
}

type Capture = { socket: WebSocket; received: WsMessage[] }

function connect(port: number, token: string): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    const received: WsMessage[] = []
    socket.on("message", (data) => received.push(JSON.parse(data.toString())))
    socket.once("open", () => resolve({ socket, received }))
    socket.once("error", reject)
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor() timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
const typesOf = (c: Capture) => c.received.map((m) => m.type)
const send = (c: Capture, type: string, payload: unknown = null) =>
  c.socket.send(JSON.stringify({ id: `id-${Math.random()}`, type, timestamp: Date.now(), payload }))

function silentLogger(lines?: Array<Record<string, unknown>>): Logger {
  return new Logger({ minLevel: "info", write: (line) => lines?.push(JSON.parse(line)) })
}

async function start(
  asr: FakeAsr,
  options: Partial<Parameters<typeof startAppCore>[0]> = {},
) {
  return startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSource(),
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    referenceSettleMs: 0,
    ...options,
  })
}

// ---------------------------------------------------------------- TS-06
test("TS-06: 'constructor 3:16' and prototype-member words never throw out of the transcript callback", async () => {
  const asr = new FakeAsr()
  const app = await start(asr)
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.doesNotThrow(() => asr.emit(`${word} 3:16`), word)
      assert.doesNotThrow(() => asr.emit(`Lisons ${word} chapitre 3 verset 16 maintenant`), word)
    }
    await settle()
    // The pipeline still works afterwards, and nothing bogus was shown.
    asr.emit("Turn to John 3:16.")
    await waitFor(() => typesOf(operator).includes("verse:show"))
    const shows = operator.received.filter((m) => m.type === "verse:show")
    assert.equal(shows.length, 1)
    assert.deepEqual((shows[0]?.payload as Verse).reference, { book: "john", chapter: 3, verse: 16 })
    operator.socket.close()
  } finally {
    await app.stop()
  }
})

test("TS-06: a detector that throws is caught and logged inside the transcript callback; the next transcript still works", async () => {
  const lines: Array<Record<string, unknown>> = []
  let explode = true
  const base = new RegexDetector()
  const detector = {
    detect(text: string) {
      if (explode) throw new Error("detector blew up")
      return base.detect(text)
    },
  }
  const asr = new FakeAsr()
  const app = await start(asr, { detector, logger: silentLogger(lines) })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    assert.doesNotThrow(() => asr.emit("Turn to John 3:16."))
    assert.ok(lines.some((l) => l.event === "transcript.handler-failed"), "the failure is logged")
    explode = false
    asr.emit("Turn to John 3:16.")
    await waitFor(() => typesOf(operator).includes("verse:show"))
    operator.socket.close()
  } finally {
    await app.stop()
  }
})

// ---------------------------------------------------------------- TS-08
test("TS-08: bare compact 'Name N M' is a pending suggestion in AUTO mode, never auto-shown; confirming shows it (FR)", async () => {
  const asr = new FakeAsr()
  const app = await start(asr, { verseConfirmationMode: "auto" })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    asr.emit("il y avait Jean 5 6 qui")
    await waitFor(() => typesOf(operator).includes("verse:pending"))
    await settle(300)
    const pending = operator.received.find((m) => m.type === "verse:pending")?.payload as Verse & { heard?: string }
    assert.deepEqual(pending.reference, { book: "john", chapter: 5, verse: 6 })
    assert.match(pending.heard ?? "", /Jean 5 6/, "the dashboard gets the heard text")
    assert.equal(typesOf(operator).includes("verse:show"), false, "never auto-shown")
    assert.equal(typesOf(viewer).includes("verse:show"), false, "the overlay shows nothing")
    send(operator, "verse:confirm-pending")
    await waitFor(() => typesOf(viewer).includes("verse:show"))
    operator.socket.close()
    viewer.socket.close()
  } finally {
    await app.stop()
  }
})

test("TS-08: 'Daniel 3 4', 'Amos 3 4' and 'Ruth 2 3 and' are pending in auto AND review mode (EN)", async () => {
  for (const mode of ["auto", "review"] as const) {
    for (const text of ["Daniel 3 4", "Amos 3 4", "Ruth 2 3 and"]) {
      const asr = new FakeAsr()
      const app = await start(asr, { verseConfirmationMode: mode })
      try {
        const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
        asr.emit(text)
        await waitFor(() => typesOf(operator).includes("verse:pending"))
        await settle(100)
        assert.equal(typesOf(operator).includes("verse:show"), false, `${mode}: ${text}`)
        operator.socket.close()
      } finally {
        await app.stop()
      }
    }
  }
})

test("TS-08: explicit forms (colon, verset, chapitre) still auto-show in auto mode", async () => {
  for (const text of ["Jean 5:6", "Jean 5 verset 6", "John chapter 5 verse 6"]) {
    const asr = new FakeAsr()
    const app = await start(asr, { verseConfirmationMode: "auto" })
    try {
      const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
      asr.emit(text)
      await waitFor(() => typesOf(operator).includes("verse:show"), 3000)
      assert.equal(typesOf(operator).includes("verse:pending"), false, text)
      operator.socket.close()
    } finally {
      await app.stop()
    }
  }
})

// ---------------------------------------------------------------- SF-03
test("SF-03: an override whose source is down tells the OPERATOR (verse:lookup-failed, unavailable) and never a viewer", async () => {
  const asr = new FakeAsr()
  const app = await start(asr, { source: new FailingVerseSource("throw") })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    send(operator, "verse:override", { book: "john", chapter: 3, verse: 16 })
    await waitFor(() => typesOf(operator).includes("verse:lookup-failed"))
    const notice = operator.received.find((m) => m.type === "verse:lookup-failed")?.payload
    assert.deepEqual(notice, { reference: { book: "john", chapter: 3, verse: 16 }, reason: "unavailable", origin: "override" })
    await settle()
    assert.equal(typesOf(viewer).includes("verse:lookup-failed"), false)
    assert.equal(typesOf(operator).includes("verse:show"), false)
    operator.socket.close()
    viewer.socket.close()
  } finally {
    await app.stop()
  }
})

test("SF-03: a confirmed-missing verse reports not-found; a rejected override reports invalid", async () => {
  const asr = new FakeAsr()
  const app = await start(asr, { source: new FailingVerseSource("null") })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    send(operator, "verse:override", { book: "john", chapter: 3, verse: 16 })
    send(operator, "verse:override", { book: "john", chapter: 99, verse: 99 })
    await waitFor(() => operator.received.filter((m) => m.type === "verse:lookup-failed").length === 2)
    const reasons = operator.received.filter((m) => m.type === "verse:lookup-failed").map((m) => (m.payload as { reason: string }).reason).sort()
    assert.deepEqual(reasons, ["invalid", "not-found"])
    operator.socket.close()
  } finally {
    await app.stop()
  }
})

test("SF-03: a detected verse whose lookup fails is reported with origin 'detected'", async () => {
  const asr = new FakeAsr()
  const app = await start(asr, { source: new FailingVerseSource("throw") })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    asr.emit("Turn to John 3:16.")
    await waitFor(() => typesOf(operator).includes("verse:lookup-failed"))
    const notice = operator.received.find((m) => m.type === "verse:lookup-failed")?.payload as { origin: string; reason: string }
    assert.equal(notice.origin, "detected")
    assert.equal(notice.reason, "unavailable")
    operator.socket.close()
  } finally {
    await app.stop()
  }
})

test("SF-03: the same failure repeated inside the throttle window is reported once, not spammed", async () => {
  const asr = new FakeAsr()
  const source = new FailingVerseSource("throw")
  const app = await start(asr, { source })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    for (let i = 0; i < 4; i++) send(operator, "verse:override", { book: "john", chapter: 3, verse: 16 })
    await settle(400)
    assert.equal(operator.received.filter((m) => m.type === "verse:lookup-failed").length, 1)
    // many DIFFERENT references are bounded too
    for (let v = 1; v <= 15; v++) send(operator, "verse:override", { book: "john", chapter: 3, verse: v })
    await settle(500)
    assert.ok(operator.received.filter((m) => m.type === "verse:lookup-failed").length <= 5)
    operator.socket.close()
  } finally {
    await app.stop()
  }
})

// ---------------------------------------------------------------- S-01
test("S-01: transcripts, pending verses and near-misses reach the operator but never a viewer socket; the overlay still gets verse:show", async () => {
  const asr = new FakeAsr()
  const app = await start(asr, { verseConfirmationMode: "review" })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    asr.emit("Turn to", "partial")
    asr.emit("Turn to John 3:16.")
    asr.emit("regardez le verset 9999") // near-miss material
    await waitFor(() => typesOf(operator).includes("verse:pending"))
    await settle(200)
    for (const type of ["transcript:partial", "transcript:final", "verse:pending"]) {
      assert.ok(typesOf(operator).includes(type as WsMessage["type"]), `operator gets ${type}`)
    }
    const leaked = typesOf(viewer).filter((t) =>
      ["transcript:partial", "transcript:final", "verse:pending", "detector:near-miss", "translation:final", "mic:health", "verse:lookup-failed"].includes(t),
    )
    assert.deepEqual(leaked, [], "viewer must not receive any operator-only event")
    // Overlay path unchanged: confirming shows the verse to the viewer.
    send(operator, "verse:confirm-pending")
    await waitFor(() => typesOf(viewer).includes("verse:show"))
    operator.socket.close()
    viewer.socket.close()
  } finally {
    await app.stop()
  }
})

// ---------------------------------------------------------------- TS-05
class GatedVerseSource implements VerseSource {
  private release: (() => void) | null = null
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  open(): void {
    this.release?.()
  }
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    if (reference.book === "john" && reference.chapter === 3 && reference.verse === 16) await this.gate
    return { reference, text: `text for ${reference.book} ${reference.chapter}:${reference.verse}`, translation: "kjv", source: "test" }
  }
}

test("TS-05: a pending (review-mode) detection does not make a slower earlier operator override vanish", async () => {
  const asr = new FakeAsr()
  const source = new GatedVerseSource()
  const app = await start(asr, { source, verseConfirmationMode: "review" })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    send(operator, "verse:override", { book: "john", chapter: 3, verse: 16 }) // slow lookup, started first
    await settle(50)
    asr.emit("Turn to Romans 8:28.") // newer, fast, but only PENDING in review mode
    await waitFor(() => typesOf(operator).includes("verse:pending"))
    source.open()
    await waitFor(() => typesOf(viewer).includes("verse:show"))
    const shown = viewer.received.find((m) => m.type === "verse:show")?.payload as Verse
    assert.deepEqual(shown.reference, { book: "john", chapter: 3, verse: 16 })
    operator.socket.close()
    viewer.socket.close()
  } finally {
    await app.stop()
  }
})

test("TS-05: when a newer detection really took the screen, the superseded override is reported to the operator", async () => {
  const asr = new FakeAsr()
  const source = new GatedVerseSource()
  const app = await start(asr, { source, verseConfirmationMode: "auto" })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    send(operator, "verse:override", { book: "john", chapter: 3, verse: 16 })
    await settle(50)
    asr.emit("Turn to Romans 8:28.") // shown immediately (auto)
    await waitFor(() => typesOf(viewer).includes("verse:show"))
    source.open()
    await waitFor(() => typesOf(operator).includes("verse:lookup-failed"))
    const notice = operator.received.find((m) => m.type === "verse:lookup-failed")?.payload as { reason: string; origin: string }
    assert.equal(notice.reason, "superseded")
    assert.equal(notice.origin, "override")
    await settle(100)
    assert.equal(viewer.received.filter((m) => m.type === "verse:show").length, 1, "the newer verse stays on screen")
    operator.socket.close()
    viewer.socket.close()
  } finally {
    await app.stop()
  }
})

// ---------------------------------------------------------------- TS-04
test("TS-04: a viewer reconnecting after the verse was cleared does not get the rundown verse scene back", async () => {
  const asr = new FakeAsr()
  const app = await start(asr)
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    const rundown = {
      id: "01RUNDOWN",
      title: "Sunday",
      scenes: [{ kind: "verse", reference: { book: "john", chapter: 3, verse: 16 } }],
    }
    send(operator, "rundown:load", { rundown })
    await waitFor(() => typesOf(viewer).includes("verse:show"))
    // Still showing: a reconnecting viewer gets it back.
    const stillShowing = await connect(app.wsServer.port, TOKENS.viewerToken)
    await waitFor(() => typesOf(stillShowing).includes("verse:show"))
    stillShowing.socket.close()

    send(operator, "verse:clear")
    await waitFor(() => typesOf(viewer).includes("verse:clear"))
    const afterClear = await connect(app.wsServer.port, TOKENS.viewerToken)
    await settle(300)
    assert.equal(typesOf(afterClear).includes("verse:show"), false, "a cleared verse must stay cleared on reconnect")
    afterClear.socket.close()
    operator.socket.close()
    viewer.socket.close()
  } finally {
    await app.stop()
  }
})