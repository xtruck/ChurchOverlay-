import { test } from "node:test"
import assert from "node:assert/strict"
import { SermonNotesGenerator } from "./sermon-notes-generator"

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

function chatCompletionBody(content: string): unknown {
  return { choices: [{ message: { content } }] }
}

test("SermonNotesGenerator: constructor requires an apiKey", () => {
  assert.throws(() => new SermonNotesGenerator({ apiKey: "" }))
})

test("SermonNotesGenerator: summarize() posts to Groq's chat-completions endpoint with the transcript as the user message", async () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => jsonResponse(chatCompletionBody("- Point one\n- Point two")), captured),
  })

  const result = await generator.summarize("Today we are talking about grace and forgiveness.")

  assert.equal(result, "- Point one\n- Point two")
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.url, "https://api.groq.com/openai/v1/chat/completions")
  assert.equal(captured[0]?.init?.method, "POST")

  const body = JSON.parse(String(captured[0]?.init?.body)) as {
    model: string
    messages: Array<{ role: string; content: string }>
  }
  assert.equal(typeof body.model, "string")
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0]?.role, "system")
  assert.equal(body.messages[1]?.role, "user")
  assert.equal(body.messages[1]?.content, "Today we are talking about grace and forgiveness.")
})

// ARCHITECTURE.md section 93: the post-service service-summary feature
// reuses this exact class with its own system prompt instead of the
// default sermon-notes one.
test("SermonNotesGenerator: summarize() uses a caller-supplied systemPrompt instead of the default when given one", async () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => jsonResponse(chatCompletionBody("A short recap.")), captured),
  })

  const result = await generator.summarize("verse list + notes text", "Write a short recap.")

  assert.equal(result, "A short recap.")
  const body = JSON.parse(String(captured[0]?.init?.body)) as { messages: Array<{ role: string; content: string }> }
  assert.equal(body.messages[0]?.content, "Write a short recap.")
})

test("SermonNotesGenerator: sends the API key via the Authorization header", async () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "gsk_my_secret_key",
    fetchImpl: fakeFetch(() => jsonResponse(chatCompletionBody("- A point")), captured),
  })
  await generator.summarize("Some transcript text.")

  const headers = captured[0]?.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, "Bearer gsk_my_secret_key")
})

test("SermonNotesGenerator: throws with the Groq-reported error message on a non-OK response", async () => {
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => jsonResponse({ error: { message: "invalid model" } }, 400)),
  })
  await assert.rejects(() => generator.summarize("text"), /invalid model/)
})

test("SermonNotesGenerator: throws a generic error when a non-OK response has no parseable error message", async () => {
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => new Response("not json", { status: 500 })),
  })
  await assert.rejects(() => generator.summarize("text"), /status 500/)
})

test("SermonNotesGenerator: throws if the response has no message content", async () => {
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => jsonResponse({ choices: [] })),
  })
  await assert.rejects(() => generator.summarize("text"), /did not include message content/)
})

test("SermonNotesGenerator: trims whitespace from the returned notes", async () => {
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => jsonResponse(chatCompletionBody("  \n- A point\n  "))),
  })
  const result = await generator.summarize("text")
  assert.equal(result, "- A point")
})

// PROD AUDIT 2026-09 circuit breaker: the production journal showed 7
// identical requests in ~9 minutes against an unavailable model. A
// permanent model error must disable the generator after ONE attempt.
test("SermonNotesGenerator: circuit breaker trips on model_decommissioned — exactly one request, no retry storm", async () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(
      () =>
        jsonResponse(
          {
            error: {
              code: "model_decommissioned",
              message: "The model `llama-3.1-8b-instant` has been decommissioned and is no longer available.",
            },
          },
          400
        ),
      captured
    ),
  })

  await assert.rejects(() => generator.summarize("text"), /decommissioned/)
  // A second summarize() must not hit the network at all.
  await assert.rejects(() => generator.summarize("more text"), /disabled for this session/)
  assert.equal(captured.length, 1, `expected exactly 1 request, got ${captured.length}`)
})

test("SermonNotesGenerator: circuit breaker also trips on the 'does not exist' wording", async () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(
      () => jsonResponse({ error: { message: "The model `nope` does not exist" } }, 404),
      captured
    ),
  })

  await assert.rejects(() => generator.summarize("text"), /does not exist/)
  await assert.rejects(() => generator.summarize("text"), /disabled for this session/)
  assert.equal(captured.length, 1)
})

test("SermonNotesGenerator: transient errors (500) do NOT trip the circuit breaker — each call retries normally", async () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => new Response("server error", { status: 500 }), captured),
  })

  await assert.rejects(() => generator.summarize("text"), /status 500/)
  await assert.rejects(() => generator.summarize("text"), /status 500/)
  // Both attempts reached the network — the breaker did not trip.
  assert.equal(captured.length, 2)
})

test("SermonNotesGenerator: circuit breaker trips on the real access/tier wording observed in production", async () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(
      () =>
        jsonResponse(
          { error: { message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it." } },
          404
        ),
      captured
    ),
  })

  await assert.rejects(() => generator.summarize("text"), /do not have access/)
  await assert.rejects(() => generator.summarize("text"), /disabled for this session/)
  assert.equal(captured.length, 1, "the breaker must stop the request storm after one attempt")
})

test("SermonNotesGenerator: default model is openai/gpt-oss-20b, a Production model with published developer-plan pricing", () => {
  const captured: CapturedRequest[] = []
  const generator = new SermonNotesGenerator({
    apiKey: "test-key",
    fetchImpl: fakeFetch(() => jsonResponse(chatCompletionBody("- x")), captured),
  })
  void generator.summarize("text")
  const body = JSON.parse(String(captured[0]?.init?.body)) as { model: string }
  assert.equal(body.model, "openai/gpt-oss-20b")
  // The Llama entries on Groq's Supported Models page are now "Enterprise"
  // (Contact Sales), so they are no longer the right default for a normal
  // developer-plan API key. Asserted here to pin that decision.
  assert.notEqual(body.model, "llama-3.1-8b-instant")
  assert.notEqual(body.model, "llama-3.3-70b-versatile")
})
