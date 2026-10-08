import { test } from "node:test"
import assert from "node:assert/strict"
import { CallBudget, ClaudeClient } from "./claude-client"
import { ReferenceRepairer, parseRepairedReference } from "./reference-repairer"
import { LiveTranslator } from "./live-translator"
import { ClaudeSermonNotes } from "./claude-sermon-notes"

type Captured = { url: string; init: RequestInit | undefined }

function fakeFetch(body: unknown, status = 200, captured: Captured[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
}

test("ClaudeClient: posts to the Messages API with the key in a header and returns the text blocks", async () => {
  const captured: Captured[] = []
  const client = new ClaudeClient({
    apiKey: "sk-ant-secret-key-123",
    fetchImpl: fakeFetch({ content: [{ type: "text", text: " Bonjour " }] }, 200, captured),
  })
  const answer = await client.complete({ system: "S", user: "U", maxTokens: 50 })
  assert.equal(answer, "Bonjour")
  assert.equal(captured[0]?.url, "https://api.anthropic.com/v1/messages")
  const headers = captured[0]?.init?.headers as Record<string, string>
  assert.equal(headers["x-api-key"], "sk-ant-secret-key-123")
  assert.equal(headers["anthropic-version"], "2023-06-01")
  const body = JSON.parse(String(captured[0]?.init?.body)) as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: string }> }
  assert.equal(body.model, "claude-haiku-4-5-20251001")
  assert.equal(body.max_tokens, 50)
  assert.deepEqual(body.messages, [{ role: "user", content: "U" }])
})

test("ClaudeClient: an HTTP error rejects without leaking the key, and an empty key is refused", async () => {
  assert.throws(() => new ClaudeClient({ apiKey: "  " }))
  const client = new ClaudeClient({ apiKey: "sk-ant-secret-key-123", fetchImpl: fakeFetch({}, 429) })
  await assert.rejects(client.complete({ system: "S", user: "U" }), (error: Error) => {
    assert.ok(error.message.includes("429"))
    assert.ok(!error.message.includes("sk-ant-secret-key-123"))
    return true
  })
})

test("ClaudeClient: a hung request is aborted by the timeout", async () => {
  const hanging = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })) as unknown as typeof fetch
  const client = new ClaudeClient({ apiKey: "k", fetchImpl: hanging })
  await assert.rejects(client.complete({ system: "S", user: "U", timeoutMs: 20 }), /timed out/)
})

test("CallBudget: allows N calls per minute and recovers afterwards", () => {
  let now = 1_000
  const budget = new CallBudget(2, () => now)
  assert.equal(budget.tryTake(), true)
  assert.equal(budget.tryTake(), true)
  assert.equal(budget.tryTake(), false)
  now += 60_001
  assert.equal(budget.tryTake(), true)
})

test("parseRepairedReference: accepts a clean answer, tolerates prose around it, rejects everything doubtful", () => {
  assert.deepEqual(parseRepairedReference('{"book":"Jean","chapter":3,"verse":16}'), { book: "Jean", chapter: 3, verse: 16 })
  assert.deepEqual(parseRepairedReference('Sure: {"book":"John","chapter":3,"verse":16}.'), { book: "John", chapter: 3, verse: 16 })
  assert.equal(parseRepairedReference('{"none":true}'), null)
  assert.equal(parseRepairedReference("no idea"), null)
  assert.equal(parseRepairedReference('{"book":"Jean","chapter":0,"verse":16}'), null)
  assert.equal(parseRepairedReference('{"book":"Jean","chapter":3.5,"verse":16}'), null)
  assert.equal(parseRepairedReference('{"book":"Jean","chapter":999,"verse":1}'), null)
  assert.equal(parseRepairedReference('{"book":"","chapter":3,"verse":16}'), null)
})

test("ReferenceRepairer: sends the sentence and the on-screen book, and parses the answer", async () => {
  const seen: Array<{ system: string; user: string }> = []
  const repairer = new ReferenceRepairer({
    complete: async (request) => {
      seen.push(request)
      return '{"book":"Romains","chapter":8,"verse":28}'
    },
  })
  const result = await repairer.repair("allons à Romains huit euh vingt-huit", "Romains")
  assert.deepEqual(result, { book: "Romains", chapter: 8, verse: 28 })
  assert.ok(seen[0]?.user.includes("huit euh vingt-huit"))
  assert.ok(seen[0]?.user.includes("Romains"))
  assert.ok(seen[0]?.system.toLowerCase().includes("never guess"))
})

test("LiveTranslator: translates across languages, refuses same-language and empty answers", async () => {
  const translator = new LiveTranslator({ complete: async () => "  Lisons la parole.  " })
  assert.equal(await translator.translate("Let us read the word", "en", "fr"), "Lisons la parole.")
  assert.equal(await translator.translate("Let us read the word", "en", "en"), null)
  const empty = new LiveTranslator({ complete: async () => "   " })
  assert.equal(await empty.translate("Let us read the word", "en", "fr"), null)
})

test("ClaudeSermonNotes: asks for bilingual notes and passes only the recent transcript", async () => {
  const seen: Array<{ system: string; user: string }> = []
  const notes = new ClaudeSermonNotes({
    complete: async (request) => {
      seen.push(request)
      return "- Grâce / Grace"
    },
  })
  const text = "x".repeat(10_000) + "FIN"
  assert.equal(await notes.summarize(text), "- Grâce / Grace")
  assert.ok(seen[0]?.system.includes("French first"))
  assert.ok((seen[0]?.user.length ?? 0) <= 6_000 && seen[0]?.user.endsWith("FIN"))
})
