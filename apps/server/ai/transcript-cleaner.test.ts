import { test } from "node:test"
import assert from "node:assert/strict"
import { AI_FEATURES, DEFAULT_AI_FEATURES, isAiFeature } from "./ai-features"
import { TranscriptCleaner, acceptCleanedText, looksReferenceRelated } from "./transcript-cleaner"

test("TranscriptCleaner: sends the sentence with a correct-only prompt and returns the corrected line", async () => {
  const seen: Array<{ system: string; user: string; timeoutMs?: number }> = []
  const cleaner = new TranscriptCleaner({
    complete: async (request) => {
      seen.push(request)
      return "  Ouvrez vos Bibles à Jean 3 verset 16  "
    },
  })
  assert.equal(await cleaner.clean("Ouvrez vos Bibles à Jonn 3 verset 16"), "Ouvrez vos Bibles à Jean 3 verset 16")
  assert.equal(seen[0]?.user, "Ouvrez vos Bibles à Jonn 3 verset 16")
  assert.ok(seen[0]?.system.includes("Never add"))
  assert.ok((seen[0]?.timeoutMs ?? 0) > 0)
})

test("TranscriptCleaner: only the first 400 characters are ever sent", async () => {
  let sent = ""
  const cleaner = new TranscriptCleaner({ complete: async (request) => ((sent = request.user), "") })
  await cleaner.clean("mot ".repeat(300))
  assert.ok(sent.length <= 400)
})

test("acceptCleanedText: unchanged, multi-line, empty and implausibly different answers are all 'no correction'", () => {
  const original = "Ouvrez vos Bibles à Jonn 3 verset 16"
  assert.equal(acceptCleanedText(original, original), null)
  assert.equal(acceptCleanedText(original, "   "), null)
  assert.equal(acceptCleanedText(original, "Ouvrez vos Bibles à Jean 3\nverset 16"), null)
  assert.equal(acceptCleanedText(original, "Amen"), null)
  assert.equal(acceptCleanedText(original, "Ouvrez vos Bibles à Jean 3 verset 16 et ".concat("beaucoup ".repeat(30))), null)
  assert.equal(acceptCleanedText(original, '"Ouvrez vos Bibles à Jean 3 verset 16"'), "Ouvrez vos Bibles à Jean 3 verset 16")
})

test("TranscriptCleaner: a completer that never answers is cut off by the timeout, and a late rejection is not unhandled", async () => {
  let rejectLate: (error: Error) => void = () => {}
  const cleaner = new TranscriptCleaner(
    { complete: () => new Promise<string>((_resolve, reject) => { rejectLate = reject }) },
    30,
  )
  const startedAt = Date.now()
  await assert.rejects(cleaner.clean("Jean 3 verset 16"), /timed out/)
  assert.ok(Date.now() - startedAt < 1_000)
  rejectLate(new Error("late failure"))
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test("TranscriptCleaner: a failing completer rejects (the caller falls back to the raw text)", async () => {
  const cleaner = new TranscriptCleaner({ complete: async () => { throw new Error("Claude request failed (429)") } })
  await assert.rejects(cleaner.clean("Jean 3 verset 16"), /429/)
})

test("looksReferenceRelated: keywords, digits or a book name qualify; plain chatter does not", () => {
  const book = (text: string) => /romains/i.test(text)
  assert.equal(looksReferenceRelated("au verset sept", book), true)
  assert.equal(looksReferenceRelated("turn to page 12", book), true)
  assert.equal(looksReferenceRelated("lisons Romains", book), true)
  assert.equal(looksReferenceRelated("Dieu est bon tout le temps", book), false)
})

test("ai-features: three toggles, all OFF by default, and only known names are accepted", () => {
  assert.deepEqual([...AI_FEATURES], ["transcriptCleanup", "semanticDetection", "sermonCopilot"])
  assert.ok(AI_FEATURES.every((feature) => DEFAULT_AI_FEATURES[feature] === false))
  assert.equal(isAiFeature("transcriptCleanup"), true)
  assert.equal(isAiFeature("sermonNotes"), false)
  assert.equal(isAiFeature(undefined), false)
  assert.equal(isAiFeature({ toString: () => "transcriptCleanup" }), false)
})
