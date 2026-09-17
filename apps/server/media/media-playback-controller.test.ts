import { test } from "node:test"
import assert from "node:assert/strict"
import { MediaPlaybackController } from "./media-playback-controller"
import type { MediaCue } from "../../../packages/contracts"

const VIDEO_CUE: MediaCue = { kind: "video", id: "01VIDEO", title: "Intro Clip" }
const IMAGE_CUE: MediaCue = { kind: "image", id: "01IMAGE", title: "Welcome Slide" }

function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs
  return { now: () => current, advance: (ms: number) => (current += ms) }
}

test("MediaPlaybackController: activate() on a video starts playing at position 0", () => {
  const clock = fakeClock(1_000_000)
  const controller = new MediaPlaybackController({ now: clock.now })
  const payload = controller.activate(VIDEO_CUE)
  assert.deepEqual(payload, {
    cue: VIDEO_CUE,
    playback: { state: "playing", positionMs: 0, asOfServerTime: 1_000_000 },
  })
})

test("MediaPlaybackController: activate() on an image has no playback field at all", () => {
  const controller = new MediaPlaybackController()
  const payload = controller.activate(IMAGE_CUE)
  assert.deepEqual(payload, { cue: IMAGE_CUE })
})

test("MediaPlaybackController: the timestamp-and-recompute formula matches by hand-calculation", () => {
  const clock = fakeClock(1_000_000)
  const controller = new MediaPlaybackController({ now: clock.now })
  controller.activate(VIDEO_CUE) // playing, positionMs 0, asOf 1_000_000

  clock.advance(2500) // 2.5s of real playback time passes
  const synced = controller.currentPayloadForSync()
  // actualPositionMs = positionMs(0) + (now(1_002_500) - asOfServerTime(1_000_000)) = 2500
  assert.equal(synced?.playback?.positionMs, 2500)
  assert.equal(synced?.playback?.state, "playing")
})

test("MediaPlaybackController: pause() freezes the position computed at that moment, not 0", () => {
  const clock = fakeClock(1_000_000)
  const controller = new MediaPlaybackController({ now: clock.now })
  controller.activate(VIDEO_CUE)

  clock.advance(3000)
  const paused = controller.pause()
  assert.equal(paused?.playback?.state, "paused")
  assert.equal(paused?.playback?.positionMs, 3000)

  // Position must stay frozen while paused, regardless of real time passing.
  clock.advance(5000)
  const synced = controller.currentPayloadForSync()
  assert.equal(synced?.playback?.positionMs, 3000)
})

test("MediaPlaybackController: play() after pause() resumes from the paused positionMs, not from 0", () => {
  const clock = fakeClock(1_000_000)
  const controller = new MediaPlaybackController({ now: clock.now })
  controller.activate(VIDEO_CUE)
  clock.advance(4000)
  controller.pause() // frozen at 4000

  clock.advance(1000) // time passes while paused — must not count
  const resumed = controller.play()
  assert.equal(resumed?.playback?.state, "playing")
  assert.equal(resumed?.playback?.positionMs, 4000)

  clock.advance(1500)
  const synced = controller.currentPayloadForSync()
  assert.equal(synced?.playback?.positionMs, 5500) // 4000 + 1500 of real playback since resuming
})

test("MediaPlaybackController: seek() while paused stays paused at the new position", () => {
  const controller = new MediaPlaybackController()
  controller.activate(VIDEO_CUE)
  controller.pause()
  const sought = controller.seek(9000)
  assert.equal(sought?.playback?.state, "paused")
  assert.equal(sought?.playback?.positionMs, 9000)
})

test("MediaPlaybackController: seek() while playing keeps playing from the new position", () => {
  const clock = fakeClock(1_000_000)
  const controller = new MediaPlaybackController({ now: clock.now })
  controller.activate(VIDEO_CUE)
  const sought = controller.seek(7000)
  assert.equal(sought?.playback?.state, "playing")
  assert.equal(sought?.playback?.positionMs, 7000)

  clock.advance(2000)
  const synced = controller.currentPayloadForSync()
  assert.equal(synced?.playback?.positionMs, 9000)
})

test("MediaPlaybackController: play()/pause()/seek() with no active cue are rejected (null), not silently ignored as success", () => {
  const controller = new MediaPlaybackController()
  assert.equal(controller.play(), null)
  assert.equal(controller.pause(), null)
  assert.equal(controller.seek(1000), null)
})

test("MediaPlaybackController: play()/pause()/seek() are rejected while an image is active — images have no playback", () => {
  const controller = new MediaPlaybackController()
  controller.activate(IMAGE_CUE)
  assert.equal(controller.play(), null)
  assert.equal(controller.pause(), null)
  assert.equal(controller.seek(1000), null)
})

test("MediaPlaybackController: clear() reports whether anything was actually cleared", () => {
  const controller = new MediaPlaybackController()
  assert.equal(controller.clear(), false) // nothing active — no-op

  controller.activate(VIDEO_CUE)
  assert.equal(controller.clear(), true)
  assert.equal(controller.currentPayloadForSync(), null)
})

test("MediaPlaybackController: currentPayloadForSync() returns null when nothing is active", () => {
  const controller = new MediaPlaybackController()
  assert.equal(controller.currentPayloadForSync(), null)
})

test("MediaPlaybackController: activating a new cue replaces whatever was active before", () => {
  const controller = new MediaPlaybackController()
  controller.activate(VIDEO_CUE)
  controller.pause()
  const payload = controller.activate(IMAGE_CUE)
  assert.deepEqual(payload, { cue: IMAGE_CUE })
  assert.equal(controller.play(), null) // the video's playback state is gone, not resumed underneath
})
