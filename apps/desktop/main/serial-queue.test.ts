import { test } from "node:test"
import assert from "node:assert/strict"
import { SerialQueue } from "./serial-queue"

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test("SerialQueue: overlapping steps never run concurrently and keep call order", async () => {
  const queue = new SerialQueue()
  const log: string[] = []
  let running = 0
  let maxRunning = 0
  const step = (name: string, ms: number) => async (): Promise<string> => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    log.push(`start ${name}`)
    await tick(ms)
    log.push(`end ${name}`)
    running -= 1
    return name
  }
  const results = await Promise.all([queue.run(step("a", 20)), queue.run(step("b", 1)), queue.run(step("c", 5))])
  assert.deepEqual(results, ["a", "b", "c"])
  assert.equal(maxRunning, 1)
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"])
})

test("SerialQueue: a rejected step reaches its own caller and does not block later steps", async () => {
  const queue = new SerialQueue()
  const failing = queue.run(async () => {
    throw new Error("boom")
  })
  const after = queue.run(async () => "still runs")
  await assert.rejects(failing, /boom/)
  assert.equal(await after, "still runs")
})
