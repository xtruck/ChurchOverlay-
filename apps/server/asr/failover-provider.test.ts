import { test } from "node:test"
import assert from "node:assert/strict"
import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { FailoverAsrProvider } from "./failover-provider"

class FakeProvider implements AsrProvider {
  readonly frames: AudioFrame[] = []
  startCalls = 0
  stopCalls = 0
  verseRef: string | null = null
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private sustainedCallback: (() => void) | null = null

  async start(): Promise<void> { this.startCalls += 1 }
  async sendAudio(audio: AudioFrame): Promise<void> { this.frames.push(audio) }
  async stop(): Promise<void> { this.stopCalls += 1 }
  onTranscript(callback: (result: TranscriptResult) => void): void { this.transcriptCallback = callback }
  onRateLimitedSustained(callback: () => void): void { this.sustainedCallback = callback }
  setCurrentVerseRef(reference: string | null): void { this.verseRef = reference }
  discardBufferedAudio(): void {}
  triggerSustainedLimit(): void { this.sustainedCallback?.() }
  emitTranscript(result: TranscriptResult): void { this.transcriptCallback?.(result) }
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
