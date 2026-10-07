import { test } from "node:test"
import assert from "node:assert/strict"
import { SemanticVerseProposer, parseSemanticProposal } from "./semantic-verse-proposer"

test("parseSemanticProposal: only an explicit 'high' confidence on a plausible reference is a proposal", () => {
  assert.deepEqual(parseSemanticProposal('{"book":"Jean","chapter":3,"verse":16,"confidence":"high"}'), {
    book: "Jean",
    chapter: 3,
    verse: 16,
    confidence: "high",
  })
  assert.deepEqual(parseSemanticProposal('Voici: {"book":"John","chapter":3,"verse":16,"confidence":"high"} merci')?.book, "John")
  assert.equal(parseSemanticProposal('{"book":"Jean","chapter":3,"verse":16,"confidence":"medium"}'), null)
  assert.equal(parseSemanticProposal('{"book":"Jean","chapter":3,"verse":16,"confidence":"low"}'), null)
  assert.equal(parseSemanticProposal('{"book":"Jean","chapter":3,"verse":16}'), null)
  assert.equal(parseSemanticProposal('{"none":true}'), null)
  assert.equal(parseSemanticProposal("not json"), null)
  assert.equal(parseSemanticProposal('{"book":"Jean","chapter":0,"verse":16,"confidence":"high"}'), null)
  assert.equal(parseSemanticProposal('{"book":"Jean","chapter":3,"verse":"16","confidence":"high"}'), null)
  assert.equal(parseSemanticProposal('{"book":"x'.padEnd(60, "x") + '","chapter":3,"verse":16,"confidence":"high"}'), null)
})

test("SemanticVerseProposer: sends only the recent window (bounded), tells the model to say none when unsure", async () => {
  const seen: Array<{ system: string; user: string; maxTokens?: number }> = []
  const proposer = new SemanticVerseProposer({
    complete: async (request) => {
      seen.push(request)
      return '{"book":"John","chapter":3,"verse":16,"confidence":"high"}'
    },
  })
  const proposal = await proposer.propose("mot ".repeat(1_000) + "FIN", "Romains")
  assert.equal(proposal?.chapter, 3)
  assert.ok((seen[0]?.user.length ?? 0) < 1_100 && seen[0]?.user.includes("FIN"))
  assert.ok(seen[0]?.user.includes("Romains"))
  assert.ok(seen[0]?.system.includes('{"none":true}'))
  assert.ok((seen[0]?.maxTokens ?? 1_000) <= 100)
})

test("SemanticVerseProposer: a failing completer rejects (the caller drops it silently)", async () => {
  const proposer = new SemanticVerseProposer({ complete: async () => { throw new Error("Claude request failed (500)") } })
  await assert.rejects(proposer.propose("texte"), /500/)
})
