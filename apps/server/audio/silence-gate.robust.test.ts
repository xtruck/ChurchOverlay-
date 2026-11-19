import { test } from "node:test"
import assert from "node:assert/strict"
import { SilenceGate } from "./silence-gate"
import type { AudioFrame } from "../../../packages/contracts"
import { clippedSquare, mix, rng, rumble, speechLike, tone, toFrames, whiteNoise, SAMPLE_RATE } from "./synthetic-audio"

// Robust mode: speech-band level + adaptive noise floor, for loud rooms
// (worship band, crowd, speaking in tongues). All signals are synthetic and seeded.

const FRAME = 320 // 20 ms
const PER_SECOND = 50

function makeFrame(values: number[], sequence = 0): AudioFrame {
  return { samples: Int16Array.from(values), sampleRate: SAMPLE_RATE, sequence }
}

function calibratedGate(robust: boolean, ambient: Int16Array): SilenceGate {
  const gate = new SilenceGate({ robust })
  gate.startCalibration()
  for (const frame of toFrames(ambient, FRAME)) gate.process(frame)
  assert.equal(gate.isCalibrating(), false)
  return gate
}

function forwardedShare(gate: SilenceGate, frames: AudioFrame[]): number {
  let forwarded = 0
  for (const frame of frames) if (gate.process(frame).forwarded) forwarded += 1
  return forwarded / frames.length
}

test("robust gate: a loud low-frequency rumble does not open the gate, while the fixed gate forwards it", () => {
  const random = rng(1)
  const bass = mix(tone(70, 3000, 0, SAMPLE_RATE * 4), tone(110, 2000, 0, SAMPLE_RATE * 4), rumble(300, SAMPLE_RATE * 4, random))
  const frames = toFrames(bass, FRAME, 100)
  const ambient = whiteNoise(60, SAMPLE_RATE * 2, random)
  assert.ok(forwardedShare(calibratedGate(false, ambient), frames) > 0.9, "the fixed gate is fooled by bass")
  // The first frames carry the filters' start-up transient (and its hangover); a live stream is past it.
  const robust = calibratedGate(true, ambient)
  forwardedShare(robust, frames.slice(0, 50))
  assert.ok(forwardedShare(robust, frames.slice(50)) < 0.02, "the robust gate ignores energy outside the speech band")
})

test("robust gate: speech-like audio over quiet room noise is forwarded", () => {
  const random = rng(2)
  const gate = calibratedGate(true, whiteNoise(60, SAMPLE_RATE * 2, random))
  const signal = mix(speechLike(1500, 0, SAMPLE_RATE * 6), whiteNoise(60, SAMPLE_RATE * 6, random))
  assert.ok(forwardedShare(gate, toFrames(signal, FRAME, 200)) > 0.9)
})

test("robust gate: sustained loud noise is forwarded at first, then the floor rises and the flood to the paid ASR stops", () => {
  const random = rng(3)
  const gate = calibratedGate(true, whiteNoise(60, SAMPLE_RATE * 2, random))
  const frames = toFrames(whiteNoise(1500, SAMPLE_RATE * 40, random), FRAME, 300)
  const early = forwardedShare(gate, frames.slice(0, PER_SECOND * 3))
  assert.ok(early > 0.9, `noise is first treated as speech (got ${early})`)
  forwardedShare(gate, frames.slice(PER_SECOND * 3, PER_SECOND * 30))
  const late = forwardedShare(gate, frames.slice(PER_SECOND * 30))
  assert.ok(late < 0.1, `after about 30 s of sustained noise almost nothing is forwarded (got ${late})`)
  assert.ok(gate.getEffectiveThreshold() > gate.getThreshold(), "the effective threshold rose above the calibrated base")
})

test("robust gate: a speaker with natural pauses over steady crowd noise is not locked out", () => {
  const random = rng(4)
  const gate = calibratedGate(true, whiteNoise(300, SAMPLE_RATE * 2, random))
  const seconds = 60
  const noise = whiteNoise(300, SAMPLE_RATE * seconds, random)
  const speech = new Int16Array(SAMPLE_RATE * seconds)
  for (let second = 0; second < seconds; second++) {
    if (second % 4 === 3) continue // 1 s pause after every 3 s of speech
    speech.set(speechLike(2500, second * SAMPLE_RATE, SAMPLE_RATE), second * SAMPLE_RATE)
  }
  const frames = toFrames(mix(speech, noise), FRAME, 400)
  let speechFrames = 0
  let forwardedSpeechFrames = 0
  frames.forEach((frame, index) => {
    const result = gate.process(frame)
    const second = Math.floor(index / PER_SECOND)
    if (second >= 20 && second % 4 !== 3) {
      speechFrames += 1
      if (result.forwarded) forwardedSpeechFrames += 1
    }
  })
  assert.ok(forwardedSpeechFrames / speechFrames > 0.9, `speech is still forwarded after a minute (got ${forwardedSpeechFrames / speechFrames})`)
})

test("robust gate: the effective threshold is capped, so extreme loudness cannot shut the gate for good", () => {
  const random = rng(5)
  const gate = calibratedGate(true, whiteNoise(60, SAMPLE_RATE * 2, random))
  for (const frame of toFrames(whiteNoise(9000, SAMPLE_RATE * 60, random), FRAME, 500)) gate.process(frame)
  assert.ok(gate.getEffectiveThreshold() <= 4000)
  const burst = toFrames(speechLike(12000, 0, SAMPLE_RATE), FRAME, 9000)
  assert.ok(burst.some((frame) => gate.process(frame).forwarded))
})

test("robust gate: tongues mode widens the margin above the floor", () => {
  const make = (tongues: boolean) => {
    const gate = calibratedGate(true, whiteNoise(200, SAMPLE_RATE * 2, rng(6)))
    if (tongues) gate.setNoiseMode("tongues")
    return gate
  }
  assert.ok(make(true).getEffectiveThreshold() > make(false).getEffectiveThreshold())
})

test("gate: robust mode is off by default, and the result says whether the frame itself is speech", () => {
  const gate = new SilenceGate({ threshold: 500, hangoverMs: 600 })
  const loud = gate.process(makeFrame(new Array(100).fill(1000)))
  const carried = gate.process(makeFrame(new Array(100).fill(10)))
  assert.equal(loud.speech, true)
  assert.equal(carried.forwarded, true, "the hangover carries it")
  assert.equal(carried.speech, false, "but the frame itself is not speech")
  assert.equal(gate.getEffectiveThreshold(), 500)
  assert.equal(gate.getNoiseFloor(), 0)
})

test("robust gate: clipped square-wave music still reports its full-band RMS (metrics and gain keep their scale)", () => {
  const gate = calibratedGate(true, whiteNoise(60, SAMPLE_RATE * 2, rng(7)))
  const result = gate.process(toFrames(clippedSquare(220, 20, 0, FRAME), FRAME)[0] as AudioFrame)
  assert.ok(result.rms > 20000)
})

test("robust gate: empty frames never throw", () => {
  const gate = calibratedGate(true, whiteNoise(60, SAMPLE_RATE * 2, rng(8)))
  assert.doesNotThrow(() => gate.process({ samples: new Int16Array(0), sampleRate: SAMPLE_RATE, sequence: 1 }))
})
