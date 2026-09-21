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
