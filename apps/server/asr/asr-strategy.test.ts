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

test("deepgramLanguageFor: bilingual code-switches (multi), never Deepgram's English default", () => {
  assert.equal(deepgramLanguageFor("french"), "fr")
  assert.equal(deepgramLanguageFor("bilingual"), "multi")
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

test("planAsr: offline-first keeps the streaming-first cloud order and never changes the plan shape", () => {
  assert.deepEqual(planAsr({ groqApiKey: "g", deepgramApiKey: "d", preferred: "offline-first" }), {
    kind: "failover",
    primary: "deepgram",
    strategy: "streaming-first",
  })
  assert.deepEqual(planAsr({ groqApiKey: "g", preferred: "offline-first" }), { kind: "groq-only" })
  assert.deepEqual(planAsr({ deepgramApiKey: "d", preferred: "offline-first" }), { kind: "deepgram-only" })
})

test("ASR_STRATEGIES: offline-first is a valid, opt-in value and the cloud-first ones are unchanged", async () => {
  const { ASR_STRATEGIES } = await import("./asr-strategy")
  assert.deepEqual([...ASR_STRATEGIES], ["batch-first", "streaming-first", "offline-first"])
})

test("asrChain: offline-first puts local in front ONLY when it is available; otherwise the cloud order is untouched", async () => {
  const { asrChain } = await import("./asr-strategy")
  const both = planAsr({ groqApiKey: "g", deepgramApiKey: "d", preferred: "offline-first" })
  assert.deepEqual(asrChain(both, true, true), ["local", "deepgram", "groq"])
  assert.deepEqual(asrChain(both, false, true), ["deepgram", "groq"], "unavailable local: cloud-first, not a broken chain")
  assert.deepEqual(asrChain(planAsr({ groqApiKey: "g" }), true, true), ["local", "groq"])
  // The default behavior is untouched when offlineFirst is not requested.
  assert.deepEqual(asrChain(both, true), ["deepgram", "groq", "local"])
  assert.deepEqual(asrChain(both, true, false), ["deepgram", "groq", "local"])
})

test("asrChain: offline engine is always the last resort when available", async () => {
  const { asrChain } = await import("./asr-strategy")
  assert.deepEqual(asrChain(planAsr({ groqApiKey: "g", deepgramApiKey: "d" }), true), ["deepgram", "groq", "local"])
  assert.deepEqual(asrChain(planAsr({ groqApiKey: "g", deepgramApiKey: "d", preferred: "batch-first" }), false), ["groq", "deepgram"])
  assert.deepEqual(asrChain(planAsr({ groqApiKey: "g" }), true), ["groq", "local"])
  assert.deepEqual(asrChain(planAsr({ deepgramApiKey: "d" }), true), ["deepgram", "local"])
})
