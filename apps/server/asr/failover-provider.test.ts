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

// ---- Automatic return to the streaming primary (ARCHITECTURE.md section 115) ----

class GatedStartProvider extends FakeProvider {
  holdStarts = false
  private release: (() => void) | null = null
  override async start(): Promise<void> {
    this.startCalls += 1
    if (this.holdStarts) await new Promise<void>((resolve) => { this.release = resolve })
    if (this.failStart) throw new Error("connect failed")
  }
  releaseStart(): void { this.release?.() }
}

function autoReturnFixture(overrides: { trigger?: "primary-error" | "sustained-rate-limit"; primary?: FakeProvider } = {}) {
  const clock = { t: 1_000_000 }
  const primary = overrides.primary ?? new FakeProvider()
  const secondary = new FakeProvider()
  const attempts: { ok: boolean; nextDelayMs?: number }[] = []
  const provider = new FailoverAsrProvider({
    primary,
    secondary,
    trigger: overrides.trigger ?? "primary-error",
    secondaryLabel: "Groq",
    autoReturn: { now: () => clock.t, onAttempt: (r) => attempts.push(r) },
  })
  provider.onError(() => {})
  return { clock, primary, secondary, provider, attempts }
}

async function failOver(f: ReturnType<typeof autoReturnFixture>): Promise<void> {
  await f.provider.start()
  f.primary.emitError(new Error("Deepgram WebSocket closed unexpectedly"))
  await f.provider.sendAudio(frame(1))
  assert.equal(f.provider.activeSide(), "secondary")
}

test("auto-return: no attempt before the first backoff elapses", async () => {
  const f = autoReturnFixture()
  await failOver(f)
  f.clock.t += 29_999
  await f.provider.onUtteranceEnd()
  assert.equal(f.provider.activeSide(), "secondary")
  assert.equal(f.primary.startCalls, 1, "primary was only started once, at mic start")
})

test("auto-return: after 30 s, an utterance boundary returns to the primary (utterance end goes to the live provider first)", async () => {
  const f = autoReturnFixture()
  f.provider.setCurrentVerseRef("john 3:16")
  let returned = 0
  f.provider.onAutoReturned(() => { returned += 1 })
  await failOver(f)
  f.clock.t += 30_000
  await f.provider.onUtteranceEnd()
  assert.equal(f.secondary.utteranceEnds, 1, "the utterance was flushed on the secondary before switching")
  assert.equal(f.provider.activeSide(), "primary")
  assert.equal(f.provider.isFailedOver(), false)
  assert.equal(f.primary.verseRef, "john 3:16")
  assert.equal(returned, 1)
  await f.provider.sendAudio(frame(2))
  assert.deepEqual(f.primary.frames.map((x) => x.sequence), [2])
  assert.deepEqual(f.attempts, [{ ok: true }])
})

test("auto-return: never attempted from sendAudio, only at an utterance boundary", async () => {
  const f = autoReturnFixture()
  await failOver(f)
  f.clock.t += 600_000
  await f.provider.sendAudio(frame(2))
  assert.equal(f.provider.activeSide(), "secondary")
})

test("auto-return: failed attempts keep the secondary on air and back off 30 -> 60 -> 120 -> 240 -> 300 (cap)", async () => {
  const f = autoReturnFixture()
  await failOver(f)
  f.primary.failStart = true
  const waits = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]
  let expectedPrimaryStarts = 1
  for (const wait of waits) {
    f.clock.t += wait - 1
    await f.provider.onUtteranceEnd()
    assert.equal(f.primary.startCalls, expectedPrimaryStarts, `too early at ${wait}`)
    f.clock.t += 1
    await f.provider.onUtteranceEnd()
    expectedPrimaryStarts += 1
    assert.equal(f.primary.startCalls, expectedPrimaryStarts, `attempt at ${wait}`)
    assert.equal(f.provider.activeSide(), "secondary")
    await f.provider.sendAudio(frame(9)) // secondary still transcribes
  }
  assert.deepEqual(f.attempts.map((a) => a.nextDelayMs), [60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
  assert.equal(f.attempts.every((a) => !a.ok), true)
})

test("auto-return: a failed attempt does not surface an operator error", async () => {
  const f = autoReturnFixture()
  const errors: Error[] = []
  f.provider.onError((e) => errors.push(e))
  await failOver(f)
  f.primary.failStart = true
  f.clock.t += 30_000
  await f.provider.onUtteranceEnd()
  assert.equal(errors.length, 0)
})

test("auto-return: after a success the backoff is reset once the primary stayed up past the stability window", async () => {
  const f = autoReturnFixture()
  await failOver(f)
  f.primary.failStart = true
  f.clock.t += 30_000
  await f.provider.onUtteranceEnd() // fail, next delay 60 s
  f.primary.failStart = false
  f.clock.t += 60_000
  await f.provider.onUtteranceEnd() // success
  assert.equal(f.provider.activeSide(), "primary")
  f.clock.t += 400_000 // stable for longer than the 300 s cap
  f.primary.emitError(new Error("closed again"))
  await f.provider.sendAudio(frame(3))
  assert.equal(f.provider.activeSide(), "secondary")
  f.clock.t += 30_000
  await f.provider.onUtteranceEnd()
  assert.equal(f.provider.activeSide(), "primary", "back to the 30 s base delay")
})

test("auto-return: a primary that dies again right after a return does not flap every 30 s", async () => {
  const f = autoReturnFixture()
  await failOver(f)
  f.clock.t += 30_000
  await f.provider.onUtteranceEnd() // success at base delay
  assert.equal(f.provider.activeSide(), "primary")
  f.clock.t += 5_000
  f.primary.emitError(new Error("dropped again"))
  await f.provider.sendAudio(frame(4))
  assert.equal(f.provider.activeSide(), "secondary")
  f.clock.t += 30_000
  await f.provider.onUtteranceEnd()
  assert.equal(f.provider.activeSide(), "secondary", "doubled to 60 s")
  f.clock.t += 30_000
  await f.provider.onUtteranceEnd()
  assert.equal(f.provider.activeSide(), "primary")
})

test("auto-return: the sustained-rate-limit trigger is never auto-returned (section 86: operator decides)", async () => {
  const f = autoReturnFixture({ trigger: "sustained-rate-limit" })
  await f.provider.start()
  f.primary.triggerSustainedLimit()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.provider.activeSide(), "secondary")
  f.clock.t += 3_600_000
  await f.provider.onUtteranceEnd()
  assert.equal(f.provider.activeSide(), "secondary")
  assert.equal(f.primary.startCalls, 1)
})

test("auto-return: disabled unless configured", async () => {
  const primary = new FakeProvider()
  const secondary = new FakeProvider()
  const provider = new FailoverAsrProvider({ primary, secondary, trigger: "primary-error" })
  provider.onError(() => {})
  await provider.start()
  primary.emitError(new Error("closed"))
  await provider.sendAudio(frame(1))
  await provider.onUtteranceEnd()
  assert.equal(provider.activeSide(), "secondary")
})

test("auto-return: stop() cancels future attempts", async () => {
  const f = autoReturnFixture()
  await failOver(f)
  await f.provider.stop()
  f.clock.t += 3_600_000
  await f.provider.onUtteranceEnd()
  assert.equal(f.primary.startCalls, 1)
})

test("auto-return: stop() during an in-flight attempt leaves the primary stopped", async () => {
  const primary = new GatedStartProvider()
  const f = autoReturnFixture({ primary })
  await failOver(f)
  primary.holdStarts = true
  f.clock.t += 30_000
  const pending = f.provider.onUtteranceEnd()
  await new Promise((resolve) => setImmediate(resolve))
  const stopping = f.provider.stop()
  primary.releaseStart()
  await Promise.all([pending, stopping])
  assert.ok(primary.stopCalls >= 2, "primary released after the late return")
})

test("auto-return: audio arriving during the switch waits and lands on the new live provider", async () => {
  const primary = new GatedStartProvider()
  const f = autoReturnFixture({ primary })
  await failOver(f)
  primary.holdStarts = true
  f.clock.t += 30_000
  const pendingEnd = f.provider.onUtteranceEnd()
  await new Promise((resolve) => setImmediate(resolve))
  const pendingSend = f.provider.sendAudio(frame(5))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.secondary.frames.map((x) => x.sequence), [1], "not sent to the stopped secondary")
  primary.releaseStart()
  await Promise.all([pendingEnd, pendingSend])
  assert.deepEqual(primary.frames.map((x) => x.sequence), [5])
})

test("auto-return: concurrent utterance ends start only one attempt", async () => {
  const primary = new GatedStartProvider()
  const f = autoReturnFixture({ primary })
  await failOver(f)
  primary.holdStarts = true
  f.clock.t += 30_000
  const a = f.provider.onUtteranceEnd()
  const b = f.provider.onUtteranceEnd()
  await new Promise((resolve) => setImmediate(resolve))
  primary.releaseStart()
  await Promise.all([a, b])
  assert.equal(primary.startCalls, 2)
})
