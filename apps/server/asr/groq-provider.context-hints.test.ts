import { test } from "node:test"
import assert from "node:assert/strict"
import { GroqProvider, MAX_PROMPT_CHARS, orderPromptBooks } from "./groq-provider"
import type { AudioFrame } from "../../../packages/contracts"

const oneSecond: AudioFrame = { samples: new Int16Array(16000).fill(1000), sampleRate: 16000, sequence: 0 }

function provider(): GroqProvider {
  return new GroqProvider({ apiKey: "test-key", fetchImpl: (async () => new Response("{}")) as typeof fetch })
}

function bookList(prompt: string): string[] {
  // "<commands>. <books>[. Référence actuelle: X]"
  const books = prompt.split(". ")[1] ?? ""
  return books.split(", ")
}

test("GroqProvider hints: without hints the prompt is exactly the former canonical one", () => {
  const p = provider()
  const before = p.currentPrompt()
  assert.ok(before.startsWith("chapitre, verset, suivant"))
  assert.equal(bookList(before)[0], "genèse")
  assert.equal(bookList(before).at(-1), "apocalypse")
  assert.equal(bookList(before).length, 56)
})

test("GroqProvider hints: the most relevant books come LAST (Whisper keeps the last 224 tokens, later ones weigh more)", () => {
  const p = provider()
  p.setContextHints({ focusBooks: ["romans", "john"], plannedBooks: ["psalm", "genesis"] })
  const books = bookList(p.currentPrompt())
  assert.deepEqual(books.slice(-4), ["psaumes", "genèse", "jean", "romains"], "plan, then focus oldest-to-newest, newest last")
  assert.equal(books.length, 56, "books are moved, never duplicated or added")
  assert.equal(new Set(books).size, 56)
})

test("GroqProvider hints: the current reference stays the final element, after the hinted books", () => {
  const p = provider()
  p.setContextHints({ focusBooks: ["john"], plannedBooks: [] })
  p.setCurrentVerseRef("Jean 3:16")
  const prompt = p.currentPrompt()
  assert.ok(prompt.endsWith(", jean. Référence actuelle: Jean 3:16"), prompt.slice(-60))
  assert.ok(prompt.length <= MAX_PROMPT_CHARS, "the 224-token character budget still holds")
})

test("GroqProvider hints: the prompt length never changes with hints, so the budget derivation still holds", () => {
  const p = provider()
  const base = p.currentPrompt().length
  p.setContextHints({ focusBooks: ["1 john", "2 corinthians"], plannedBooks: ["1 samuel", "2 samuel", "revelation", "nope"] })
  assert.equal(p.currentPrompt().length, base)
})

test("orderPromptBooks: one name per family (1/2 Samuel share 'samuel'), unknown ids ignored, deterministic", () => {
  const order = orderPromptBooks({ focusBooks: ["1 samuel"], plannedBooks: ["2 samuel", "unknown", "john"] })
  assert.deepEqual(order.slice(-2), ["jean", "samuel"])
  assert.equal(order.filter((name) => name === "samuel").length, 1)
  assert.deepEqual(order, orderPromptBooks({ focusBooks: ["1 samuel"], plannedBooks: ["2 samuel", "unknown", "john"] }))
  assert.deepEqual(orderPromptBooks({ focusBooks: [], plannedBooks: [] }), orderPromptBooks(null))
})

test("GroqProvider hints: read at flush time — the request carries the reordered prompt", async () => {
  const prompts: string[] = []
  const p = new GroqProvider({
    apiKey: "test-key",
    chunkDurationMs: 1000,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      prompts.push(String((init?.body as FormData).get("prompt")))
      return new Response(JSON.stringify({ text: "x" }))
    }) as typeof fetch,
  })
  p.onTranscript(() => {})
  await p.start()
  p.setContextHints({ focusBooks: ["acts"], plannedBooks: [] })
  await p.sendAudio(oneSecond)
  assert.equal(prompts.length, 1)
  assert.equal(bookList(prompts[0]!).at(-1), "actes")
})

test("GroqProvider hints: malformed hints never throw", () => {
  const p = provider()
  assert.doesNotThrow(() => p.setContextHints({ focusBooks: [1, null, "john"] as unknown as string[], plannedBooks: undefined as unknown as string[] }))
  assert.equal(bookList(p.currentPrompt()).at(-1), "jean")
})
