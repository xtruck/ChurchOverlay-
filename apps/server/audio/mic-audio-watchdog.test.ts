import { test } from "node:test"
import assert from "node:assert/strict"
import { MIC_NO_AUDIO_MS, MicAudioWatchdog, withTimeout } from "./mic-audio-watchdog"
import { ServiceHealthLog } from "../core/service-health"

test("MicAudioWatchdog: reports no-audio once after the timeout, recovers on the next frame", () => {
  const w = new MicAudioWatchdog()
  w.start(1000)
  assert.equal(w.tick(1000 + MIC_NO_AUDIO_MS - 1), null)
  assert.equal(w.tick(1000 + MIC_NO_AUDIO_MS), "no-audio")
  assert.equal(w.tick(1000 + MIC_NO_AUDIO_MS + 5000), null, "one report per episode")
  assert.equal(w.isSilent(), true)
  assert.equal(w.frame(20_000), "recovered")
  assert.equal(w.isSilent(), false)
  assert.equal(w.frame(20_020), null)
  assert.equal(w.tick(20_020 + MIC_NO_AUDIO_MS), "no-audio", "a second episode is reported again")
})

test("MicAudioWatchdog: frames keep it quiet; it is inert when not started or after stop()", () => {
  const w = new MicAudioWatchdog()
  assert.equal(w.tick(1e9), null)
  w.start(0)
  for (let t = 20; t < 60_000; t += 20) {
    assert.equal(w.frame(t), null)
    assert.equal(w.tick(t), null)
  }
  w.stop()
  assert.equal(w.tick(1e9), null)
})

test("ServiceHealthLog: a no-audio run is one dropout, closed by the next healthy reading", () => {
  const log = new ServiceHealthLog()
  log.observeMicState(1000, "ok")
  log.observeMicState(5000, "no-audio")
  log.observeMicState(6000, "no-audio")
  log.observeMicState(9000, "warming-up")
  assert.deepEqual(log.snapshot().micDropouts, [{ startedAt: 5000, endedAt: 9000 }])
})

test("withTimeout: resolves, rejects and times out with the injected timers", async () => {
  const pending: Array<() => void> = []
  const timers = { setTimeout: (cb: () => void) => { pending.push(cb); return pending.length }, clearTimeout: () => {} }
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "x", timers), 7)
  await assert.rejects(() => withTimeout(Promise.reject(new Error("boom")), 1000, "x", timers), /boom/)
  const hung = withTimeout(new Promise<void>(() => {}), 20_000, "ASR start", timers)
  pending.at(-1)!()
  await assert.rejects(() => hung, /ASR start did not finish within 20s/)
})