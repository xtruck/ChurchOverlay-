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
