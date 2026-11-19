import { test } from "node:test"
import assert from "node:assert/strict"
import { createTextCompleter } from "./ai-provider"
import { ReferenceRepairer } from "./reference-repairer"
import { SemanticVerseProposer } from "./semantic-verse-proposer"
import { TranscriptCleaner } from "./transcript-cleaner"
import { SermonCopilot } from "./sermon-copilot"
import { ClaudeSermonNotes } from "./claude-sermon-notes"
import { LiveTranslator } from "./live-translator"
import { ServiceExtrasGenerator } from "./service-extras"
import type { SessionEntry } from "../core/session-recorder"

/**
 * Every AI helper, end to end through the REAL provider clients and the real guard, with only the
 * network faked. Proves the wiring (request shape, response parsing, error classification) for both
 * providers without a live key. What it cannot prove: that the live services accept the model ids
 * and parameters today (see audit-notes/ai-features.md for the manual smoke test).
 */

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Fake provider network. `answer` is what the model "says"; `reasoning` is the hidden reasoning a Groq gpt-oss model burns first. */
function fakeNetwork(provider: "anthropic" | "groq", state: { answer: string; status?: number; reasoning?: number }, seen: Seen[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    if (init?.method === "GET") return new Response("{}", { status: 404 }) // availability probes are not part of these tests
    seen.push({ url: target, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) })
    if (state.status && state.status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: state.status })
    if (provider === "anthropic") {
      return new Response(JSON.stringify({ content: [{ type: "text", text: state.answer }], stop_reason: "end_turn" }), { status: 200 })
    }
    const cap = (JSON.parse(String(init?.body)) as { max_completion_tokens: number }).max_completion_tokens
    const out = cap <= (state.reasoning ?? 0) ? { content: "", finish_reason: "length" } : { content: state.answer, finish_reason: "stop" }
    return new Response(JSON.stringify({ choices: [{ message: { content: out.content }, finish_reason: out.finish_reason }] }), { status: 200 })
  }) as typeof fetch
}

const ENTRIES: SessionEntry[] = [
  { reference: { book: "john", chapter: 3, verse: 16 }, text: "For God so loved the world...", translation: "kjv", timestamp: 1_700_000_000_000 },
]
const NOTES = "- Dieu est fidèle en toute saison / God is faithful in every season"

for (const provider of ["anthropic", "groq"] as const) {
  test(`mocked HTTP (${provider}): every helper gets a usable answer through the real client`, async () => {
    const state = { answer: "", reasoning: provider === "groq" ? 400 : 0 }
    const seen: Seen[] = []
    const config = provider === "anthropic" ? { aiProvider: "anthropic" as const, anthropicApiKey: "sk-ant-test-0123456789" } : { aiProvider: "groq" as const, groqApiKey: "gsk_test_0123456789" }
    const completer = createTextCompleter(config, fakeNetwork(provider, state, seen))
    assert.ok(completer, "a completer exists when the chosen provider has its key")

    state.answer = '{"book":"Romains","chapter":8,"verse":28}'
    assert.deepEqual(await new ReferenceRepairer(completer).repair("Romains huit vingt-huit", null), { book: "Romains", chapter: 8, verse: 28 })

    state.answer = '{"book":"Jean","chapter":3,"verse":16,"confidence":"high"}'
    const proposal = await new SemanticVerseProposer(completer).propose("Dieu a tant aimé le monde qu'il a donné son Fils unique", null)
    assert.deepEqual(proposal && { book: proposal.book, chapter: proposal.chapter, verse: proposal.verse }, { book: "Jean", chapter: 3, verse: 16 })

    state.answer = "Lisons Corinthiens 13 verset 4"
    assert.equal(await new TranscriptCleaner(completer).clean("Lisons Corentin 13 verset 4"), "Lisons Corinthiens 13 verset 4")

    state.answer = '{"relatedVerses":[{"book":"Romains","chapter":5,"verse":8}],"keyPoint":{"caption":"God loves us","slide":["Love first"]}}'
    const draft = await new SermonCopilot(completer).suggest("The preacher talks about the love of God", [])
    assert.equal(draft?.relatedVerses[0]?.book, "Romains")
    assert.equal(draft?.keyPoint?.caption, "God loves us")

    state.answer = "- La grâce suffit / Grace is enough"
    assert.match(await new ClaudeSermonNotes(completer).summarize("La grâce de Dieu suffit"), /grâce/)

    state.answer = "God is good"
    assert.equal(await new LiveTranslator(completer).translate("Dieu est bon, toujours bon, pour tous", "fr", "en"), "God is good")

    state.answer = JSON.stringify({ recapFr: "Un culte sur la grâce.", recapEn: "A service on grace.", verseCards: [1], noteQuotes: ["Dieu est fidèle en toute saison / God is faithful in every season"] })
    const extras = await new ServiceExtrasGenerator(completer).generate(ENTRIES, NOTES)
    assert.equal(extras.recap.en, "A service on grace.")
    assert.equal(extras.cards.length, 2)

    // Request shape: right endpoint, key only in the auth header, never in the body.
    assert.ok(seen.length >= 7)
    for (const request of seen) {
      assert.ok(!JSON.stringify(request.body).includes("test_0123456789") && !JSON.stringify(request.body).includes("test-0123456789"))
      assert.equal(request.url, provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://api.groq.com/openai/v1/chat/completions")
    }
    assert.equal(completer.currentStatus().state, "ok")
  })

  test(`mocked HTTP (${provider}): a rate limit is classified and surfaced, then the test connection recovers`, async () => {
    const state: { answer: string; status?: number } = { answer: "OK", status: provider === "anthropic" ? 529 : 429 }
    const config = provider === "anthropic" ? { aiProvider: "anthropic" as const, anthropicApiKey: "sk-ant-test-0123456789" } : { aiProvider: "groq" as const, groqApiKey: "gsk_test_0123456789" }
    const completer = createTextCompleter(config, fakeNetwork(provider, state, []), { failureThreshold: 2 })
    assert.ok(completer)
    const seenStatus: string[] = []
    completer.subscribeStatus((status) => seenStatus.push(`${status.state}:${status.reason}`))
    for (let i = 0; i < 2; i++) await assert.rejects(new ReferenceRepairer(completer).repair("x", null))
    assert.deepEqual(completer.currentStatus(), { state: "paused", reason: "rate-limited" })
    assert.deepEqual(await completer.testConnection(), { ok: false, reason: "rate-limited" })
    state.status = 200
    assert.deepEqual(await completer.testConnection(), { ok: true })
    assert.deepEqual(completer.currentStatus(), { state: "ok" })
    assert.deepEqual(seenStatus, ["paused:rate-limited", "ok:undefined"])
  })
}

test("mocked HTTP (anthropic): a refused key is reported as 'auth' without ever carrying the key text", async () => {
  const completer = createTextCompleter(
    { aiProvider: "anthropic", anthropicApiKey: "sk-ant-test-0123456789" },
    fakeNetwork("anthropic", { answer: "", status: 401 }, []),
  )
  assert.ok(completer)
  const result = await completer.testConnection()
  assert.deepEqual(result, { ok: false, reason: "auth" })
  assert.ok(!JSON.stringify(result).includes("sk-ant"))
  assert.deepEqual(completer.currentStatus(), { state: "unavailable", reason: "auth" })
})
