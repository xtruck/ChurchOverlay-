import { test } from "node:test"
import assert from "node:assert/strict"
import { AdaptiveGain, softLimit } from "./adaptive-gain"
import type { AudioFrame } from "../../../packages/contracts"

function frame(level: number, length = 320): AudioFrame {
  return { samples: Int16Array.from(new Array(length).fill(level)), sampleRate: 16000, sequence: 0 }
}

function feed(gain: AdaptiveGain, level: number, frames: number, isSpeech = true): AudioFrame {
  let out = frame(level)
  for (let i = 0; i < frames; i++) out = gain.process(frame(level), level, isSpeech)
  return out
}

test("AdaptiveGain: quiet speech is brought up toward the target level", () => {
  const gain = new AdaptiveGain()
  const out = feed(gain, 300, 250) // 5 s of speech at ~-40 dBFS
  assert.ok(gain.currentGain() > 8, `gain ${gain.currentGain()}`)
  assert.ok((out.samples[0] as number) > 2400)
})

test("AdaptiveGain: never exceeds maxGain", () => {
  const gain = new AdaptiveGain({ maxGain: 4 })
  feed(gain, 20, 500)
  assert.ok(gain.currentGain() <= 4.0001)
})

test("AdaptiveGain: never attenuates a loud signal", () => {
  const gain = new AdaptiveGain()
  const out = feed(gain, 20000, 100)
  assert.equal(gain.currentGain(), 1)
  assert.equal(out.samples[0], 20000)
})

test("AdaptiveGain: silence does not ramp the gain up (learns from speech frames only)", () => {
  const gain = new AdaptiveGain()
  feed(gain, 3000, 100) // speech already at target
  const before = gain.currentGain()
  feed(gain, 50, 500, false) // long non-speech stretch
  assert.equal(gain.currentGain(), before)
})

test("AdaptiveGain: smoothed — one quiet frame does not jump straight to max", () => {
  const gain = new AdaptiveGain()
  gain.process(frame(100), 100, true)
  assert.ok(gain.currentGain() < 1.5)
})

test("AdaptiveGain: disabled passes frames through untouched and reports unity gain", () => {
  const gain = new AdaptiveGain({ enabled: false })
  const input = frame(300)
  assert.equal(gain.process(input, 300, true), input)
  assert.equal(gain.currentGain(), 1)
})

test("AdaptiveGain: reset() forgets the previous session's level", () => {
  const gain = new AdaptiveGain()
  feed(gain, 300, 250)
  gain.reset()
  assert.equal(gain.currentGain(), 1)
})

test("softLimit: linear below the knee, never beyond full scale, symmetric", () => {
  assert.equal(softLimit(1000), 1000)
  assert.equal(softLimit(-1000), -1000)
  assert.ok(softLimit(100000) <= 32767)
  assert.ok(softLimit(100000) > 30000)
  assert.equal(softLimit(-100000), -softLimit(100000))
  assert.ok(softLimit(30000) < 30000 && softLimit(30000) > 24000)
})
