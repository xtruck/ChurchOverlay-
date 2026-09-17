import { test } from "node:test"
import assert from "node:assert/strict"
import { RundownController } from "./rundown-controller"
import type { Rundown } from "../../../packages/contracts"

const RUNDOWN: Rundown = {
  id: "01RUNDOWN",
  title: "Sunday Service",
  scenes: [
    { kind: "blank" },
    { kind: "announcement", title: "Welcome", body: "Glad you're here." },
    { kind: "media", mediaCueId: "01MEDIA" },
  ],
}

test("RundownController: load() activates the first scene", () => {
  const controller = new RundownController()
  const state = controller.load(RUNDOWN)
  assert.deepEqual(state, {
    rundownId: "01RUNDOWN",
    cursor: 0,
    scene: { kind: "blank" },
    interrupted: false,
  })
})

test("RundownController: load() with an empty rundown is a no-op", () => {
  const controller = new RundownController()
  const state = controller.load({ id: "01EMPTY", title: "Empty", scenes: [] })
  assert.equal(state, null)
})

test("RundownController: next()/previous() advance the cursor correctly", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)

  const advanced = controller.next()
  assert.equal(advanced?.cursor, 1)
  assert.deepEqual(advanced?.scene, { kind: "announcement", title: "Welcome", body: "Glad you're here." })

  const back = controller.previous()
  assert.equal(back?.cursor, 0)
  assert.deepEqual(back?.scene, { kind: "blank" })
})

test("RundownController: next() past the last scene is a no-op, cursor unchanged", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  controller.goto(2) // last scene
  assert.equal(controller.next(), null)
  assert.equal(controller.currentState()?.cursor, 2) // unchanged
})

test("RundownController: previous() before the first scene is a no-op, cursor unchanged", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  assert.equal(controller.previous(), null)
  assert.equal(controller.currentState()?.cursor, 0) // unchanged
})

test("RundownController: goto() with an out-of-range index is a no-op, cursor unchanged", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  assert.equal(controller.goto(-1), null)
  assert.equal(controller.goto(99), null)
  assert.equal(controller.currentState()?.cursor, 0)
})

test("RundownController: next()/previous()/goto()/interrupt() with no rundown loaded are all no-ops", () => {
  const controller = new RundownController()
  assert.equal(controller.next(), null)
  assert.equal(controller.previous(), null)
  assert.equal(controller.goto(0), null)
  assert.equal(controller.interrupt(), null)
  assert.equal(controller.resumeFromInterrupt(), null)
  assert.equal(controller.currentState(), null)
})

test("RundownController: loading a new rundown resets the cursor and discards any pause", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  controller.goto(2)
  controller.interrupt() // paused at cursor 2

  const OTHER: Rundown = { id: "01OTHER", title: "Other", scenes: [{ kind: "blank" }] }
  const state = controller.load(OTHER)
  assert.deepEqual(state, { rundownId: "01OTHER", cursor: 0, scene: { kind: "blank" }, interrupted: false })

  // The old pause must not resurrect itself on the new rundown.
  assert.equal(controller.resumeFromInterrupt(), null)
})

test("RundownController: interrupt() pauses the current scene and marks state interrupted", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  controller.next() // cursor 1, announcement scene

  const interrupted = controller.interrupt()
  assert.deepEqual(interrupted, {
    rundownId: "01RUNDOWN",
    cursor: 1,
    scene: { kind: "announcement", title: "Welcome", body: "Glad you're here." },
    interrupted: true,
  })
})

test("RundownController: resumeFromInterrupt() resumes exactly the scene that was paused", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  controller.next() // cursor 1
  controller.interrupt()

  const resumed = controller.resumeFromInterrupt()
  assert.deepEqual(resumed, {
    rundownId: "01RUNDOWN",
    cursor: 1,
    scene: { kind: "announcement", title: "Welcome", body: "Glad you're here." },
    interrupted: false,
  })
})

test("RundownController: resumeFromInterrupt() with nothing paused is a no-op", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  assert.equal(controller.resumeFromInterrupt(), null)
})

test("RundownController: a second interrupt() while already interrupted does not move the pause point", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  controller.next() // cursor 1
  controller.interrupt() // paused at 1

  // A second interrupting verse (e.g. another detection) must not silently
  // re-pause at whatever the cursor happens to be right now — there is no
  // "right now" cursor change between interrupts, but this guards the
  // invariant that the FIRST pause point is the one that gets restored.
  const secondInterrupt = controller.interrupt()
  assert.equal(secondInterrupt?.cursor, 1)
  assert.equal(secondInterrupt?.interrupted, true)

  const resumed = controller.resumeFromInterrupt()
  assert.equal(resumed?.cursor, 1)
})

test("RundownController: an explicit scene navigation during an interrupt discards the pause instead of resuming it", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  controller.next() // cursor 1
  controller.interrupt() // paused at 1

  const navigated = controller.next() // operator explicitly advances during the interrupt
  assert.deepEqual(navigated, {
    rundownId: "01RUNDOWN",
    cursor: 2,
    scene: { kind: "media", mediaCueId: "01MEDIA" },
    interrupted: false,
  })

  // The discarded pause must not resurrect itself later.
  assert.equal(controller.resumeFromInterrupt(), null)
})

test("RundownController: currentState() reflects the active scene without mutating anything", () => {
  const controller = new RundownController()
  controller.load(RUNDOWN)
  controller.next()
  const first = controller.currentState()
  const second = controller.currentState()
  assert.deepEqual(first, second)
  assert.equal(first?.cursor, 1)
})
