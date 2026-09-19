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
  // hangoverMs: 0 isolates the per-frame threshold check this test is
  // actually about — without it, the "at threshold" frame's own hangover
  // (ARCHITECTURE.md section 81) would carry the very next frame through
  // regardless of its own RMS, which is a real and correct behavior but
  // not what this specific test is checking.
  const gate = new SilenceGate({ threshold: 500, hangoverMs: 0 })
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
  // hangoverMs: 0 — see the boundary test above; this test is about
  // metrics accumulation, not hangover, and hangover would otherwise
  // forward the trailing silent frame too (correctly, per section 81).
  const gate = new SilenceGate({ threshold: 500, hangoverMs: 0 })
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

// ARCHITECTURE.md section 81 — the actual fix for the reported "have to
// speak loudly and repeat" bug: a brief below-threshold dip mid-utterance
// (a real, normal feature of speech) must not be silently dropped the way
// a strict per-frame gate would.
test("SilenceGate: a brief below-threshold dip right after a loud frame is still forwarded (hangover)", () => {
  const gate = new SilenceGate({ threshold: 500, hangoverMs: 50 })
  const loud = gate.process(makeFrame(new Array(160).fill(1000), 0)) // 10ms @ 16kHz
  const quietDip = gate.process(makeFrame(new Array(160).fill(0), 1)) // another 10ms, well inside the 50ms budget
  assert.equal(loud.forwarded, true)
  assert.equal(quietDip.forwarded, true)
})

test("SilenceGate: forwarding stops once the hangover budget is actually exhausted by sustained silence", () => {
  const gate = new SilenceGate({ threshold: 500, hangoverMs: 20 })
  gate.process(makeFrame(new Array(160).fill(1000), 0)) // arms a 20ms hangover budget
  // Each frame is 160 samples @ 16kHz = 10ms; three consecutive silent
  // frames (30ms) exceed the 20ms budget.
  gate.process(makeFrame(new Array(160).fill(0), 1))
  gate.process(makeFrame(new Array(160).fill(0), 2))
  const afterBudgetExhausted = gate.process(makeFrame(new Array(160).fill(0), 3))
  assert.equal(afterBudgetExhausted.forwarded, false)
})

test("SilenceGate: a fresh above-threshold frame refills the hangover budget rather than leaving it to decay from the first one", () => {
  const gate = new SilenceGate({ threshold: 500, hangoverMs: 20 })
  gate.process(makeFrame(new Array(160).fill(1000), 0)) // arms 20ms
  gate.process(makeFrame(new Array(160).fill(0), 1)) // 10ms of the budget spent, still forwarded
  gate.process(makeFrame(new Array(160).fill(1000), 2)) // above threshold again — refills to a full 20ms
  gate.process(makeFrame(new Array(160).fill(0), 3)) // only 10ms into the REFILLED budget
  const stillForwarded = gate.process(makeFrame(new Array(160).fill(0), 4)) // 20ms into the REFILLED budget
  // Without the refill at frame 2, this would be the third consecutive
  // silent frame after the original loud one (30ms > the original 20ms
  // budget) and would already be rejected — see the exhaustion test
  // above. Still being forwarded here is the actual evidence of refill.
  assert.equal(stillForwarded.forwarded, true)
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

// ARCHITECTURE.md section 76: one fixed global threshold can't be right
// for every room. startCalibration() derives a fresh one from THIS
// room's own ambient noise instead.
test("SilenceGate: accepts a bare number (backward-compatible with every existing call site)", () => {
  const gate = new SilenceGate(300)
  assert.equal(gate.getThreshold(), 300)
})

test("SilenceGate: during calibration, every frame is rejected regardless of loudness, and isCalibrating() is true", () => {
  const gate = new SilenceGate({ calibrationDurationMs: 100 })
  gate.startCalibration()
  assert.equal(gate.isCalibrating(), true)
  // 100ms at 16kHz = 1600 samples; one 800-sample frame is not enough to finish.
  const result = gate.process(makeFrame(new Array(800).fill(10000)))
  assert.equal(result.forwarded, false)
  assert.equal(gate.isCalibrating(), true)
})

test("SilenceGate: calibration finishes once enough audio has accumulated, deriving a threshold from the measured ambient RMS", () => {
  const gate = new SilenceGate({ calibrationDurationMs: 100 })
  gate.startCalibration()
  // 100ms at 16kHz = 1600 samples; two 800-sample frames at RMS 200 finish it.
  gate.process(makeFrame(new Array(800).fill(200)))
  assert.equal(gate.isCalibrating(), true)
  gate.process(makeFrame(new Array(800).fill(200)))
  assert.equal(gate.isCalibrating(), false)
  // ambient average (200) * the 1.5x multiplier = 300.
  assert.equal(gate.getThreshold(), 300)
})

test("SilenceGate: a calibrated threshold is clamped to a sane floor for a near-silent room", () => {
  const gate = new SilenceGate({ calibrationDurationMs: 100 })
  gate.startCalibration()
  gate.process(makeFrame(new Array(1600).fill(1))) // near-zero ambient RMS
  assert.equal(gate.isCalibrating(), false)
  assert.equal(gate.getThreshold(), 80) // the documented MIN_CALIBRATED_THRESHOLD, not ~1.5
})

test("SilenceGate: a calibrated threshold is clamped to a sane ceiling for a very loud room", () => {
  const gate = new SilenceGate({ calibrationDurationMs: 100 })
  gate.startCalibration()
  gate.process(makeFrame(new Array(1600).fill(5000))) // a loud transient during calibration
  assert.equal(gate.isCalibrating(), false)
  assert.equal(gate.getThreshold(), 2000) // the documented MAX_CALIBRATED_THRESHOLD, not 7500
})

test("SilenceGate: frames during calibration still count toward the running metrics, as rejected", () => {
  const gate = new SilenceGate({ calibrationDurationMs: 100 })
  gate.startCalibration()
  gate.process(makeFrame(new Array(1600).fill(200)))
  const metrics = gate.getMetrics()
  assert.equal(metrics.framesReceived, 1)
  assert.equal(metrics.framesRejected, 1)
  assert.equal(metrics.framesForwarded, 0)
})

test("SilenceGate: after calibration finishes, normal gating resumes using the newly-calibrated threshold", () => {
  const gate = new SilenceGate({ calibrationDurationMs: 100 })
  gate.startCalibration()
  gate.process(makeFrame(new Array(1600).fill(200))) // finishes calibration -> threshold 300
  assert.equal(gate.process(makeFrame(new Array(100).fill(250))).forwarded, false) // below 300
  assert.equal(gate.process(makeFrame(new Array(100).fill(350))).forwarded, true) // above 300
})

test("SilenceGate: calling startCalibration() again restarts it, discarding any in-progress measurement", () => {
  const gate = new SilenceGate({ calibrationDurationMs: 100 })
  gate.startCalibration()
  gate.process(makeFrame(new Array(1600).fill(5000))) // would calibrate to the loud-room ceiling
  assert.equal(gate.isCalibrating(), false)

  gate.startCalibration() // a fresh mic:start — must not be influenced by the prior session
  assert.equal(gate.isCalibrating(), true)
  gate.process(makeFrame(new Array(1600).fill(200)))
  assert.equal(gate.getThreshold(), 300) // the quiet second calibration, not a leftover from the loud first one
})
