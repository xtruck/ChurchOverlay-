import { test } from "node:test"
import assert from "node:assert/strict"
import { LatencyTracker } from "./latency-tracker"

test("LatencyTracker: empty snapshot reports nulls, never invented numbers", () => {
  assert.deepEqual(new LatencyTracker().snapshot(), { count: 0, lastMs: null, p50Ms: null, p95Ms: null, maxMs: null })
})

test("LatencyTracker: nearest-rank p50/p95, max and last", () => {
  const tracker = new LatencyTracker()
  for (let ms = 1; ms <= 20; ms++) tracker.record(ms * 10)
  tracker.record(15)
  const snap = tracker.snapshot()
  assert.equal(snap.count, 21)
  assert.equal(snap.lastMs, 15)
  assert.equal(snap.p50Ms, 100)
  assert.equal(snap.p95Ms, 190) // rank ceil(0.95 * 21) = 20th of 21
  assert.equal(snap.maxMs, 200)
})

test("LatencyTracker: keeps only the most recent samples (bounded)", () => {
  const tracker = new LatencyTracker(3)
  for (const ms of [1000, 1000, 1000, 5, 6, 7]) tracker.record(ms)
  const snap = tracker.snapshot()
  assert.equal(snap.count, 3)
  assert.equal(snap.maxMs, 7)
})

test("LatencyTracker: ignores negative and non-finite durations (clock skew)", () => {
  const tracker = new LatencyTracker()
  tracker.record(-5)
  tracker.record(Number.NaN)
  tracker.record(Number.POSITIVE_INFINITY)
  assert.equal(tracker.snapshot().count, 0)
})

test("LatencyTracker: rejects a non-positive capacity", () => {
  assert.throws(() => new LatencyTracker(0))
})
