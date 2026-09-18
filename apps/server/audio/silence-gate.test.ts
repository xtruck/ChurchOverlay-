import { test } from "node:test"
import assert from "node:assert/strict"
import { SilenceGate } from "./silence-gate"
import type { AudioFrame } from "../../../packages/contracts"

function makeFrame(sampleValues: number[], sequence = 0): AudioFrame {
  return { samples: Int16Array.from(sampleValues), sampleRate: 16000, sequence }
}

test("SilenceGate: rejects a frame of pure silence (all-zero samples)", () => {
  const gate = new SilenceGate()
  const result = gate.process(makeFrame(new Array(160).fill(0)))
  assert.equal(result.forwarded, false)
  assert.equal(result.rms, 0)
})

test("SilenceGate: forwards a frame with clearly loud, speech-like amplitude", () => {
  const gate = new SilenceGate()
  const result = gate.process(makeFrame(new Array(160).fill(10000)))
  assert.equal(result.forwarded, true)
  assert.equal(result.rms, 10000)
})

test("SilenceGate: is inclusive at the threshold boundary (rms === threshold forwards)", () => {
  const gate = new SilenceGate(500)
  const atThreshold = gate.process(makeFrame(new Array(100).fill(500)))
  const justBelow = gate.process(makeFrame(new Array(100).fill(499)))
  assert.equal(atThreshold.forwarded, true)
  assert.equal(justBelow.forwarded, false)
})

test("SilenceGate: never throws on an empty samples array, and treats it as silence", () => {
  const gate = new SilenceGate()
  assert.doesNotThrow(() => gate.process(makeFrame([])))
  const result = gate.process(makeFrame([]))
  assert.equal(result.forwarded, false)
  assert.equal(result.rms, 0)
})

test("SilenceGate: accumulates accurate metrics across a mix of silent and loud frames", () => {
  const gate = new SilenceGate(500)
  gate.process(makeFrame(new Array(100).fill(0))) // silent -> rejected
  gate.process(makeFrame(new Array(100).fill(1000))) // loud -> forwarded
  gate.process(makeFrame(new Array(100).fill(2000))) // loud -> forwarded
  gate.process(makeFrame(new Array(100).fill(0))) // silent -> rejected

  const metrics = gate.getMetrics()
  assert.equal(metrics.framesReceived, 4)
  assert.equal(metrics.framesRejected, 2)
  assert.equal(metrics.framesForwarded, 2)
  assert.equal(metrics.maxRms, 2000)
  assert.equal(metrics.averageRms, (0 + 1000 + 2000 + 0) / 4)
})

test("SilenceGate: getMetrics() before any frame is processed reports zeros, not NaN", () => {
  const gate = new SilenceGate()
  const metrics = gate.getMetrics()
  assert.deepEqual(metrics, {
    framesReceived: 0,
    framesRejected: 0,
    framesForwarded: 0,
    averageRms: 0,
    maxRms: 0,
  })
})

test("SilenceGate: a custom threshold is respected", () => {
  const strict = new SilenceGate(5000)
  const lenient = new SilenceGate(100)
  const frame = makeFrame(new Array(100).fill(1000))
  assert.equal(strict.process(frame).forwarded, false)
  assert.equal(lenient.process(frame).forwarded, true)
})

// Regression coverage for a real production bug: the original default
// threshold (500) was measured post-launch to be too strict — real
// ambient room noise on real hardware averaged ~1100 RMS with individual
// frames still dipping below 500, meaning quieter speech could plausibly
// be silently discarded. The default was lowered to 150; this pins that
// a moderate-volume frame that used to be rejected is now forwarded,
// so a future change can't silently re-tighten it back to the old value.
test("SilenceGate: the default threshold forwards moderate-volume audio that the old (500) default would have rejected", () => {
  const gate = new SilenceGate()
  const moderateFrame = makeFrame(new Array(160).fill(200))
  assert.equal(gate.process(moderateFrame).forwarded, true)
})
