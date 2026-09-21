import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { DeepgramProvider } from "./deepgram-provider"
import type { AudioFrame } from "../../../packages/contracts"

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1
  readonly sent: (Buffer | string)[] = []
  readonly url: string
  readonly options: unknown
  readyState = 0

  constructor(url: string, options: unknown) {
    super()
    this.url = url
    this.options = options
  }

  send(data: Buffer | string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit("close")
  }

  fail(error: Error): void {
    this.emit("error", error)
  }
}

test("DeepgramProvider: requires an API key", () => {
  assert.throws(() => new DeepgramProvider({ apiKey: "" }))
})

test("DeepgramProvider: forwards final streaming results with confidence", () => {
  const provider = new DeepgramProvider({ apiKey: "test" })
  const results: unknown[] = []
  provider.onTranscript((result) => results.push(result))
  ;(provider as unknown as { handleMessage(raw: string): void }).handleMessage(
    JSON.stringify({
      is_final: true,
      channel: { alternatives: [{ transcript: "John 3:16", confidence: 0.97 }] },
    })
  )
  assert.equal(results.length, 1)
  assert.deepEqual(results[0], {
    id: (results[0] as { id: string }).id,
    correlationId: "",
    sequence: 1,
    text: "John 3:16",
    state: "final",
    providerConfidence: 0.97,
    timestamp: (results[0] as { timestamp: number }).timestamp,
  })
})

test("DeepgramProvider: opens the documented streaming URL and sends canonical PCM16 frames directly", async () => {
  let socket: MockWebSocket | undefined
  class CapturingWebSocket extends MockWebSocket {
    constructor(url: string, options: unknown) {
      super(url, options)
      socket = this
      this.readyState = MockWebSocket.OPEN
      queueMicrotask(() => this.emit("open"))
    }
  }

  const provider = new DeepgramProvider({
    apiKey: "deepgram-test",
    language: "fr",
    WebSocketImpl: CapturingWebSocket as never,
  })
  await provider.start()
  const frame: AudioFrame = { samples: Int16Array.from([1, 2, 3]), sampleRate: 16000, sequence: 1 }
  await provider.sendAudio(frame)

  assert.ok(socket)
  const parsed = new URL(socket.url)
  assert.equal(parsed.origin, "wss://api.deepgram.com")
  assert.equal(parsed.pathname, "/v1/listen")
  assert.equal(parsed.searchParams.get("model"), "nova-2")
  assert.equal(parsed.searchParams.get("language"), "fr")
  assert.equal(parsed.searchParams.get("encoding"), "linear16")
  assert.equal(parsed.searchParams.get("sample_rate"), "16000")
  assert.deepEqual(socket.sent[0], Buffer.from(frame.samples.buffer))
  await provider.stop()
})

test("DeepgramProvider: unexpected close reports once and permits a fresh start", async () => {
  const sockets: CapturingSocket[] = []
  class CapturingSocket extends MockWebSocket {
    constructor(url: string, options: unknown) {
      super(url, options)
      this.readyState = MockWebSocket.OPEN
      sockets.push(this)
      queueMicrotask(() => this.emit("open"))
    }
  }

  const provider = new DeepgramProvider({
    apiKey: "deepgram-test",
    WebSocketImpl: CapturingSocket as never,
  })
  const errors: Error[] = []
  provider.onError((error) => errors.push(error))

  await provider.start()
  const firstSocket = sockets[0]
  assert.ok(firstSocket)
  firstSocket.close()
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.message, "Deepgram WebSocket closed unexpectedly")

  await provider.start()
  assert.equal(sockets.length, 2)
  await provider.stop()
})

test("DeepgramProvider: failed connection resets state so a later start can retry", async () => {
  let attempts = 0
  class RetrySocket extends MockWebSocket {
    constructor(url: string, options: unknown) {
      super(url, options)
      attempts += 1
      if (attempts === 1) {
        queueMicrotask(() => this.fail(new Error("connection refused")))
      } else {
        this.readyState = MockWebSocket.OPEN
        queueMicrotask(() => this.emit("open"))
      }
    }
  }

  const provider = new DeepgramProvider({
    apiKey: "deepgram-test",
    WebSocketImpl: RetrySocket as never,
  })
  await assert.rejects(provider.start(), /connection refused/)
  await provider.start()
  assert.equal(attempts, 2)
  await provider.stop()
})
