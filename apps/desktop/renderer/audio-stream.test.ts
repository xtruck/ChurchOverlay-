import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const source = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "audio-stream.js"), "utf8")

function createSender(maxBufferedBytes = 64 * 1024) {
  const context: { ChurchOverlayAudioStream?: { createAudioFrameSender: (limit?: number) => Sender } } = {}
  runInNewContext(source, context)
  const create = context.ChurchOverlayAudioStream?.createAudioFrameSender
  if (typeof create !== "function") throw new Error("audio stream helper did not register")
  return create(maxBufferedBytes)
}

type Sender = {
  send: (socket: MockSocket | null, samples: Int16Array, sequence: number, encode: (samples: Int16Array, sequence: number) => unknown) => boolean
  snapshot: () => {
    framesReceived: number
    framesSent: number
    droppedDisconnected: number
    droppedBackpressure: number
    sendFailures: number
    captureGaps: number
    lastOutcome: string
  }
  reset: () => void
}

type MockSocket = { readyState: number; bufferedAmount: number; send: (data: unknown) => void }

const encode = (samples: Int16Array, sequence: number) => ({ samples, sequence })

test("audio frame sender drops disconnected frames and recovers without queueing stale audio", () => {
  const sender = createSender()
  const sent: unknown[] = []
  const socket: MockSocket = { readyState: 1, bufferedAmount: 0, send: (data) => sent.push(data) }

  assert.equal(sender.send(null, new Int16Array([1]), 0, encode), false)
  assert.equal(sender.send(socket, new Int16Array([2]), 1, encode), true)
  assert.deepEqual(sent, [{ samples: new Int16Array([2]), sequence: 1 }])
  assert.deepEqual({ ...sender.snapshot() }, {
    framesReceived: 2,
    framesSent: 1,
    droppedDisconnected: 1,
    droppedBackpressure: 0,
    sendFailures: 0,
    captureGaps: 0,
    lastOutcome: "sent",
  })
})

test("audio frame sender bounds socket buffering and counts capture sequence gaps", () => {
  const sender = createSender(1024)
  let sent = 0
  const socket: MockSocket = { readyState: 1, bufferedAmount: 1024, send: () => sent++ }

  assert.equal(sender.send(socket, new Int16Array(1), 3, encode), false)
  socket.bufferedAmount = 0
  assert.equal(sender.send(socket, new Int16Array(1), 6, encode), true)
  assert.equal(sent, 1)
  assert.deepEqual({ ...sender.snapshot() }, {
    framesReceived: 2,
    framesSent: 1,
    droppedDisconnected: 0,
    droppedBackpressure: 1,
    sendFailures: 0,
    captureGaps: 2,
    lastOutcome: "sent",
  })
})

test("audio frame sender reports synchronous send failures without throwing", () => {
  const sender = createSender()
  const socket: MockSocket = { readyState: 1, bufferedAmount: 0, send: () => { throw new Error("closed") } }

  assert.equal(sender.send(socket, new Int16Array(1), 0, encode), false)
  assert.equal(sender.snapshot().sendFailures, 1)
  assert.equal(sender.snapshot().lastOutcome, "send-failed")
})

test("audio frame sender resets its bounded session counters", () => {
  const sender = createSender()
  sender.send(null, new Int16Array(1), 0, encode)
  sender.reset()

  assert.deepEqual({ ...sender.snapshot() }, {
    framesReceived: 0,
    framesSent: 0,
    droppedDisconnected: 0,
    droppedBackpressure: 0,
    sendFailures: 0,
    captureGaps: 0,
    lastOutcome: "idle",
  })
})

test("audio frame sender rejects invalid buffer limits", () => {
  assert.throws(() => createSender(0), /positive integer/)
  assert.throws(() => createSender(1.5), /positive integer/)
})
