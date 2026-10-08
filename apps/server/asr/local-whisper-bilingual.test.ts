import { test } from "node:test"
import assert from "node:assert/strict"
import { LocalWhisperProvider } from "./local-whisper-provider"
import {
  LANGUAGE_LOW_LOGPROB,
  LANGUAGE_MIN_DETECT_MS,
  LANGUAGE_REDETECT_EVERY_CLIPS,
  LanguageLock,
  meanLogprob,
  normalizeLanguage,
  pickFrEn,
} from "./language-lock"
import { DEFAULT_SEGMENT_THRESHOLDS, filterSegments } from "./segment-quality"
import { isPromptEcho } from "./prompt-echo"
import type { AudioFrame, TranscriptResult } from "../../../packages/contracts"

// ARCHITECTURE.md section 118: bilingual (auto) mode locks French/English instead of trusting Whisper's auto-detection.

function frame(ms: number): AudioFrame {
  return { samples: Int16Array.from(new Array((16000 * ms) / 1000).fill(1000)), sampleRate: 16000, sequence: 0 }
}

type Captured = { readonly fields: Map<string, string> }

function scriptedFetch(replies: ReadonlyArray<unknown>) {
  const calls: Captured[] = []
  const queue = [...replies]
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData
    const fields = new Map<string, string>()
    form.forEach((value, key) => {
      if (typeof value === "string") fields.set(key, value)
    })
    calls.push({ fields })
    return new Response(JSON.stringify(queue.shift() ?? { text: "" }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const endpoint = { baseUrl: "http://127.0.0.1:1", ensureStarted: async () => {}, stop: async () => {} }

/** Sends one clip of `ms` and waits until the provider has produced `wantResults` transcripts in total. */
async function clip(provider: LocalWhisperProvider, results: TranscriptResult[], ms: number, wantResults: number) {
  await provider.sendAudio(frame(ms))
  await provider.onUtteranceEnd()
  for (let i = 0; i < 200 && results.length < wantResults; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(results.length, wantResults, "the clip produced a transcript")
}

function setup(replies: unknown[], language?: string) {
  const fake = scriptedFetch(replies)
  const provider = new LocalWhisperProvider({ server: endpoint, language, fetchImpl: fake.fetchImpl })
  const results: TranscriptResult[] = []
  provider.onTranscript((r) => results.push(r))
  return { fake, provider, results }
}

const english = (extra: Record<string, unknown> = {}) => ({
  text: "Turn with me to John chapter three",
  language: "english",
  language_probabilities: { en: 0.93, fr: 0.04 },
  ...extra,
})
const french = (extra: Record<string, unknown> = {}) => ({
  text: "Ouvrons Jean chapitre trois",
  language: "french",
  language_probabilities: { fr: 0.9, en: 0.05 },
  ...extra,
})

// ---- language-lock.ts ----

test("normalizeLanguage: codes and whisper.cpp full names for French/English only", () => {
  assert.equal(normalizeLanguage("fr"), "fr")
  assert.equal(normalizeLanguage("French"), "fr")
  assert.equal(normalizeLanguage("english"), "en")
  assert.equal(normalizeLanguage("spanish"), null)
  assert.equal(normalizeLanguage(undefined), null)
})

test("pickFrEn: never a third language; margin is the winner's share of fr+en", () => {
  const pick = pickFrEn({ es: 0.7, en: 0.2, fr: 0.05 })
  assert.equal(pick?.language, "en")
  assert.ok(Math.abs((pick?.margin ?? 0) - 0.8) < 1e-9)
  assert.equal(pickFrEn({ es: 1 }), null)
  assert.equal(pickFrEn(undefined), null)
  assert.equal(pickFrEn({ fr: 0.3 })?.language, "fr", "a missing language counts as zero")
})

test("meanLogprob: ignores missing and non-finite values", () => {
  assert.equal(meanLogprob([undefined, Number.NaN]), null)
  assert.equal(meanLogprob([-0.2, undefined, -0.4]), -0.30000000000000004)
})

test("LanguageLock: detects first, reuses, re-detects every N clips, on doubt, and never on a short clip", () => {
  const lock = new LanguageLock()
  assert.equal(lock.needsDetection(500), true, "nothing to reuse yet, even for a short clip")
  lock.settle("fr", 0.95)
  lock.noteClip(-0.3, true)
  for (let i = 0; i < LANGUAGE_REDETECT_EVERY_CLIPS; i++) {
    assert.equal(lock.needsDetection(4000), false, `clip ${i + 1} reuses the lock`)
    lock.noteClip(-0.3, false)
  }
  assert.equal(lock.needsDetection(4000), true, "stale after N clips")
  assert.equal(lock.needsDetection(LANGUAGE_MIN_DETECT_MS - 1), false, "a short clip reuses the lock even when stale")
  lock.settle("en", 0.95)
  assert.equal(lock.needsDetection(4000), false)
  lock.noteClip(LANGUAGE_LOW_LOGPROB - 0.1, false)
  assert.equal(lock.needsDetection(4000), true, "a low-confidence decode doubts the lock")
  lock.settle("en", 0.5)
  assert.equal(lock.needsDetection(4000), true, "a weak detection margin is not trusted")
  lock.reset()
  assert.equal(lock.language, null)
})

// ---- LocalWhisperProvider, bilingual mode ----

test("bilingual: the detection clip sends auto + both-language prompt; English then locks and later clips are explicit", async () => {
  const { fake, provider, results } = setup([english(), { text: "and verse sixteen" }])
  provider.setPlannedBooks(["john"])
  await provider.start()
  await clip(provider, results, 3000, 1)
  const first = fake.calls[0]!.fields
  assert.equal(first.get("language"), "auto")
  assert.equal(first.has("no_language_probabilities"), false, "detection clips need the probabilities")
  assert.match(first.get("prompt")!, /Lecture biblique/)
  assert.match(first.get("prompt")!, /Bible reading/)
  assert.match(first.get("prompt")!, /Jean, John/, "both display names of the planned book")

  await clip(provider, results, 3000, 2)
  assert.equal(fake.calls.length, 2, "no re-decode, no second detection")
  const second = fake.calls[1]!.fields
  assert.equal(second.get("language"), "en")
  assert.equal(second.get("no_language_probabilities"), "true", "skips whisper.cpp's second language-detection pass")
  assert.match(second.get("prompt")!, /Bible reading/)
  assert.doesNotMatch(second.get("prompt")!, /Lecture biblique/, "the locked language gets its own prompt, no French bias")
})

test("bilingual: a third language chosen by the engine is overruled by the better of fr/en (one explicit re-decode)", async () => {
  const misfire = { text: "Abramos Juan capitulo tres", language: "spanish", language_probabilities: { es: 0.55, en: 0.4, fr: 0.03 } }
  const { fake, provider, results } = setup([misfire, { text: "Turn to John chapter three" }])
  await provider.start()
  await clip(provider, results, 3000, 1)
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[1]!.fields.get("language"), "en")
  assert.equal(results[0]?.text, "Turn to John chapter three")
})

test("bilingual: whisper.cpp deciding French when English is more probable is corrected the same way", async () => {
  const wrong = { text: "Tourne avec moi", language: "french", language_probabilities: { en: 0.6, fr: 0.38 } }
  const { fake, provider, results } = setup([wrong, { text: "Turn with me" }])
  await provider.start()
  await clip(provider, results, 3000, 1)
  assert.equal(fake.calls[1]!.fields.get("language"), "en")
  assert.equal(results[0]?.text, "Turn with me")
})

test("bilingual: a preacher switching language is picked up on the next detection", async () => {
  const replies: unknown[] = [english()]
  for (let i = 0; i < LANGUAGE_REDETECT_EVERY_CLIPS; i++) replies.push({ text: `en ${i}` })
  replies.push(french())
  const { fake, provider, results } = setup(replies)
  await provider.start()
  for (let i = 0; i < LANGUAGE_REDETECT_EVERY_CLIPS + 2; i++) await clip(provider, results, 3000, i + 1)
  const languages = fake.calls.map((call) => call.fields.get("language"))
  assert.deepEqual(languages, ["auto", ...new Array(LANGUAGE_REDETECT_EVERY_CLIPS).fill("en"), "auto"])
  await provider.sendAudio(frame(3000))
  await provider.onUtteranceEnd()
  for (let i = 0; i < 200 && fake.calls.length < LANGUAGE_REDETECT_EVERY_CLIPS + 3; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(fake.calls.at(-1)!.fields.get("language"), "fr")
  assert.doesNotMatch(fake.calls.at(-1)!.fields.get("prompt")!, /Bible reading/)
})

test("bilingual: a low avg_logprob clip under the lock triggers detection on the next clip", async () => {
  const shaky = { text: "mumble mumble", segments: [{ text: "mumble mumble", avg_logprob: -1.5, no_speech_prob: 0.01 }] }
  const { fake, provider, results } = setup([french(), shaky, french()])
  await provider.start()
  await clip(provider, results, 3000, 1)
  await clip(provider, results, 3000, 2)
  await clip(provider, results, 3000, 3)
  assert.deepEqual(
    fake.calls.map((call) => call.fields.get("language")),
    ["auto", "fr", "auto"],
  )
})

test("bilingual: a clip shorter than the minimum reuses the lock even when detection is due", async () => {
  const { fake, provider, results } = setup([english(), { text: "yes" }])
  await provider.start()
  await clip(provider, results, 3000, 1)
  await clip(provider, results, 800, 2)
  assert.equal(fake.calls[1]!.fields.get("language"), "en")
})

test("bilingual: no usable probabilities falls back to the language the engine decoded in, and nothing to lock keeps detecting", async () => {
  const noProbs = { text: "Ouvrons Jean", language: "french" }
  const unknown = { text: "???", language: "german" }
  const { fake, provider, results } = setup([noProbs, { text: "chapitre trois" }, unknown, { text: "again" }])
  await provider.start()
  await clip(provider, results, 3000, 1)
  await clip(provider, results, 3000, 2)
  // Unknown confidence (margin 0) is not trusted: the decoded language is used for this clip, the next one detects again.
  assert.equal(fake.calls[1]!.fields.get("language"), "auto")
  provider.setLanguage(undefined) // resets the lock
  await clip(provider, results, 3000, 3)
  await clip(provider, results, 3000, 4)
  assert.equal(fake.calls[2]!.fields.get("language"), "auto")
  assert.equal(fake.calls[3]!.fields.get("language"), "auto", "no lock was possible")
})

test("explicit French: unchanged behavior (explicit language, French prompt, never any detection request)", async () => {
  const { fake, provider, results } = setup([{ text: "Jean 3" }, { text: "verset 16" }], "fr")
  await provider.start()
  await clip(provider, results, 3000, 1)
  await clip(provider, results, 3000, 2)
  for (const call of fake.calls) {
    assert.equal(call.fields.get("language"), "fr")
    assert.match(call.fields.get("prompt")!, /Lecture biblique/)
    assert.doesNotMatch(call.fields.get("prompt")!, /Bible reading/)
    assert.equal(call.fields.get("no_language_probabilities"), "true")
  }
  assert.equal(fake.calls.length, 2)
})

test("explicit English: English prompt and language on every clip", async () => {
  const { fake, provider, results } = setup([{ text: "John 3" }], "en")
  await provider.start()
  await clip(provider, results, 3000, 1)
  assert.equal(fake.calls[0]!.fields.get("language"), "en")
  assert.match(fake.calls[0]!.fields.get("prompt")!, /Bible reading/)
  assert.doesNotMatch(fake.calls[0]!.fields.get("prompt")!, /Lecture biblique/)
})

test("bilingual: the prompt stays within the budget and keeps the newest words (front trimmed)", async () => {
  const { provider } = setup([])
  provider.setPlannedBooks(["genesis", "exodus", "leviticus", "numbers", "deuteronomy", "joshua", "judges", "ruth", "1 samuel", "2 samuel", "1 kings", "2 kings", "psalms", "proverbs", "isaiah", "jeremiah", "matthew", "mark", "luke", "john", "acts", "romans", "hebrews", "revelation"])
  const prompt = provider.buildPrompt()
  assert.ok(prompt.length <= 700)
  assert.match(prompt, /Revelation/, "the last (newest) book survives the trim")
})

test("bilingual: a prompt-echo retry keeps the locked language", async () => {
  const echo = "Bible reading: John chapter 3 verse 16, Psalm 23, Romans 8, Deuteronomy, Philippians."
  const { fake, provider, results } = setup([english({ text: echo }), { text: "Amen" }])
  await provider.start()
  await clip(provider, results, 3000, 1)
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[1]!.fields.has("prompt"), false, "retried without a prompt")
  assert.equal(fake.calls[1]!.fields.get("language"), "en")
})

// ---- Quality filters stay language-neutral ----

test("segment-quality: English segments are judged by the same scores as French ones", () => {
  const spoken = (text: string, noSpeech: number, logprob: number) => ({ text, noSpeechProb: noSpeech, avgLogprob: logprob })
  const fr = filterSegments([spoken("Lisons Jean chapitre trois", 0.1, -0.3), spoken("Merci d'avoir regardé", 0.95, -1.4)])
  const en = filterSegments([spoken("Let us read John chapter three", 0.1, -0.3), spoken("Thanks for watching", 0.95, -1.4)])
  assert.equal(fr.kept.length, 1)
  assert.equal(en.kept.length, 1)
  assert.equal(en.dropped[0]?.reason, "no-speech")
  assert.equal(DEFAULT_SEGMENT_THRESHOLDS.noSpeechProbMin, 0.8)
})

test("prompt echo: ordinary English preaching is not mistaken for the bilingual prompt", () => {
  const provider = new LocalWhisperProvider({ server: endpoint })
  const prompt = provider.buildPrompt()
  assert.equal(isPromptEcho("Turn with me to John chapter 3 verse 16 and let us read it together", prompt), false)
  assert.equal(isPromptEcho("Bible reading: John chapter 3 verse 16, Psalm 23, Romans 8, Deuteronomy, Philippians.", prompt), true)
})

test("English text passes through the provider unchanged (no French-only filter in the local path)", async () => {
  const text = "For God so loved the world that he gave his only Son, John 3:16."
  const { provider, results } = setup([english({ text, segments: [{ text, avg_logprob: -0.3, no_speech_prob: 0.02 }] })])
  await provider.start()
  await clip(provider, results, 3000, 1)
  assert.equal(results[0]?.text, text)
})
