import { strict as assert } from "node:assert"
import test, { mock } from "node:test"
import {
  NDI_ACTIVE_FPS,
  NDI_IDLE_FPS,
  NDI_MAX_CONSECUTIVE_FAILURES,
  NDI_RECOVERY_BACKOFF_MS,
  NDIOutput,
  unpremultiplyBGRAInPlace,
  type NDIModule,
  type NDISender,
  type NDIVideoFrame,
  type PaintSource,
} from "./ndi-output"

function source() {
  let listener: Parameters<PaintSource["on"]>[1] | null = null
  return {
    on(_event: "paint", next: Parameters<PaintSource["on"]>[1]) {
      listener = next
    },
    off() {
      listener = null
    },
    setFrameRate() {},
    emit(width = 2, height = 1, fill?: number[]) {
      listener?.({}, {}, {
        getSize: () => ({ width, height }),
        toBitmap: () => {
          const buffer = Buffer.alloc(width * height * 4)
          if (fill) for (let i = 0; i < buffer.length; i++) buffer[i] = fill[i % fill.length] as number
          return buffer
        },
      })
    },
    get attached() {
      return listener !== null
    },
  }
}

function fakeModule(makeSender: () => NDISender): NDIModule & { sendCalls: number } {
  const module = {
    FOURCC_BGRA: "BGRA",
    FORMAT_TYPE_PROGRESSIVE: "progressive",
    sendCalls: 0,
    send: async () => {
      module.sendCalls++
      return makeSender()
    },
  }
  return module
}

/** Lets pending promise continuations run without touching the (mocked) timers. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Advances mocked time in small steps, letting async sends settle in between like a real event loop. */
async function advance(ms: number, step = 10): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    mock.timers.tick(step)
    await settle()
  }
}

test("NDIOutput: missing native module degrades to unavailable without throwing", async () => {
  const output = new NDIOutput("Test", null)
  assert.deepEqual(await output.start(source()), {
    state: "unavailable",
    reason: "NDI native module is not installed or compatible.",
    sourceName: "Test",
  })
})

test("NDIOutput: keeps one pending frame while a native send is in flight", async () => {
  const firstSend = { resolve: undefined as (() => void) | undefined }
  const sent: number[] = []
  const module: NDIModule = {
    FOURCC_BGRA: "BGRA",
    FORMAT_TYPE_PROGRESSIVE: "progressive",
    send: async () => ({
      video: async (frame) => {
        sent.push(frame.data.length)
        if (sent.length === 1) await new Promise<void>((resolve) => (firstSend.resolve = resolve))
      },
      destroy: async () => {},
    }),
  }
  const output = new NDIOutput("Test", module)
  const paint = source()
  assert.equal((await output.start(paint)).state, "running")
  paint.emit(2, 1)
  paint.emit(3, 1)
  paint.emit(4, 1)
  firstSend.resolve?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(sent.slice(0, 2), [8, 16])
  assert.equal(output.getStatus().stats?.framesSuperseded, 1, "the 3x1 frame was replaced before it could be sent")
  await output.stop()
})

test("unpremultiplyBGRAInPlace: converts translucent pixels to straight alpha and leaves opaque/clear ones alone", () => {
  // 50 % red, premultiplied: B=0 G=0 R=128 A=128  ->  straight R is 255.
  const half = Buffer.from([0, 0, 128, 128])
  assert.deepEqual([...unpremultiplyBGRAInPlace(half)], [0, 0, 255, 128])

  const opaque = Buffer.from([10, 20, 30, 255])
  assert.deepEqual([...unpremultiplyBGRAInPlace(opaque)], [10, 20, 30, 255])

  const clear = Buffer.from([0, 0, 0, 0])
  assert.deepEqual([...unpremultiplyBGRAInPlace(clear)], [0, 0, 0, 0])

  // Alpha channel itself is never touched.
  const mixed = Buffer.from([25, 50, 75, 100])
  assert.equal(unpremultiplyBGRAInPlace(mixed)[3], 100)
  assert.deepEqual([...mixed.subarray(0, 3)], [64, 128, 191]) // x * 255 / 100, rounded

  // Corrupt input (colour > alpha, impossible when premultiplied) clamps instead of wrapping.
  const corrupt = Buffer.from([200, 200, 200, 100])
  assert.deepEqual([...unpremultiplyBGRAInPlace(corrupt)], [255, 255, 255, 100])
})

test("unpremultiplyBGRAInPlace: ignores a trailing partial pixel and handles an empty buffer", () => {
  assert.equal(unpremultiplyBGRAInPlace(Buffer.alloc(0)).length, 0)
  const ragged = Buffer.from([0, 0, 128, 128, 7, 7])
  assert.deepEqual([...unpremultiplyBGRAInPlace(ragged)], [0, 0, 255, 128, 7, 7])
})

test("NDIOutput: frames reach the sender as straight alpha", async () => {
  const received: NDIVideoFrame[] = []
  const module = fakeModule(() => ({ video: async (frame) => void received.push(frame), destroy: async () => {} }))
  const output = new NDIOutput("Test", module)
  const paint = source()
  await output.start(paint)
  paint.emit(1, 1, [0, 0, 128, 128])
  await settle()
  assert.deepEqual([...(received[0] as NDIVideoFrame).data], [0, 0, 255, 128])
  assert.equal((received[0] as NDIVideoFrame).lineStrideBytes, 4)
  await output.stop()
})

test("NDIOutput: keeps the source alive with repeats — 30 fps while active, 10 fps when idle", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 })
  try {
    const sent: NDIVideoFrame[] = []
    const module = fakeModule(() => ({ video: async (frame) => void sent.push(frame), destroy: async () => {} }))
    const output = new NDIOutput("Test", module)
    const paint = source()
    await output.start(paint)
    paint.emit(2, 1)
    await settle()
    assert.equal(sent.length, 1, "the real repaint is sent immediately, not on the next tick")

    // Active window (2 s after the repaint): about NDI_ACTIVE_FPS frames per second.
    // 1 ms steps: a coarser test clock would quantize the 33 ms period up to a multiple of the step.
    await advance(1000, 1)
    const activeCount = sent.length - 1
    assert.ok(activeCount >= NDI_ACTIVE_FPS - 4 && activeCount <= NDI_ACTIVE_FPS + 1, `active repeats in 1 s: ${activeCount}`)

    // Idle: after the active window, about NDI_IDLE_FPS frames per second.
    await advance(3000, 1)
    const before = sent.length
    await advance(1000, 1)
    const idleCount = sent.length - before
    assert.ok(idleCount >= NDI_IDLE_FPS - 2 && idleCount <= NDI_IDLE_FPS + 1, `idle repeats in 1 s: ${idleCount}`)

    const stats = output.getStatus().stats
    assert.equal(stats?.width, 2)
    assert.ok((stats?.framesRepeated ?? 0) > 40)
    assert.equal(sent.at(-1)?.frameRateN, NDI_IDLE_FPS, "idle repeats declare the idle frame rate")
    await output.stop()
  } finally {
    mock.timers.reset()
  }
})

test("NDIOutput: a repeat never re-sends before the real repaint that is waiting", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 })
  try {
    const sizes: number[] = []
    const module = fakeModule(() => ({ video: async (frame) => void sizes.push(frame.xres), destroy: async () => {} }))
    const output = new NDIOutput("Test", module)
    const paint = source()
    await output.start(paint)
    paint.emit(2, 1)
    await settle()
    paint.emit(5, 1)
    await settle()
    assert.deepEqual(sizes.slice(0, 2), [2, 5])
    await output.stop()
  } finally {
    mock.timers.reset()
  }
})

test("NDIOutput: repeated send failures log once, enter error, and recover with backoff", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 3_000_000 })
  try {
    const logs: string[] = []
    let failing = true
    const destroyed: number[] = []
    let senderId = 0
    const module = fakeModule(() => {
      const id = ++senderId
      return {
        video: async () => {
          if (failing) throw new Error("receiver gone")
        },
        destroy: async () => void destroyed.push(id),
      }
    })
    const output = new NDIOutput("Test", module, (event) => logs.push(event))
    const paint = source()
    await output.start(paint)

    for (let i = 0; i < NDI_MAX_CONSECUTIVE_FAILURES; i++) {
      paint.emit(2, 1)
      await settle()
    }
    await settle()

    const failed = output.getStatus()
    assert.equal(failed.state, "error")
    assert.match(failed.reason ?? "", /retrying 1\/5 in 1 s/)
    assert.equal(failed.stats?.failures, NDI_MAX_CONSECUTIVE_FAILURES)
    assert.equal(logs.filter((event) => event === "ndi.frame-failed").length, 1, "one log line per failure streak, not per frame")
    assert.deepEqual(destroyed, [1], "the broken sender is destroyed")

    // Nothing is sent while backing off, even if the overlay keeps repainting.
    paint.emit(2, 1)
    await settle()
    assert.equal(module.sendCalls, 1)

    failing = false
    await advance(NDI_RECOVERY_BACKOFF_MS[0] as number)
    assert.equal(module.sendCalls, 2, "a fresh sender is created after the first backoff")
    assert.equal(output.getStatus().state, "running")
    assert.ok(logs.includes("ndi.recovered"))

    paint.emit(2, 1)
    await settle()
    assert.ok((output.getStatus().stats?.framesSent ?? 0) >= 1)
    await output.stop()
  } finally {
    mock.timers.reset()
  }
})

test("NDIOutput: gives up after the bounded number of recovery attempts and stays in error", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 4_000_000 })
  try {
    const logs: string[] = []
    const module = fakeModule(() => ({
      video: async () => {
        throw new Error("still broken")
      },
      destroy: async () => {},
    }))
    const output = new NDIOutput("Test", module, (event) => logs.push(event))
    const paint = source()
    await output.start(paint)

    for (let attempt = 0; attempt <= NDI_RECOVERY_BACKOFF_MS.length; attempt++) {
      for (let i = 0; i < NDI_MAX_CONSECUTIVE_FAILURES; i++) {
        paint.emit(2, 1)
        await settle()
      }
      await settle()
      await advance(NDI_RECOVERY_BACKOFF_MS[attempt] ?? 40_000)
    }

    const status = output.getStatus()
    assert.equal(status.state, "error")
    assert.match(status.reason ?? "", /5 recovery attempts did not help/)
    assert.ok(logs.includes("ndi.gave-up"))
    assert.equal(module.sendCalls, 1 + NDI_RECOVERY_BACKOFF_MS.length, "the original sender plus exactly the bounded retries")

    // Terminal: no further sender is ever created.
    await advance(120_000, 1000)
    assert.equal(module.sendCalls, 1 + NDI_RECOVERY_BACKOFF_MS.length)
    await output.stop()
  } finally {
    mock.timers.reset()
  }
})

test("NDIOutput: stop() during sender creation destroys the late sender instead of leaking it", async () => {
  let release: ((sender: NDISender) => void) | undefined
  const destroyed: string[] = []
  const module: NDIModule = {
    FOURCC_BGRA: "BGRA",
    FORMAT_TYPE_PROGRESSIVE: "progressive",
    send: () => new Promise<NDISender>((resolve) => (release = resolve)),
  }
  const output = new NDIOutput("Test", module)
  const paint = source()
  const starting = output.start(paint)
  await output.stop()
  release?.({ video: async () => {}, destroy: async () => void destroyed.push("late-sender") })
  await starting

  assert.deepEqual(destroyed, ["late-sender"])
  assert.equal(output.getStatus().state, "disabled")
  assert.equal(paint.attached, false, "no paint listener may survive a stop() that raced the start")
})

test("NDIOutput: a destroy() that rejects does not make stop() throw", async () => {
  const logs: string[] = []
  const module = fakeModule(() => ({
    video: async () => {},
    destroy: async () => {
      throw new Error("native teardown failed")
    },
  }))
  const output = new NDIOutput("Test", module, (event) => logs.push(event))
  await output.start(source())
  await assert.doesNotReject(output.stop())
  assert.equal(output.getStatus().state, "disabled")
  assert.ok(logs.includes("ndi.destroy-failed"))
})

test("NDIOutput: stats stay bounded and absent until the output has started", async () => {
  const output = new NDIOutput("Test", fakeModule(() => ({ video: async () => {}, destroy: async () => {} })))
  assert.equal(output.getStatus().stats, undefined)
  await output.start(source())
  const stats = output.getStatus().stats
  assert.deepEqual(
    { sent: stats?.framesSent, repeated: stats?.framesRepeated, superseded: stats?.framesSuperseded, failures: stats?.failures },
    { sent: 0, repeated: 0, superseded: 0, failures: 0 }
  )
  await output.stop()
  assert.equal(output.getStatus().stats, undefined)
})
