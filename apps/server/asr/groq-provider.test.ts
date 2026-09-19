import { test } from "node:test"
import assert from "node:assert/strict"
import { GroqProvider } from "./groq-provider"
import type { AudioFrame } from "../../../packages/contracts"

function makeFrame(sampleValues: number[], sequence = 0): AudioFrame {
  return { samples: Int16Array.from(sampleValues), sampleRate: 16000, sequence }
}

// One second of audio at 16kHz.
function oneSecondFrame(sequence = 0): AudioFrame {
  return makeFrame(new Array(16000).fill(1000), sequence)
}

type CapturedRequest = { url: string; init: RequestInit | undefined }

function fakeFetch(
  responseFactory: (captured: CapturedRequest) => Response,
  captured: CapturedRequest[] = []
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const record = { url: String(input), init }
    captured.push(record)
    return responseFactory(record)
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

test("GroqProvider: constructor requires an apiKey", () => {
  assert.throws(() => new GroqProvider({ apiKey: "" }))
})

test("GroqProvider: sendAudio() before start() throws", async () => {
  const provider = new GroqProvider({ apiKey: "test-key" })
  await assert.rejects(() => provider.sendAudio(oneSecondFrame()))
})

test("GroqProvider: automatically transcribes once the chunk duration is reached, emitting a final transcript", async () => {
  const captured: CapturedRequest[] = []
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000, // 1 second
    fetchImpl: fakeFetch(() => jsonResponse({ text: "For God so loved the world" }), captured),
  })

  const results: unknown[] = []
  provider.onTranscript((r) => results.push(r))

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0)) // exactly 1s of audio -> triggers a flush

  assert.equal(captured.length, 1)
  assert.equal(results.length, 1)
  const result = results[0] as { text: string; state: string; sequence: number }
  assert.equal(result.text, "For God so loved the world")
  assert.equal(result.state, "final")
  assert.equal(result.sequence, 1)
})

// ARCHITECTURE.md section 73: a confirmed real Whisper failure mode —
// fed unclear/ambient audio, it sometimes hallucinates fluent text in a
// language never spoken, instead of returning empty output. This app's
// only supported languages (French, English) are both pure Latin script,
// so any non-Latin-script result is noise, dropped at the source.
test("GroqProvider: a transcript containing non-Latin script (e.g. hallucinated Chinese) is silently dropped, not emitted or errored", async () => {
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "你好，世界" })),
  })
  const results: unknown[] = []
  const errors: Error[] = []
  provider.onTranscript((r) => results.push(r))
  provider.onError((e) => errors.push(e))

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(results.length, 0)
  assert.equal(errors.length, 0)
})

test("GroqProvider: a transcript mixing real French/English text with a stray non-Latin character is still dropped (whole-chunk, not partial)", async () => {
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "Turn to John 3:16 世界" })),
  })
  const results: unknown[] = []
  provider.onTranscript((r) => results.push(r))

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(results.length, 0)
})

test("GroqProvider: sends the expected multipart fields (model, response_format) and auth header", async () => {
  const captured: CapturedRequest[] = []
  const provider = new GroqProvider({
    apiKey: "test-key",
    model: "whisper-large-v3",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "x" }), captured),
  })
  provider.onTranscript(() => {})

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(captured.length, 1)
  const request = captured[0]
  assert.equal(request?.init?.method, "POST")
  const headers = request?.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, "Bearer test-key")

  const form = request?.init?.body as FormData
  assert.equal(form.get("model"), "whisper-large-v3")
  assert.equal(form.get("response_format"), "json")
  assert.ok(form.get("file") instanceof Blob)
})

test("GroqProvider: does not flush again until another full chunk accumulates, and increments sequence per chunk", async () => {
  const captured: CapturedRequest[] = []
  let callCount = 0
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => {
      callCount += 1
      return jsonResponse({ text: `chunk-${callCount}` })
    }, captured),
  })
  const results: { text: string; sequence: number; correlationId: string }[] = []
  provider.onTranscript((r) => results.push(r as (typeof results)[number]))

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0)) // triggers flush #1
  await provider.sendAudio(oneSecondFrame(1)) // triggers flush #2

  assert.equal(captured.length, 2)
  assert.equal(results.length, 2)
  assert.equal(results[0]?.sequence, 1)
  assert.equal(results[1]?.sequence, 2)
  assert.equal(results[0]?.correlationId, results[1]?.correlationId)
})

test("GroqProvider: stop() flushes any remaining buffered audio below the chunk threshold", async () => {
  const captured: CapturedRequest[] = []
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 5000, // 5s, never reached by a single 1s frame
    fetchImpl: fakeFetch(() => jsonResponse({ text: "partial buffer flushed on stop" }), captured),
  })
  const results: unknown[] = []
  provider.onTranscript((r) => results.push(r))

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0)) // below threshold, no flush yet
  assert.equal(captured.length, 0)

  await provider.stop()
  assert.equal(captured.length, 1)
  assert.equal(results.length, 1)
})

test("GroqProvider: stop() with no buffered audio does not make a request", async () => {
  const captured: CapturedRequest[] = []
  const provider = new GroqProvider({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => jsonResponse({ text: "should not be called" }), captured),
  })
  await provider.start()
  await provider.stop()
  assert.equal(captured.length, 0)
})

test("GroqProvider: a non-OK response with Groq's real error shape reports via onError, not a thrown exception", async () => {
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() =>
      jsonResponse(
        { error: { message: "The model `bad` does not exist", type: "invalid_request_error" } },
        404
      )
    ),
  })
  provider.onTranscript(() => {
    throw new Error("should not emit a transcript on failure")
  })

  const errors: Error[] = []
  provider.onError((e) => errors.push(e))

  await provider.start()
  await assert.doesNotReject(() => provider.sendAudio(oneSecondFrame(0)))

  assert.equal(errors.length, 1)
  assert.match(errors[0]?.message ?? "", /does not exist/)
})

test("GroqProvider: a 200 response missing the text field reports via onError", async () => {
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ x_groq: { id: "req_123" } })),
  })
  const errors: Error[] = []
  provider.onError((e) => errors.push(e))
  provider.onTranscript(() => {})

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(errors.length, 1)
})

test("GroqProvider: a network failure (fetch rejects) reports via onError, without throwing", async () => {
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: (async () => {
      throw new Error("network down")
    }) as typeof fetch,
  })
  const errors: Error[] = []
  provider.onError((e) => errors.push(e))
  provider.onTranscript(() => {})

  await provider.start()
  await assert.doesNotReject(() => provider.sendAudio(oneSecondFrame(0)))
  assert.equal(errors.length, 1)
  assert.match(errors[0]?.message ?? "", /network down/)
})

test("GroqProvider: start() resets state across sessions (new correlationId, sequence restarts)", async () => {
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "x" })),
  })
  const results: { sequence: number; correlationId: string }[] = []
  provider.onTranscript((r) => results.push(r as (typeof results)[number]))

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))
  await provider.stop()

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))
  await provider.stop()

  assert.equal(results.length, 2)
  assert.equal(results[0]?.sequence, 1)
  assert.equal(results[1]?.sequence, 1) // sequence restarted for the new session
  assert.notEqual(results[0]?.correlationId, results[1]?.correlationId)
})
