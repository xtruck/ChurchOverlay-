import { test } from "node:test"
import assert from "node:assert/strict"
import { SanctuaryDsp } from "./sanctuary-dsp"

test("SanctuaryDsp: processes silence (zeros) without distortion or explosion", () => {
  const dsp = new SanctuaryDsp()
  const samples = new Int16Array(1600) // 100ms of silence
  dsp.process(samples)
  for (let i = 0; i < samples.length; i++) {
    assert.equal(samples[i], 0)
  }
})

test("SanctuaryDsp: rejects and attenuates DC offset and sub-rumble (<20Hz)", () => {
  const dsp = new SanctuaryDsp({ sampleRate: 16000, highPassCutoffHz: 80 })
  const samples = new Int16Array(3200) // 200ms
  // Fill with a large DC bias (+10000)
  samples.fill(10000)

  dsp.process(samples)

  // After 200ms, the DC bias should be suppressed towards 0
  const lastSample = samples[samples.length - 1] ?? 0
  assert.ok(Math.abs(lastSample) < 1000, `DC bias should be heavily attenuated, got: ${lastSample}`)
})

test("SanctuaryDsp: preserves and passes 1kHz vocal fundamental tones", () => {
  const dsp = new SanctuaryDsp({ sampleRate: 16000 })
  const sampleRate = 16000
  const freq = 1000 // 1kHz
  const len = 3200
  const original = new Int16Array(len)
  for (let i = 0; i < len; i++) {
    original[i] = Math.round(15000 * Math.sin((2 * Math.PI * freq * i) / sampleRate))
  }

  const processed = new Int16Array(original)
  dsp.process(processed)

  // Compare amplitude in the steady-state region (second half)
  let origRms = 0
  let procRms = 0
  for (let i = 1600; i < len; i++) {
    const o = original[i] ?? 0
    const p = processed[i] ?? 0
    origRms += o * o
    procRms += p * p
  }
  origRms = Math.sqrt(origRms / 1600)
  procRms = Math.sqrt(procRms / 1600)

  // 1kHz is in the passband, so amplitude ratio should be close to 1.0 (within 15%)
  const ratio = procRms / origRms
  assert.ok(ratio > 0.85 && ratio < 1.25, `1kHz tone should pass cleanly, ratio: ${ratio}`)
})

test("SanctuaryDsp: reset() resets internal filter state", () => {
  const dsp = new SanctuaryDsp()
  const samples = new Int16Array(500)
  samples.fill(15000)
  dsp.process(samples)
  dsp.reset()

  const fresh = new Int16Array(100)
  dsp.process(fresh)
  assert.equal(fresh[0], 0)
})
