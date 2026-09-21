import { strict as assert } from "node:assert"
import test from "node:test"
import { NDIOutput, type NDIModule, type PaintSource } from "./ndi-output"

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
    emit(width = 2, height = 1) {
      listener?.({}, {}, { getSize: () => ({ width, height }), toBitmap: () => Buffer.alloc(width * height * 4) })
    },
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
  assert.deepEqual(sent, [8, 16])
  await output.stop()
})
