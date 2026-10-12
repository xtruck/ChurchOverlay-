import { test } from "node:test"
import assert from "node:assert/strict"
import { AudioFrameSequenceTracker } from "./audio-frame-sequence"

test("AudioFrameSequenceTracker: counts missing frames and duplicate/out-of-order frames", () => {
  const tracker = new AudioFrameSequenceTracker()
  assert.equal(tracker.observe(10).kind, "in-order")
  assert.equal(tracker.observe(11).kind, "in-order")
  const gap = tracker.observe(14)
  assert.equal(gap.kind, "gap")
  assert.equal(gap.expectedSequence, 12)
  assert.equal(gap.missingFrames, 2)
  assert.equal(tracker.observe(14).kind, "out-of-order")
  assert.deepEqual(tracker.snapshot(), {
    framesObserved: 4,
    gapEvents: 1,
    missingFrames: 2,
    outOfOrderFrames: 1,
  })
})

test("AudioFrameSequenceTracker: handles uint32 sequence wraparound", () => {
  const tracker = new AudioFrameSequenceTracker()
  tracker.observe(0xffff_fffe)
  assert.equal(tracker.observe(0xffff_ffff).kind, "in-order")
  assert.equal(tracker.observe(0).kind, "in-order")
  assert.equal(tracker.snapshot().gapEvents, 0)
})

test("AudioFrameSequenceTracker: reset starts a fresh session and invalid sequences are rejected", () => {
  const tracker = new AudioFrameSequenceTracker()
  tracker.observe(1)
  tracker.observe(3)
  tracker.reset()
  assert.equal(tracker.observe(100).kind, "in-order")
  assert.deepEqual(tracker.snapshot(), {
    framesObserved: 1,
    gapEvents: 0,
    missingFrames: 0,
    outOfOrderFrames: 0,
  })
  assert.throws(() => tracker.observe(-1), RangeError)
})
