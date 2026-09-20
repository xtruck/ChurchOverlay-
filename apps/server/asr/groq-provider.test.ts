import { test } from "node:test"
import assert from "node:assert/strict"
import { GroqProvider, MAX_PROMPT_CHARS, MAX_PROMPT_TOKENS, CONSERVATIVE_CHARS_PER_TOKEN } from "./groq-provider"
import type { AudioFrame } from "../../../packages/contracts"
import { Logger } from "../../../packages/shared/logger"

function capturingLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = []
  const logger = new Logger({ minLevel: "debug", write: (line) => lines.push(JSON.parse(line)) })
  return { logger, lines }
}

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

// ARCHITECTURE.md production audit (section 74): a debug-level (never
// warn) trace of every dropped chunk, so a report of "this bug is still
// happening" can be checked against a specific build's logs.
test("GroqProvider: a dropped non-Latin-script transcript is traced via the optional logger, truncated, at debug level", async () => {
  const { logger, lines } = capturingLogger()
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    logger,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "你好，世界。这是一段很长的被幻觉出来的中文文本，用来测试截断行为是否正常工作。" })),
  })
  provider.onTranscript(() => {})

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(lines.length, 1)
  const entry = lines[0] as { level: string; event: string; metadata: { textPreview: string } }
  assert.equal(entry.level, "debug")
  assert.equal(entry.event, "transcript.non-latin-script-dropped")
  assert.ok(entry.metadata.textPreview.length <= 80)
})

test("GroqProvider: a normal, accepted transcript logs nothing — the debug trace is only for dropped chunks", async () => {
  const { logger, lines } = capturingLogger()
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    logger,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "Turn to John 3:16" })),
  })
  provider.onTranscript(() => {})

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(lines.length, 0)
})

test("GroqProvider: without a logger configured, a dropped non-Latin-script transcript still doesn't throw", async () => {
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "你好，世界" })),
  })
  provider.onTranscript(() => {})

  await provider.start()
  await assert.doesNotReject(() => provider.sendAudio(oneSecondFrame(0)))
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

// TASK B: the prompt field is a real FormData field and its content comes
// from setCurrentVerseRef() — the actual last-shown reference, not a
// hard-coded value.
test("GroqProvider: prompt field is sent, includes the real current verse reference from setCurrentVerseRef()", async () => {
  const captured: CapturedRequest[] = []
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "x" }), captured),
  })
  provider.onTranscript(() => {})

  provider.setCurrentVerseRef("Jean 3:16")
  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(captured.length, 1)
  const form = captured[0]?.init?.body as FormData
  const prompt = form.get("prompt")
  assert.ok(typeof prompt === "string" && prompt.length > 0, "prompt field must be present")
  assert.ok(prompt.includes("Jean 3:16"), "prompt must contain the real current verse reference")
  assert.ok(prompt.includes("chapitre") && prompt.includes("verset"), "prompt must contain command keywords")
})

// TASK B: a very long reference must not blow Groq's documented 224-token
// prompt limit — the dynamic part is dropped whole (never truncated
// mid-word) when the budget is exceeded.
test("GroqProvider: an over-budget verse reference is dropped whole from the prompt, not truncated", async () => {
  const captured: CapturedRequest[] = []
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "x" }), captured),
  })
  provider.onTranscript(() => {})

  provider.setCurrentVerseRef("X".repeat(1000))
  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  const form = captured[0]?.init?.body as FormData
  const prompt = form.get("prompt") as string
  assert.ok(typeof prompt === "string" && prompt.length > 0)
  assert.ok(prompt.length <= MAX_PROMPT_CHARS, "prompt must stay within the character budget")
  assert.ok(!prompt.includes("XXXX"), "over-budget reference must be dropped, not truncated")
  assert.ok(prompt.includes("chapitre"), "static keyword base must survive")
})

// PROD AUDIT 2026-09 (point 5): the documented 224-token limit must be an
// enforced, testable invariant — not just a comment. The previous 800-char
// budget was derived from an English "~4 chars/token" rule that is too
// optimistic for accented French (~3.3-3.5), so 800 chars could exceed 224
// tokens. This test fails the build if the budget is ever raised back above
// the derivation, or if a real prompt is ever longer than the budget.
test("GroqProvider: the prompt never exceeds the documented 224-token budget, with or without a verse reference", async () => {
  // The budget itself must be derived from the documented limit, not chosen.
  assert.ok(
    MAX_PROMPT_CHARS <= MAX_PROMPT_TOKENS * CONSERVATIVE_CHARS_PER_TOKEN,
    `budget ${MAX_PROMPT_CHARS} chars exceeds ${MAX_PROMPT_TOKENS} tokens at ${CONSERVATIVE_CHARS_PER_TOKEN} chars/token`
  )

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
  provider.onTranscript(() => {})

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0)) // flush 1: static base only
  provider.setCurrentVerseRef("Jean 3:16")
  await provider.sendAudio(oneSecondFrame(1)) // flush 2: base + real reference

  assert.equal(captured.length, 2)
  const baseOnly = (captured[0]?.init?.body as FormData).get("prompt") as string
  const withRef = (captured[1]?.init?.body as FormData).get("prompt") as string

  assert.ok(baseOnly.length <= MAX_PROMPT_CHARS, `static base is ${baseOnly.length} chars, budget ${MAX_PROMPT_CHARS}`)
  assert.ok(withRef.length <= MAX_PROMPT_CHARS, `prompt with reference is ${withRef.length} chars, budget ${MAX_PROMPT_CHARS}`)
  assert.ok(withRef.includes("Jean 3:16"), "the reference must actually be present in the accepted prompt")
})

// PROD AUDIT 2026-09 (point 5): regression guard for the reported duplicate
// book name. Measured on the current source: 56 entries, 56 unique — the
// reported "jean listed twice (57 entries / 56 unique)" does NOT reproduce.
// This test pins uniqueness of the real, sent prompt so it cannot regress.
test("GroqProvider: the sent prompt lists no Bible book name twice", async () => {
  const captured: CapturedRequest[] = []
  const provider = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "x" }), captured),
  })
  provider.onTranscript(() => {})

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  const prompt = (captured[0]?.init?.body as FormData).get("prompt") as string
  // The prompt is "<keywords>. <book, book, ...>[. Référence actuelle: ...]"
  const bookSegment = prompt.split(". ")[1]
  assert.ok(typeof bookSegment === "string" && bookSegment.length > 0, "book segment must be present")

  const books = bookSegment.split(", ").map((b) => b.trim()).filter((b) => b.length > 0)
  assert.ok(books.length >= 50, `expected the full book list, got ${books.length} entries`)

  const duplicates = books.filter((b, i) => books.indexOf(b) !== i)
  assert.deepEqual(duplicates, [], `duplicate book names in prompt: ${duplicates.join(", ")}`)
})

// TASK B: clearVerse() — setCurrentVerseRef(null) — removes the reference
// from subsequent prompts (no stale reference leaking between verses).
test("GroqProvider: setCurrentVerseRef(null) clears the reference from the prompt", async () => {
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
  provider.onTranscript(() => {})

  await provider.start()
  provider.setCurrentVerseRef("Jean 3:16")
  await provider.sendAudio(oneSecondFrame(0)) // flush 1: ref present
  provider.setCurrentVerseRef(null)
  await provider.sendAudio(oneSecondFrame(1)) // flush 2: ref cleared

  assert.equal(captured.length, 2)
  const prompt1 = (captured[0]?.init?.body as FormData).get("prompt") as string
  const prompt2 = (captured[1]?.init?.body as FormData).get("prompt") as string
  assert.ok(prompt1.includes("Jean 3:16"))
  assert.ok(!prompt2.includes("Jean 3:16"))
})

// TASK B: FR/PT language divergence is observable in logs without altering
// the transcript. Requires the logger AND language: "fr" to be configured.
test("GroqProvider: a Portuguese-looking transcript under language 'fr' logs a language-divergence event, transcript unchanged", async () => {
  const { logger, lines } = capturingLogger()
  const captured: CapturedRequest[] = []
  const ptText = "Não, obrigado senhor deus da salvação eterna"
  const provider = new GroqProvider({
    apiKey: "test-key",
    language: "fr",
    logger,
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: ptText }), captured),
  })
  const results: { text: string }[] = []
  provider.onTranscript((r) => results.push(r as { text: string }))

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  assert.equal(results.length, 1)
  assert.equal(results[0]?.text, ptText, "transcript itself must not be altered")

  const divergences = lines.filter(
    (l) => (l as { event: string }).event === "transcript.language-divergence"
  )
  assert.equal(divergences.length, 1, "exactly one divergence event should be logged")
})

// ...and French text under language 'fr' logs no divergence event.
test("GroqProvider: a normal French transcript under language 'fr' logs no divergence event", async () => {
  const { logger, lines } = capturingLogger()
  const provider = new GroqProvider({
    apiKey: "test-key",
    language: "fr",
    logger,
    chunkDurationMs: 1000,
    fetchImpl: fakeFetch(() => jsonResponse({ text: "Turn with me to Jean chapitre 3 verset 16" })),
  })
  provider.onTranscript(() => {})

  await provider.start()
  await provider.sendAudio(oneSecondFrame(0))

  const divergences = lines.filter(
    (l) => (l as { event: string }).event === "transcript.language-divergence"
  )
  assert.equal(divergences.length, 0)
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
