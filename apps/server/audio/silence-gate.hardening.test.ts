import { test } from "node:test"
import assert from "node:assert/strict"
import { SilenceGate } from "./silence-gate"
import type { AudioFrame } from "../../../packages/contracts"
import { mix, rng, speechLike, toFrames, whiteNoise, SAMPLE_RATE } from "./synthetic-audio"

// Fix round F: calibration relaxation, floor rise bounded for continuous speech, bad-frame guard, loud-but-ignored tracking.

const FRAME = 320
const PER_SECOND = 50

function calibrated(ambient: Int16Array): SilenceGate {
  const gate = new SilenceGate({ robust: true })
  gate.startCalibration()
  for (const frame of toFrames(ambient, FRAME)) gate.process(frame)
  assert.equal(gate.isCalibrating(), false)
  return gate
}

function share(gate: SilenceGate, frames: AudioFrame[]): number {
  let forwarded = 0
  for (const frame of frames) if (gate.process(frame).forwarded) forwarded += 1
  return forwarded / Math.max(1, frames.length)
}

test("gate: a loud calibration (pre-service music) does not gate a quiet speaker for the whole session", () => {
  const random = rng(11)
  const gate = calibrated(whiteNoise(2500, SAMPLE_RATE * 2, random)) // loud room at calibration: base hits the 2000 cap
  assert.ok(gate.getThreshold() >= 1500)
  // The music stops; a quiet room and a speaker at a modest level.
  const seconds = 12
  const signal = mix(speechLike(500, 0, SAMPLE_RATE * seconds), whiteNoise(40, SAMPLE_RATE * seconds, random))
  const frames = toFrames(signal, FRAME, 100)
  const late = share(gate, frames.slice(0, PER_SECOND * 4)) // while the floor falls
  void late
  const settled = share(gate, frames.slice(PER_SECOND * 4))
  assert.ok(settled > 0.85, `the quiet speaker is forwarded once the floor has fallen (got ${settled})`)
  assert.ok(gate.getEffectiveThreshold() < 600, `effective threshold relaxed (got ${gate.getEffectiveThreshold()})`)
})

test("gate: 40 s of continuous speech with no pause does not pull the floor up and close the gate", () => {
  const random = rng(12)
  const gate = calibrated(whiteNoise(60, SAMPLE_RATE * 2, random))
  const seconds = 40
  const signal = mix(speechLike(1500, 0, SAMPLE_RATE * seconds), whiteNoise(60, SAMPLE_RATE * seconds, random))
  const frames = toFrames(signal, FRAME, 200)
  share(gate, frames.slice(0, PER_SECOND * 5))
  const last = share(gate, frames.slice(PER_SECOND * 30))
  assert.ok(last > 0.9, `speech is still forwarded after 30 s without a pause (got ${last})`)
  assert.ok(gate.getEffectiveThreshold() < 1000, `floor stayed low (effective threshold ${gate.getEffectiveThreshold()})`)
})

test("gate: steady loud noise still raises the floor and stops the flood (steadiness, not level, decides)", () => {
  const random = rng(13)
  const gate = calibrated(whiteNoise(60, SAMPLE_RATE * 2, random))
  const frames = toFrames(whiteNoise(1500, SAMPLE_RATE * 45, random), FRAME, 300)
  share(gate, frames.slice(0, PER_SECOND * 35))
  assert.ok(share(gate, frames.slice(PER_SECOND * 35)) < 0.1)
})

test("gate: loud input that stays rejected is measured, and clears once audio is forwarded or quiet again", () => {
  const random = rng(14)
  const gate = calibrated(whiteNoise(60, SAMPLE_RATE * 2, random))
  const frames = toFrames(whiteNoise(2500, SAMPLE_RATE * 50, random), FRAME, 400)
  for (const frame of frames) gate.process(frame)
  assert.ok(gate.getLoudClosedMs() > 5000, `loud-but-ignored time accumulates once the gate has shut (got ${gate.getLoudClosedMs()})`)
  for (const frame of toFrames(whiteNoise(20, SAMPLE_RATE, random), FRAME, 9000)) gate.process(frame)
  assert.equal(gate.getLoudClosedMs(), 0)
})

test("gate: a frame with a zero, NaN or infinite sample rate cannot stall calibration or latch the gate closed", () => {
  const gate = new SilenceGate({ robust: true, calibrationDurationMs: 100 })
  gate.startCalibration()
  const bad = (sampleRate: number, sequence: number): AudioFrame =>
    ({ samples: whiteNoise(60, 320, rng(sequence + 1)), sampleRate, sequence }) as unknown as AudioFrame
  for (const [index, rate] of [0, Number.NaN, Number.POSITIVE_INFINITY, -1].entries()) gate.process(bad(rate, index))
  for (const frame of toFrames(whiteNoise(60, SAMPLE_RATE, rng(5)), FRAME, 10)) gate.process(frame)
  assert.equal(gate.isCalibrating(), false, "calibration completed")
  assert.ok(Number.isFinite(gate.getNoiseFloor()) && Number.isFinite(gate.getEffectiveThreshold()))
  // Real speech afterwards is still forwarded.
  const speech = toFrames(speechLike(1500, 0, SAMPLE_RATE * 2), FRAME, 500)
  assert.ok(share(gate, speech) > 0.8)
})
