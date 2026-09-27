import { test } from "node:test"
import assert from "node:assert/strict"
import { MicHealthMonitor, toDbfs } from "./mic-health"
import type { AudioFrame } from "../../../packages/contracts"

function frame(level: number): AudioFrame {
  return { samples: Int16Array.from(new Array(320).fill(level)), sampleRate: 16000, sequence: 0 }
}

/** 20 ms frames */
function observe(monitor: MicHealthMonitor, level: number, ms: number, isSpeech: boolean): void {
  for (let t = 0; t < ms; t += 20) monitor.observe(frame(level), Math.abs(level), isSpeech)
}

test("toDbfs: full scale ≈ 0 dBFS, half ≈ -6 dBFS", () => {
  assert.ok(Math.abs(toDbfs(32768)) < 0.01)
  assert.ok(Math.abs(toDbfs(16384) + 6.02) < 0.05)
})

test("MicHealthMonitor: warming-up with no audio, during calibration, or under a second", () => {
  const monitor = new MicHealthMonitor()
  assert.equal(monitor.snapshot().state, "warming-up")
  observe(monitor, 3000, 400, true)
  assert.equal(monitor.snapshot().state, "warming-up")
  observe(monitor, 3000, 2000, true)
  assert.equal(monitor.snapshot(true).state, "warming-up")
})

test("MicHealthMonitor: healthy speech over a quiet room is ok", () => {
  const monitor = new MicHealthMonitor()
  observe(monitor, 60, 1500, false)
  observe(monitor, 3000, 1500, true)
  const snap = monitor.snapshot()
  assert.equal(snap.state, "ok")
  assert.ok(snap.snrDb! > 30)
})

test("MicHealthMonitor: the real-world case — speech 40-60 dB under normal is too-quiet", () => {
  const monitor = new MicHealthMonitor()
  observe(monitor, 5, 1500, false)
  observe(monitor, 150, 1500, true) // ≈ -47 dBFS
  assert.equal(monitor.snapshot().state, "too-quiet")
})

test("MicHealthMonitor: samples at full scale are clipping", () => {
  const monitor = new MicHealthMonitor()
  observe(monitor, 32767, 1500, true)
  assert.equal(monitor.snapshot().state, "clipping")
})

test("MicHealthMonitor: speech barely above background is noisy", () => {
  const monitor = new MicHealthMonitor()
  observe(monitor, 2000, 1500, false)
  observe(monitor, 3500, 1500, true)
  assert.equal(monitor.snapshot().state, "noisy")
})

test("MicHealthMonitor: digital silence for 3 s is no-signal (muted / wrong device)", () => {
  const monitor = new MicHealthMonitor()
  observe(monitor, 0, 3500, false)
  assert.equal(monitor.snapshot().state, "no-signal")
})

test("MicHealthMonitor: a live but quiet room with no speech is listening, not an alarm", () => {
  const monitor = new MicHealthMonitor()
  observe(monitor, 80, 3500, false)
  assert.equal(monitor.snapshot().state, "listening")
})

test("MicHealthMonitor: window forgets old speech after ~4 s", () => {
  const monitor = new MicHealthMonitor()
  observe(monitor, 3000, 1500, true)
  observe(monitor, 80, 5000, false)
  assert.equal(monitor.snapshot().speechDbfs, null)
})

test("MicHealthMonitor: reports applied gain in dB", () => {
  const monitor = new MicHealthMonitor()
  monitor.setGain(10)
  assert.equal(monitor.snapshot().gainDb, 20)
})
