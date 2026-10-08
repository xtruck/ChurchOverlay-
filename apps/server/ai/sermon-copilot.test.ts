import { test } from "node:test"
import assert from "node:assert/strict"
import { SermonCopilot, parseCopilotAnswer, MAX_CAPTION_CHARS, MAX_SLIDE_LINE_CHARS } from "./sermon-copilot"

test("parseCopilotAnswer: accepts a well-formed answer and keeps only plausible references", () => {
  const draft = parseCopilotAnswer(
    JSON.stringify({
      relatedVerses: [
        { book: "Romains", chapter: 8, verse: 28 },
        "not an object",
        { book: "Jean", chapter: 3, verse: 16 },
        { book: "Jean", chapter: 0, verse: 1 },
        { book: "Psaumes", chapter: 23, verse: "1" },
      ],
      keyPoint: { caption: "Dieu agit pour notre bien", slide: ["Il est fidèle", "Il agit", ""] },
    }),
  )
  assert.deepEqual(draft?.relatedVerses, [
    { book: "Romains", chapter: 8, verse: 28 },
    { book: "Jean", chapter: 3, verse: 16 },
  ])
  assert.deepEqual(draft?.keyPoint, { caption: "Dieu agit pour notre bien", slide: ["Il est fidèle", "Il agit"] })
})

test("parseCopilotAnswer: output is bounded, stripped of control characters, and capped at 3 verses / 4 slide lines", () => {
  const draft = parseCopilotAnswer(
    JSON.stringify({
      relatedVerses: Array.from({ length: 6 }, (_, i) => ({ book: "Jean", chapter: 3, verse: i + 1 })),
      keyPoint: {
        caption: "x".repeat(500) + "\u0007\n",
        slide: ["a".repeat(300), "b\u0000c", "c", "d", "e", "f"],
      },
    }),
  )
  assert.equal(draft?.relatedVerses.length, 3)
  assert.equal(draft?.keyPoint?.caption.length, MAX_CAPTION_CHARS)
  assert.equal(draft?.keyPoint?.slide.length, 4)
  assert.ok(draft?.keyPoint?.slide.every((line) => line.length <= MAX_SLIDE_LINE_CHARS && !/[\u0000-\u001f]/.test(line)))
  assert.equal(draft?.keyPoint?.slide[1], "b c")
})

test("parseCopilotAnswer: nothing useful, prose, arrays and malformed JSON all give null", () => {
  assert.equal(parseCopilotAnswer('{"relatedVerses":[],"keyPoint":null}'), null)
  assert.equal(parseCopilotAnswer("Sorry, I cannot help"), null)
  assert.equal(parseCopilotAnswer("[1,2,3]"), null)
  assert.equal(parseCopilotAnswer('{"relatedVerses": [broken'), null)
  assert.equal(parseCopilotAnswer('{"keyPoint":{"caption":"","slide":[]}}'), null)
})

test("parseCopilotAnswer: HTML or script in AI text is kept as inert text (the dashboard renders textContent only)", () => {
  const draft = parseCopilotAnswer('{"keyPoint":{"caption":"<img src=x onerror=alert(1)>","slide":["<script>x</script>"]}}')
  assert.equal(draft?.keyPoint?.caption, "<img src=x onerror=alert(1)>")
})

test("SermonCopilot: sends only the recent text and the shown references, with a no-chat, JSON-only prompt", async () => {
  const seen: Array<{ system: string; user: string; maxTokens?: number }> = []
  const copilot = new SermonCopilot({
    complete: async (request) => {
      seen.push(request)
      return '{"keyPoint":{"caption":"Grâce","slide":["Par la foi"]}}'
    },
  })
  const draft = await copilot.suggest("mot ".repeat(2_000) + "FIN", ["john 3:16"])
  assert.equal(draft?.keyPoint?.caption, "Grâce")
  assert.ok((seen[0]?.user.length ?? 0) < 3_200 && seen[0]?.user.includes("FIN"))
  assert.ok(seen[0]?.user.includes("john 3:16"))
  assert.ok(seen[0]?.system.includes("JSON only"))
  assert.ok(seen[0]?.system.includes("Never invent"))
})

test("SermonCopilot: a failing completer rejects", async () => {
  const copilot = new SermonCopilot({ complete: async () => { throw new Error("Claude request failed (529)") } })
  await assert.rejects(copilot.suggest("texte", []), /529/)
})
