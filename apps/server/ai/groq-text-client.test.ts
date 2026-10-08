import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_GROQ_TEXT_MODEL, GroqTextClient } from "./groq-text-client"

type Captured = { url: string; init: RequestInit }

function fakeFetch(respond: () => Response | Promise<Response>, captured: Captured[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    return respond()
  }) as typeof fetch
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

test("GroqTextClient: posts an OpenAI-style chat request with the key in the Authorization header and returns the trimmed text", async () => {
  const captured: Captured[] = []
  const client = new GroqTextClient({
    apiKey: "gsk_test_key_123456",
    fetchImpl: fakeFetch(() => ok({ choices: [{ message: { content: "  Jean 3:16  " } }] }), captured),
  })
  const answer = await client.complete({ system: "be strict", user: "say it", maxTokens: 80 })
  assert.equal(answer, "Jean 3:16")
  assert.equal(captured[0]?.url, "https://api.groq.com/openai/v1/chat/completions")
  const headers = captured[0]?.init.headers as Record<string, string>
  assert.equal(headers.authorization, "Bearer gsk_test_key_123456")
  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>
  assert.equal(body.model, DEFAULT_GROQ_TEXT_MODEL)
  assert.equal(body.max_completion_tokens, 80)
  assert.equal(body.temperature, 0)
  assert.deepEqual(body.messages, [
    { role: "system", content: "be strict" },
    { role: "user", content: "say it" },
  ])
})

test("GroqTextClient: an HTTP error rejects without leaking the key, and an empty key is refused", async () => {
  const client = new GroqTextClient({ apiKey: "gsk_secret_value_abcdef", fetchImpl: fakeFetch(() => new Response("nope", { status: 429 })) })
  await assert.rejects(client.complete({ system: "s", user: "u" }), (error: Error) => {
    assert.match(error.message, /429/)
    assert.ok(!error.message.includes("gsk_secret_value_abcdef"))
    return true
  })
  assert.throws(() => new GroqTextClient({ apiKey: "   " }), /apiKey/)
})

test("GroqTextClient: an error that mentions the key is scrubbed", async () => {
  const client = new GroqTextClient({
    apiKey: "gsk_secret_value_abcdef",
    fetchImpl: (async () => { throw new Error("socket hang up for Bearer gsk_secret_value_abcdef") }) as typeof fetch,
  })
  await assert.rejects(client.complete({ system: "s", user: "u" }), (error: Error) => !error.message.includes("gsk_secret_value_abcdef"))
})

test("GroqTextClient: a missing, empty or non-string completion is an empty answer, not a crash", async () => {
  for (const body of [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: 42 } }] }]) {
    const client = new GroqTextClient({ apiKey: "gsk_key_0123456789", fetchImpl: fakeFetch(() => ok(body)) })
    assert.equal(await client.complete({ system: "s", user: "u" }), "")
  }
})

test("GroqTextClient: a hung request is aborted by the timeout", async () => {
  const client = new GroqTextClient({
    apiKey: "gsk_key_0123456789",
    fetchImpl: ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as typeof fetch,
  })
  await assert.rejects(client.complete({ system: "s", user: "u", timeoutMs: 30 }), /timed out/)
})
