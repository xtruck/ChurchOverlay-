import { test } from "node:test"
import assert from "node:assert/strict"
import { deepgramLanguageFor, planAsr } from "./asr-strategy"
import { biblicalVocabularyFor } from "./biblical-vocabulary"

test("planAsr: no key at all is refused", () => {
  assert.throws(() => planAsr({}), /Groq or Deepgram/)
  assert.throws(() => planAsr({ groqApiKey: "  ", deepgramApiKey: "" }), /Groq or Deepgram/)
})

test("planAsr: Groq only → groq-only", () => {
  assert.deepEqual(planAsr({ groqApiKey: "g" }), { kind: "groq-only" })
})

test("planAsr: Deepgram only → deepgram-only (used to crash at startup)", () => {
  assert.deepEqual(planAsr({ deepgramApiKey: "d", groqApiKey: "" }), { kind: "deepgram-only" })
})

test("planAsr: both keys default to streaming-first with Deepgram primary", () => {
  assert.deepEqual(planAsr({ groqApiKey: "g", deepgramApiKey: "d" }), {
    kind: "failover",
    primary: "deepgram",
    strategy: "streaming-first",
  })
})

test("planAsr: batch-first keeps Groq primary", () => {
  assert.deepEqual(planAsr({ groqApiKey: "g", deepgramApiKey: "d", preferred: "batch-first" }), {
    kind: "failover",
    primary: "groq",
    strategy: "batch-first",
  })
})

test("deepgramLanguageFor: bilingual listens in French, never Deepgram's English default", () => {
  assert.equal(deepgramLanguageFor("french"), "fr")
  assert.equal(deepgramLanguageFor("bilingual"), "fr")
  assert.equal(deepgramLanguageFor("english"), "en")
})

test("biblicalVocabularyFor: per-language lists, both when unknown, never common short names", () => {
  const fr = biblicalVocabularyFor("fr")
  const en = biblicalVocabularyFor("en")
  assert.ok(fr.includes("verset") && fr.includes("Deutéronome"))
  assert.ok(en.includes("verse") && en.includes("Deuteronomy"))
  assert.equal(biblicalVocabularyFor(undefined).length, fr.length + en.length)
  for (const common of ["Jean", "Marc", "John", "Mark", "Luc", "Luke"]) {
    assert.equal(biblicalVocabularyFor(undefined).includes(common), false, common)
  }
})

test("asrChain: offline engine is always the last resort when available", async () => {
  const { asrChain } = await import("./asr-strategy")
  assert.deepEqual(asrChain(planAsr({ groqApiKey: "g", deepgramApiKey: "d" }), true), ["deepgram", "groq", "local"])
  assert.deepEqual(asrChain(planAsr({ groqApiKey: "g", deepgramApiKey: "d", preferred: "batch-first" }), false), ["groq", "deepgram"])
  assert.deepEqual(asrChain(planAsr({ groqApiKey: "g" }), true), ["groq", "local"])
  assert.deepEqual(asrChain(planAsr({ deepgramApiKey: "d" }), true), ["deepgram", "local"])
})
