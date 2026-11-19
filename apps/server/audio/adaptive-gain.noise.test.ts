import { test } from "node:test"
import assert from "node:assert/strict"
import { AdaptiveGain } from "./adaptive-gain"
import { clippedSquare, frameOf, rmsOf, speechLike, toFrames, SAMPLE_RATE } from "./synthetic-audio"

const FRAME = 320

test("AdaptiveGain: quiet speech is lifted, then loud clipped music arriving at once is not amplified into the limiter", () => {
  const gain = new AdaptiveGain()
  for (const frame of toFrames(speechLike(200, 0, SAMPLE_RATE * 6), FRAME)) gain.process(frame, rmsOf(frame.samples), true)
  assert.ok(gain.currentGain() > 5, `gain was lifted for quiet speech (got ${gain.currentGain()})`)

  // Hot clipped music at full scale: even the very first frame must come out undistorted by the gain.
  const music = toFrames(clippedSquare(220, 30, 0, SAMPLE_RATE), FRAME, 1000)
  const first = music[0]!
  const out = gain.process(first, rmsOf(first.samples), true)
  let peakOut = 0
  for (const sample of out.samples) peakOut = Math.max(peakOut, Math.abs(sample))
  assert.ok(peakOut <= 32767)
  // The frame already peaks above the knee, so no gain at all is applied: the signal passes unchanged, not amplified.
  assert.deepEqual(out.samples, first.samples)
  for (const frame of music.slice(1, 30)) gain.process(frame, rmsOf(frame.samples), true)
  assert.ok(gain.currentGain() < 1.5, `the stored gain followed the loud passage down quickly (got ${gain.currentGain()})`)
})

test("AdaptiveGain: a frame is never amplified past the limiter knee, whatever the stored gain", () => {
  const gain = new AdaptiveGain()
  for (const frame of toFrames(speechLike(150, 0, SAMPLE_RATE * 6), FRAME)) gain.process(frame, rmsOf(frame.samples), true)
  const loud = frameOf(Int16Array.from({ length: FRAME }, (_, i) => (i % 2 === 0 ? 12000 : -12000)), 99)
  const out = gain.process(loud, 12000, false) // not speech: no learning, the stored gain is still high
  for (const sample of out.samples) assert.ok(Math.abs(sample) <= 24000 + 1)
})

test("AdaptiveGain: ordinary quiet frames are unaffected by the peak cap (still amplified)", () => {
  const gain = new AdaptiveGain()
  let last = frameOf(new Int16Array(FRAME), 0)
  for (const frame of toFrames(speechLike(200, 0, SAMPLE_RATE * 6), FRAME)) last = gain.process(frame, rmsOf(frame.samples), true)
  assert.ok(rmsOf(last.samples) > 800)
})
