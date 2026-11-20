import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { startAppCore } from "./app-core"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { Logger } from "../../../packages/shared/logger"
import type {
  AsrContextHints,
  AsrProvider,
  AudioFrame,
  Rundown,
  TranscriptResult,
  Verse,
  VerseReference,
  VerseSource,
} from "../../../packages/contracts"

const TOKENS = { operatorToken: "op-token", viewerToken: "viewer-token" }

/** Named per AGENTS.md section 45: a test double, not a real ASR provider. */
class FakeHintedAsrProvider implements AsrProvider {
  readonly received: AsrContextHints[] = []
  async start(): Promise<void> {}
  async sendAudio(_audio: AudioFrame): Promise<void> {}
  async stop(): Promise<void> {}
  onTranscript(_callback: (result: TranscriptResult) => void): void {}
  setContextHints(hints: AsrContextHints): void {
    this.received.push(hints)
  }
}

/** Named per AGENTS.md section 45: a provider WITHOUT setContextHints. */
class FakePlainAsrProvider implements AsrProvider {
  async start(): Promise<void> {}
  async sendAudio(_audio: AudioFrame): Promise<void> {}
  async stop(): Promise<void> {}
  onTranscript(_callback: (result: TranscriptResult) => void): void {}
}

class EchoVerseSourceStub implements VerseSource {
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    return { reference, text: "texte", translation: "kjv", source: "bible-api.com" }
  }
}

function capturingLogger(): { logger: Logger; events: string[] } {
  const events: string[] = []
  return { logger: new Logger({ minLevel: "debug", write: (line) => events.push((JSON.parse(line) as { event: string }).event) }), events }
}

async function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("AppCore: context hints follow the plan (sermon prep, rundown) and the displayed book, pushed only on change", async () => {
  const asr = new FakeHintedAsrProvider()
  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSourceStub(),
    logger: capturingLogger().logger,
    port: 0,
    tokens: TOKENS,
  })
  try {
    const outcome = app.importSermonPrep("Jean 3:16\nRm 8:28")
    assert.ok(outcome.ok)
    assert.deepEqual(asr.received.at(-1), { focusBooks: [], plannedBooks: ["john", "romans"] })
    const pushes = asr.received.length
    app.importSermonPrep("Jean 3:16\nRm 8:28")
    assert.equal(asr.received.length, pushes, "same plan again: nothing pushed")

    const operatorSocket = await connect(app.wsServer.port, TOKENS.operatorToken)
    const rundown: Rundown = {
      id: "01RUNDOWN",
      title: "Sunday Service",
      scenes: [{ kind: "verse", reference: { book: "psalm", chapter: 23, verse: 1 } }],
    }
    operatorSocket.send(JSON.stringify({ id: "01A", type: "rundown:load", timestamp: Date.now(), payload: { rundown } }))
    // The rundown activates its first scene: psalm becomes the focus book, out of the plan list.
    await waitFor(() => asr.received.at(-1)?.focusBooks[0] === "psalm")
    assert.deepEqual(asr.received.at(-1), { focusBooks: ["psalm"], plannedBooks: ["john", "romans"] })
    operatorSocket.close()
  } finally {
    await app.stop()
  }
})

test("AppCore: a provider without setContextHints ignores them explicitly: logged once, nothing thrown", async () => {
  const { logger, events } = capturingLogger()
  const app = await startAppCore({
    asr: new FakePlainAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSourceStub(),
    logger,
    port: 0,
    tokens: TOKENS,
  })
  try {
    assert.ok(app.importSermonPrep("Jean 3:16").ok)
    assert.ok(app.importSermonPrep("Rm 8:28").ok)
    assert.equal(events.filter((event) => event === "asr.context-hints-unsupported").length, 1)
  } finally {
    await app.stop()
  }
})

test("AppCore: a provider whose setContextHints throws does not break the caller", async () => {
  const { logger, events } = capturingLogger()
  class ThrowingHintsProvider extends FakePlainAsrProvider {
    setContextHints(): void {
      throw new Error("boom")
    }
  }
  const app = await startAppCore({
    asr: new ThrowingHintsProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new EchoVerseSourceStub(),
    logger,
    port: 0,
    tokens: TOKENS,
  })
  try {
    assert.ok(app.importSermonPrep("Jean 3:16").ok, "the import still succeeds")
    assert.ok(events.includes("asr.context-hints-failed"))
  } finally {
    await app.stop()
  }
})
