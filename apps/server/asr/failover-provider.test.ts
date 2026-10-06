import { test } from "node:test"
import assert from "node:assert/strict"
import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { FailoverAsrProvider } from "./failover-provider"

class FakeProvider implements AsrProvider {
  readonly frames: AudioFrame[] = []
  startCalls = 0
  stopCalls = 0
  verseRef: string | null = null
  plannedBooks: readonly string[] = []
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private sustainedCallback: (() => void) | null = null

  async start(): Promise<void> {
    this.startCalls += 1
    if (this.failStart) throw new Error("connect failed")
  }
  async sendAudio(audio: AudioFrame): Promise<void> {
    if (this.failSend) throw new Error("not connected")
    this.frames.push(audio)
  }
  async stop(): Promise<void> { this.stopCalls += 1 }
  onTranscript(callback: (result: TranscriptResult) => void): void { this.transcriptCallback = callback }
  onRateLimitedSustained(callback: () => void): void { this.sustainedCallback = callback }
  setCurrentVerseRef(reference: string | null): void { this.verseRef = reference }
  setPlannedBooks(bookIds: readonly string[]): void { this.plannedBooks = bookIds }
  discardBufferedAudio(): void {}
  triggerSustainedLimit(): void { this.sustainedCallback?.() }
  utteranceEnds = 0
  failStart = false
  failSend = false
  private errorCallback: ((error: Error) => void) | null = null
  onError(callback: (error: Error) => void): void { this.errorCallback = callback }
  emitError(error: Error): void { this.errorCallback?.(error) }
  async onUtteranceEnd(): Promise<void> { this.utteranceEnds += 1 }
  emitTranscript(result: TranscriptResult): void { this.transcriptCallback?.(result) }
}

class DelayedProvider extends FakeProvider {
  private resolveStart: (() => void) | null = null
  readonly startGate = new Promise<void>((resolve) => { this.resolveStart = resolve })

  override async start(): Promise<void> {
    this.startCalls += 1
    await this.startGate
  }

  releaseStart(): void {
    this.resolveStart?.()
  }
}

function frame(sequence: number): AudioFrame {
  return { samples: Int16Array.from([sequence]), sampleRate: 16000, sequence }
}

test("FailoverAsrProvider: sustained Groq limit opens Deepgram on demand and routes later frames", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary })
  let activated = 0
  provider.onFailoverActivated(() => { activated += 1 })
  provider.setCurrentVerseRef("john 3:16")
  await provider.start()
  await provider.sendAudio(frame(1))
  assert.equal(primary.startCalls, 1)
  assert.equal(secondary.startCalls, 0)
  primary.triggerSustainedLimit()
  await new Promise((resolve) => setImmediate(resolve))
  await provider.sendAudio(frame(2))

  assert.equal(secondary.startCalls, 1)
  assert.deepEqual(primary.frames.map((item) => item.sequence), [1])
  assert.deepEqual(secondary.frames.map((item) => item.sequence), [2])
  assert.equal(secondary.verseRef, "john 3:16")
  assert.equal(activated, 1)
})

test("FailoverAsrProvider: normal Groq-only operation never starts the secondary provider", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary })
  await provider.start()
  await provider.sendAudio(frame(1))
  assert.equal(primary.frames.length, 1)
  assert.equal(secondary.startCalls, 0)
  assert.equal(provider.isFailedOver(), false)
})

test("FailoverAsrProvider: returnToPrimary is manual and restores the current verse reference", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary })
  provider.setCurrentVerseRef("romans 8:28")
  await provider.start()
  primary.triggerSustainedLimit()
  await new Promise((resolve) => setImmediate(resolve))
  await provider.returnToPrimary()
  assert.equal(provider.isFailedOver(), false)
  assert.equal(primary.verseRef, "romans 8:28")
  assert.equal(secondary.stopCalls, 1)
})

test("FailoverAsrProvider: audio waits for secondary startup instead of leaking to primary", async () => {
  const primary = new FakeProvider()
  const secondary = new DelayedProvider()
  const provider = new FailoverAsrProvider({ primary, secondary })
  await provider.start()

  primary.triggerSustainedLimit()
  const sendPromise = provider.sendAudio(frame(2))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(primary.frames.map((item) => item.sequence), [])
  assert.deepEqual(secondary.frames.map((item) => item.sequence), [])

  secondary.releaseStart()
  await sendPromise
  assert.deepEqual(primary.frames.map((item) => item.sequence), [])
  assert.deepEqual(secondary.frames.map((item) => item.sequence), [2])
})

test("FailoverAsrProvider: forwards utterance end to the live provider only", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary })
  await provider.start()
  await provider.onUtteranceEnd()
  assert.equal(primary.utteranceEnds, 1)
  primary.triggerSustainedLimit()
  await new Promise((resolve) => setImmediate(resolve))
  await provider.onUtteranceEnd()
  assert.equal(secondary.utteranceEnds, 1)
  assert.equal(primary.utteranceEnds, 1)
})

test("FailoverAsrProvider (streaming-first): a primary socket error fails over silently to the secondary", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary, trigger: "primary-error", secondaryLabel: "Groq" })
  const errors: Error[] = []
  const labels: string[] = []
  provider.onError((error) => errors.push(error))
  provider.onFailoverActivated((label) => labels.push(label))
  await provider.start()
  primary.emitError(new Error("Deepgram WebSocket closed unexpectedly"))
  await provider.sendAudio(frame(1))
  assert.deepEqual(secondary.frames.map((f) => f.sequence), [1])
  assert.deepEqual(labels, ["Groq"])
  assert.equal(errors.length, 0, "a handled failover is not an error for the operator")
  assert.equal(provider.activeSide(), "secondary")
  assert.equal(primary.stopCalls, 1, "broken primary is released")
})

test("FailoverAsrProvider (streaming-first): unreachable primary at mic start starts on the secondary", async () => {
  const primary = new FakeProvider()
  primary.failStart = true
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary, trigger: "primary-error" })
  await provider.start()
  await provider.sendAudio(frame(7))
  assert.deepEqual(secondary.frames.map((f) => f.sequence), [7])
})

test("FailoverAsrProvider (streaming-first): a failed send re-routes that same frame to the secondary", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary, trigger: "primary-error" })
  await provider.start()
  primary.failSend = true
  await provider.sendAudio(frame(3))
  assert.deepEqual(secondary.frames.map((f) => f.sequence), [3])
})

test("FailoverAsrProvider (batch-first): an ordinary primary error is reported, not a failover", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary })
  const errors: Error[] = []
  provider.onError((error) => errors.push(error))
  await provider.start()
  primary.emitError(new Error("boom"))
  assert.equal(errors.length, 1)
  assert.equal(secondary.startCalls, 0)
})

test("FailoverAsrProvider: errors after stop() never trigger a failover", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary, trigger: "primary-error" })
  provider.onError(() => {})
  await provider.start()
  await provider.stop()
  primary.emitError(new Error("closed"))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(secondary.startCalls, 0)
})

test("FailoverAsrProvider: a switch inside a nested chain (Groq → local) reaches the outer status", async () => {
  const deepgram = new FakeProvider()
  const groq = new FakeProvider()
  const local = new FakeProvider()
  const inner = new FailoverAsrProvider({ primary: groq, secondary: local, secondaryLabel: "local" })
  const outer = new FailoverAsrProvider({ primary: deepgram, secondary: inner, trigger: "primary-error", secondaryLabel: "Groq" })
  const labels: string[] = []
  outer.onFailoverActivated((label) => labels.push(label))
  outer.onError(() => {})
  await outer.start()
  deepgram.emitError(new Error("socket closed"))
  await outer.sendAudio(frame(1))
  groq.triggerSustainedLimit()
  await new Promise((resolve) => setImmediate(resolve))
  await outer.sendAudio(frame(2))
  assert.deepEqual(labels, ["Groq", "local"])
  assert.deepEqual(local.frames.map((f) => f.sequence), [2])
})

test("FailoverAsrProvider: setPlannedBooks reaches both providers immediately, whichever is active", () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const wrapper = new FailoverAsrProvider({ primary, secondary, trigger: "primary-error" })
  wrapper.setPlannedBooks(["john", "romans"])
  assert.deepEqual(primary.plannedBooks, ["john", "romans"])
  assert.deepEqual(secondary.plannedBooks, ["john", "romans"])
})

test("FailoverAsrProvider: a failed returnToPrimary puts the secondary back on air instead of leaving transcription dead", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary })
  provider.setCurrentVerseRef("romans 8:28")
  await provider.start()
  primary.triggerSustainedLimit()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(provider.isFailedOver(), true)

  primary.failStart = true // the primary is still down
  await assert.rejects(() => provider.returnToPrimary(), /connect failed/)

  assert.equal(provider.isFailedOver(), true) // still failed over, not stuck "switching"
  assert.equal(secondary.startCalls, 2) // opened once for the failover, restarted by the rollback
  assert.equal(secondary.verseRef, "romans 8:28")
  await provider.sendAudio(frame(7)) // must not throw
  assert.deepEqual(secondary.frames.map((item) => item.sequence), [7])

  primary.failStart = false // the primary recovers; a later manual return works
  await provider.returnToPrimary()
  assert.equal(provider.isFailedOver(), false)
})
