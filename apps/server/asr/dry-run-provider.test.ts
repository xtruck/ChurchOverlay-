import { test } from "node:test"
import assert from "node:assert/strict"
import { DryRunAsrProvider } from "./dry-run-provider"
import { isValidUlid } from "../../../packages/shared/ulid"
import type { TranscriptResult } from "../../../packages/contracts"

test("DryRunAsrProvider: emitText() before onTranscript() is registered does nothing (no crash)", () => {
  const provider = new DryRunAsrProvider()
  assert.doesNotThrow(() => provider.emitText("John 3:16"))
})

test("DryRunAsrProvider: emitText() delivers a final TranscriptResult with the given text", () => {
  const provider = new DryRunAsrProvider()
  const received: TranscriptResult[] = []
  provider.onTranscript((result) => received.push(result))

  provider.emitText("Turn to John 3:16")

  assert.equal(received.length, 1)
  assert.equal(received[0]?.text, "Turn to John 3:16")
  assert.equal(received[0]?.state, "final")
})

test("DryRunAsrProvider: each emitted transcript has a valid, unique id and correlationId", () => {
  const provider = new DryRunAsrProvider()
  const received: TranscriptResult[] = []
  provider.onTranscript((result) => received.push(result))

  provider.emitText("first")
  provider.emitText("second")

  assert.ok(isValidUlid(received[0]!.id))
  assert.ok(isValidUlid(received[0]!.correlationId))
  assert.notEqual(received[0]!.id, received[1]!.id)
  assert.notEqual(received[0]!.correlationId, received[1]!.correlationId)
})

test("DryRunAsrProvider: sequence increments across calls", () => {
  const provider = new DryRunAsrProvider()
  const received: TranscriptResult[] = []
  provider.onTranscript((result) => received.push(result))

  provider.emitText("first")
  provider.emitText("second")
  provider.emitText("third")

  assert.deepEqual(
    received.map((r) => r.sequence),
    [1, 2, 3]
  )
})

test("DryRunAsrProvider: start(), stop(), and sendAudio() are safe no-ops", async () => {
  const provider = new DryRunAsrProvider()
  await assert.doesNotReject(() => provider.start())
  await assert.doesNotReject(() =>
    provider.sendAudio({ samples: Int16Array.from([1, 2, 3]), sampleRate: 16000, sequence: 0 })
  )
  await assert.doesNotReject(() => provider.stop())
})

test("DryRunAsrProvider: timestamp uses the injected clock", () => {
  const provider = new DryRunAsrProvider({ now: () => 123456 })
  const received: TranscriptResult[] = []
  provider.onTranscript((result) => received.push(result))

  provider.emitText("John 3:16")

  assert.equal(received[0]?.timestamp, 123456)
})
