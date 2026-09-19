import { test } from "node:test"
import assert from "node:assert/strict"
import { HybridAsrProvider } from "./hybrid-provider"
import type { AudioFrame, TranscriptResult } from "../../../packages/contracts"

function makeFrame(sampleValues: number[], sequence = 0): AudioFrame {
  return { samples: Int16Array.from(sampleValues), sampleRate: 16000, sequence }
}

function oneSecondFrame(sequence = 0): AudioFrame {
  return makeFrame(new Array(16000).fill(1000), sequence)
}

type CapturedRequest = { url: string; init: RequestInit | undefined }

function fakeFetch(responseFactory: () => Response, captured: CapturedRequest[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured.push({ url: String(input), init })
    return responseFactory()
  }) as typeof fetch
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

test("HybridAsrProvider: with no apiKey, hasRealProvider() is false and sendAudio()/start()/stop() are safe no-ops", async () => {
  const provider = new HybridAsrProvider()
  assert.equal(provider.hasRealProvider(), false)
  await assert.doesNotReject(() => provider.start())
  await assert.doesNotReject(() => provider.sendAudio(oneSecondFrame()))
  await assert.doesNotReject(() => provider.stop())
})

test("HybridAsrProvider: emitText() works with no apiKey configured — dry-run testing never depends on Groq", () => {
  const provider = new HybridAsrProvider()
  const results: TranscriptResult[] = []
  provider.onTranscript((r) => results.push(r))

  provider.emitText("Turn to John 3:16.")

  assert.equal(results.length, 1)
  assert.equal(results[0]?.text, "Turn to John 3:16.")
  assert.equal(results[0]?.state, "final")
})

test("HybridAsrProvider: constructing with an apiKey makes hasRealProvider() true immediately", () => {
  const provider = new HybridAsrProvider({ apiKey: "test-key" })
  assert.equal(provider.hasRealProvider(), true)
})

test("HybridAsrProvider: setApiKey() with a real key enables real transcription, routed through the same onTranscript callback as emitText()", async () => {
  const captured: CapturedRequest[] = []
  const provider = new HybridAsrProvider({
    fetchImpl: fakeFetch(() => jsonResponse({ text: "For God so loved the world" }), captured),
    chunkDurationMs: 1000,
  })
  const results: TranscriptResult[] = []
  provider.onTranscript((r) => results.push(r))

  assert.equal(provider.hasRealProvider(), false)
  provider.setApiKey("a-real-key")
  assert.equal(provider.hasRealProvider(), true)

  await provider.start()
  await provider.sendAudio(oneSecondFrame())

  assert.equal(captured.length, 1)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.text, "For God so loved the world")

  // The SAME callback also receives dry-run text — one unified pipeline
  // entry point regardless of which half produced the transcript.
  provider.emitText("Romans 8:28")
  assert.equal(results.length, 2)
  assert.equal(results[1]?.text, "Romans 8:28")
})

test("HybridAsrProvider: setApiKey('') clears the real provider back to the no-key state", () => {
  const provider = new HybridAsrProvider({ apiKey: "a-key" })
  assert.equal(provider.hasRealProvider(), true)
  provider.setApiKey("")
  assert.equal(provider.hasRealProvider(), false)
})

test("HybridAsrProvider: setApiKey() while the mic is already active starts the new real provider immediately, without a separate start() call", async () => {
  const captured: CapturedRequest[] = []
  const provider = new HybridAsrProvider({
    fetchImpl: fakeFetch(() => jsonResponse({ text: "x" }), captured),
    chunkDurationMs: 1000,
  })

  await provider.start() // active, but no real provider configured yet
  provider.setApiKey("a-real-key") // entered mid-session, e.g. via the web setup form

  await provider.sendAudio(oneSecondFrame())
  assert.equal(captured.length, 1) // reached the real provider without a second start() call
})

test("HybridAsrProvider: onError forwards from the real provider once configured", async () => {
  const provider = new HybridAsrProvider({
    fetchImpl: fakeFetch(() => new Response("not json", { status: 500 })),
    chunkDurationMs: 1000,
  })
  const errors: Error[] = []
  provider.onError((err) => errors.push(err))
  provider.setApiKey("a-real-key")

  await provider.start()
  await provider.sendAudio(oneSecondFrame())

  assert.equal(errors.length, 1)
})

test("HybridAsrProvider: stop() stops the real provider when one is configured and active", async () => {
  const provider = new HybridAsrProvider({ apiKey: "a-key" })
  await provider.start()
  await assert.doesNotReject(() => provider.stop())
})
