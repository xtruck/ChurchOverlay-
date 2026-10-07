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

class OpenSocket extends MockWebSocket {
  static last: OpenSocket | undefined
  constructor(url: string, options: unknown) {
    super(url, options)
    this.readyState = MockWebSocket.OPEN
    OpenSocket.last = this
    queueMicrotask(() => this.emit("open"))
  }
}

function jsonMessages(socket: MockWebSocket): { type?: string }[] {
  return socket.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item))
}

test("DeepgramProvider: URL carries endpointing and weighted biblical keywords for nova-2", () => {
  const provider = new DeepgramProvider({ apiKey: "k", language: "fr" })
  const url = new URL(provider.buildUrl())
  assert.equal(url.searchParams.get("endpointing"), "300")
  const keywords = url.searchParams.getAll("keywords")
  assert.ok(keywords.includes("Deutéronome:2"))
  assert.ok(keywords.includes("verset:2"))
  assert.equal(url.searchParams.getAll("keyterm").length, 0)
})

test("DeepgramProvider: nova-3 uses keyterm prompting instead of weighted keywords", () => {
  const url = new URL(new DeepgramProvider({ apiKey: "k", language: "en", model: "nova-3" }).buildUrl())
  assert.ok(url.searchParams.getAll("keyterm").includes("Deuteronomy"))
  assert.equal(url.searchParams.getAll("keywords").length, 0)
})

test("DeepgramProvider: biblical vocabulary can be switched off", () => {
  const url = new URL(new DeepgramProvider({ apiKey: "k", biblicalVocabulary: false }).buildUrl())
  assert.equal(url.searchParams.getAll("keywords").length, 0)
})

test("DeepgramProvider: setPlannedBooks boosts a rundown's own books, including common ones the static list excludes", () => {
  const provider = new DeepgramProvider({ apiKey: "k", language: "fr", model: "nova-3" })
  provider.setPlannedBooks(["john", "romans"])
  const keyterms = new URL(provider.buildUrl()).searchParams.getAll("keyterm")
  assert.ok(keyterms.includes("Jean"), "planned books include common names, unlike the static list")
  assert.ok(keyterms.includes("Romains"))
})

test("DeepgramProvider: setPlannedBooks takes effect on the NEXT buildUrl(), never mid-connection", () => {
  const provider = new DeepgramProvider({ apiKey: "k", language: "fr", model: "nova-3" })
  const before = new URL(provider.buildUrl()).searchParams.getAll("keyterm")
  assert.ok(!before.includes("Jean"))
  provider.setPlannedBooks(["john"])
  assert.ok(new URL(provider.buildUrl()).searchParams.getAll("keyterm").includes("Jean"))
})

test("DeepgramProvider: setPlannedBooks caps the number of added keyterms", () => {
  const provider = new DeepgramProvider({ apiKey: "k", language: "fr", model: "nova-3" })
  const manyBooks = ["genesis", "exodus", "leviticus", "numbers", "deuteronomy", "joshua", "judges", "ruth", "1 samuel", "2 samuel", "1 kings", "2 kings", "1 chronicles", "2 chronicles", "ezra", "nehemiah", "esther"]
  provider.setPlannedBooks(manyBooks)
  const before = new URL(provider.buildUrl()).searchParams.getAll("keyterm").length
  provider.setPlannedBooks([])
  const after = new URL(provider.buildUrl()).searchParams.getAll("keyterm").length
  assert.ok(before - after <= 15, "planned-book terms are bounded per connection")
})

test("DeepgramProvider: onUtteranceEnd sends Finalize so the final arrives without waiting for the endpointer", async () => {
  const provider = new DeepgramProvider({ apiKey: "k", WebSocketImpl: OpenSocket as never, keepAliveIntervalMs: 0 })
  await provider.start()
  await provider.onUtteranceEnd()
  assert.deepEqual(jsonMessages(OpenSocket.last!).map((m) => m.type), ["Finalize"])
  await provider.stop()
})

test("DeepgramProvider: onUtteranceEnd is a harmless no-op when not connected", async () => {
  const provider = new DeepgramProvider({ apiKey: "k" })
  await provider.onUtteranceEnd()
})

test("DeepgramProvider: sends KeepAlive during silence so Deepgram does not drop the socket", async () => {
  const provider = new DeepgramProvider({ apiKey: "k", WebSocketImpl: OpenSocket as never, keepAliveIntervalMs: 20 })
  await provider.start()
  await new Promise((resolve) => setTimeout(resolve, 75))
  const socket = OpenSocket.last!
  assert.ok(jsonMessages(socket).some((m) => m.type === "KeepAlive"))
  await provider.stop()
  const countAfterStop = socket.sent.length
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(socket.sent.length, countAfterStop, "no keepalive after stop()")
})

test("DeepgramProvider: no KeepAlive while audio is flowing", async () => {
  const provider = new DeepgramProvider({ apiKey: "k", WebSocketImpl: OpenSocket as never, keepAliveIntervalMs: 100 })
  await provider.start()
  const frame: AudioFrame = { samples: Int16Array.from([1]), sampleRate: 16000, sequence: 1 }
  for (let i = 0; i < 6; i++) {
    await provider.sendAudio(frame)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(jsonMessages(OpenSocket.last!).some((m) => m.type === "KeepAlive"), false)
  await provider.stop()
})

// ---- Hardening (ARCHITECTURE.md section 112) ------------------------------

test("DeepgramProvider: non-object JSON from the server (null, number, array) is ignored, never thrown", () => {
  const provider = new DeepgramProvider({ apiKey: "test" })
  const results: unknown[] = []
  provider.onTranscript((result) => results.push(result))
  const handle = (raw: string) => (provider as unknown as { handleMessage(raw: string): void }).handleMessage(raw)
  for (const raw of ["null", "42", '"text"', "[]", "true", '{"channel":null}', '{"channel":{"alternatives":"x"}}', '{"channel":{"alternatives":[null]}}', '{"channel":{"alternatives":[{"transcript":7}]}}']) {
    assert.doesNotThrow(() => handle(raw), raw)
  }
  assert.deepEqual(results, [])
})

test("DeepgramProvider: a throwing transcript callback is reported through onError, not thrown into the socket listener", () => {
  const provider = new DeepgramProvider({ apiKey: "test" })
  const errors: Error[] = []
  provider.onError((error) => errors.push(error))
  provider.onTranscript(() => {
    throw new Error("consumer boom")
  })
  assert.doesNotThrow(() =>
    (provider as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify({ is_final: true, channel: { alternatives: [{ transcript: "John 3:16" }] } })
    )
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /consumer boom/)
})

test("DeepgramProvider: start() fails after the connect timeout instead of hanging, and can be retried", async () => {
  const sockets: MockWebSocket[] = []
  class NeverOpens extends MockWebSocket {
    constructor(url: string, options: unknown) {
      super(url, options)
      sockets.push(this)
    }
  }
  const provider = new DeepgramProvider({
    apiKey: "test",
    connectTimeoutMs: 30,
    WebSocketImpl: NeverOpens as never,
  })
  await assert.rejects(() => provider.start(), /timed out/)
  // active was reset, so a second attempt is allowed rather than silently ignored.
  await assert.rejects(() => provider.start(), /timed out/)
  assert.equal(sockets.length, 2)
})

test("DeepgramProvider: language=multi switches Nova-2 to Nova-3, endpointing=100 and sends both languages' vocabulary", () => {
  const provider = new DeepgramProvider({ apiKey: "k", language: "multi" }) // default model is nova-2
  provider.setPlannedBooks(["john"])
  const url = new URL(provider.buildUrl())
  assert.equal(url.searchParams.get("language"), "multi")
  assert.equal(url.searchParams.get("model"), "nova-3")
  assert.equal(url.searchParams.get("endpointing"), "100")
  const keyterms = url.searchParams.getAll("keyterm")
  assert.ok(keyterms.includes("Jean") && keyterms.includes("John"), "planned book is boosted in both languages")
})

test("DeepgramProvider: an explicit endpointing wins over the multi default, and single-language URLs are unchanged", () => {
  const multi = new URL(new DeepgramProvider({ apiKey: "k", language: "multi", endpointingMs: 500 }).buildUrl())
  assert.equal(multi.searchParams.get("endpointing"), "500")
  const french = new URL(new DeepgramProvider({ apiKey: "k", language: "fr" }).buildUrl())
  assert.equal(french.searchParams.get("model"), "nova-2")
  assert.equal(french.searchParams.get("endpointing"), "300")
})
