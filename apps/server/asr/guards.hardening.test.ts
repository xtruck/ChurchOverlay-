import { test } from "node:test"
import assert from "node:assert/strict"
import { screenTranscript } from "./transcript-screen"
import { filterSegments, segmentThresholdsFor } from "./segment-quality"
import { LanguageLock, normalizeLanguage, offLanguageShare } from "./language-lock"
import { isBibleWord } from "./transcript-screen"
import { DropLedger } from "./drop-ledger"
import { MicDiagnostics } from "../audio/mic-diagnostics"

// Fix round: nothing real may be lost silently, and a deaf app must be visible.

// ---- D: transcript screen ----

test("screen: a music symbol or a credit clause never discards a transcript that also holds a reference", () => {
  const withNote = screenTranscript("♪ ouvrez Jean 3:16", { state: "final" })
  assert.equal(withNote.ok, true)
  assert.ok(withNote.ok && withNote.cleaned !== undefined && withNote.cleaned.includes("Jean 3:16") && !withNote.cleaned.includes("♪"))

  const withCredit = screenTranscript("Ouvrez vos Bibles. Sous-titres réalisés par la communauté d'Amara.org. Jean 3 16", { state: "final" })
  assert.equal(withCredit.ok, true)
  assert.ok(withCredit.ok && withCredit.cleaned !== undefined && /Jean 3 16/.test(withCredit.cleaned) && !/amara/i.test(withCredit.cleaned))
})

test("screen: pure credits, pure lyrics with no reference, and annotations are still rejected", () => {
  assert.equal(screenTranscript("Thank you for watching").ok, false)
  assert.equal(screenTranscript("Sous-titres réalisés par la communauté d'Amara.org").ok, false)
  assert.equal(screenTranscript("♪ la la la ♪").ok, false)
  assert.equal(screenTranscript("[Music]").ok, false)
})

test("screen: a clean transcript carries no `cleaned` field", () => {
  const verdict = screenTranscript("Ouvrez vos Bibles à Jean 3 16", { state: "final" })
  assert.deepEqual(verdict, { ok: true })
})

test("screen: genealogies and name lists are not rejected in normal or noisy mode", () => {
  const lists = [
    "Elkana Peninna Hanna Silo Éli Hophni Phinées Samuel Ramathaïm Tsophim",
    "Pasteur Kouassi Adjoua Konan Yao Kouamé Bamba Traoré Diallo Coulibaly",
    "Then Hezron fathered Ram and Ram fathered Amminadab and Amminadab fathered Nahshon",
  ]
  for (const mode of ["normal", "noisy"] as const) {
    for (const text of lists) assert.equal(screenTranscript(text, { mode, state: "final" }).ok, true, `${mode}: ${text}`)
  }
})

test("screen: real glossolalia is still dropped in every mode that has a rule for it", () => {
  const tongues = "shalala kandara shama lama kadoshi ba rasha mana sheka ondrai"
  assert.equal(screenTranscript(tongues, { mode: "tongues", state: "final" }).ok, false)
  assert.equal(screenTranscript("shalala kandara shama sheka ondrai", { mode: "tongues", state: "final" }).ok, false)
  assert.equal(screenTranscript("lalalala lalalala shashasha kakakaka", { mode: "tongues", state: "final" }).ok, false)
  // capitalised glossolalia (some engines capitalise every word) is not mistaken for names in tongues mode
  assert.equal(screenTranscript("Shalala Kandara Shama Sheka Ondrai", { mode: "tongues", state: "final" }).ok, false)
  // normal mode keeps the earlier rule for long lowercase gibberish
  assert.equal(screenTranscript(tongues, { mode: "normal", state: "final" }).ok, false)
})

test("screen: French and English number words count as known words", () => {
  for (const text of ["quarante cinquante soixante seize quatorze", "forty fifty sixty seventy eighty ninety fourteen sixteen"]) {
    assert.equal(screenTranscript(text, { mode: "tongues", state: "final" }).ok, true, text)
  }
})

// ---- E: segment floor ----

test("segments: the solo low-confidence rule spares references and navigation words, and counts them", () => {
  const segments = [
    { text: "Jean 3 16", noSpeechProb: 0.2, avgLogprob: -1.4 },
    { text: "verset douze", noSpeechProb: 0.2, avgLogprob: -1.4 },
    { text: "Romains huit", noSpeechProb: 0.2, avgLogprob: -1.4 },
    { text: "shalala kandara", noSpeechProb: 0.2, avgLogprob: -1.4 },
  ]
  const result = filterSegments(segments, segmentThresholdsFor("tongues"))
  assert.deepEqual(result.kept.map((s) => s.text), ["Jean 3 16", "verset douze", "Romains huit"])
  assert.equal(result.rescued, 3)
  assert.deepEqual(result.dropped.map((d) => d.reason), ["low-confidence"])
})

// ---- B: language normalisation and off-language judging ----

test("normalizeLanguage: regional tags and descriptive names count by primary subtag", () => {
  for (const tag of ["en-US", "en_GB", "English (US)", "EN-au"]) assert.equal(normalizeLanguage(tag), "en", tag)
  for (const tag of ["fr-FR", "fr-CA", "fr_BE", "French (Canada)", "français"]) assert.equal(normalizeLanguage(tag), "fr", tag)
  for (const tag of ["es-MX", "pt-BR", "hi", "spanish", "", "x"]) assert.equal(normalizeLanguage(tag), null, tag)
})

test("offLanguageShare: digits, Bible books and empty words are ignored; regional tags are not off-language", () => {
  const words = [
    { word: "Jean", language: "es" },
    { word: "3", language: "hi" },
    { word: "16", language: "hi" },
    { word: "ouvrez", language: "fr-CA" },
    { word: "vos", language: "fr-FR" },
    { word: "bibles", language: "en-US" },
    { word: "", language: "es" },
  ]
  const result = offLanguageShare(words, undefined, { skip: isBibleWord })
  assert.deepEqual(result, { share: 0, judged: 3 })
  assert.equal(offLanguageShare([], []), null)
  assert.equal(offLanguageShare(undefined, undefined), null)
})

// ---- C: language lock on short clips ----

test("LanguageLock: a doubtful lock may re-detect on a 1-2 s clip; a stale-by-count lock and clips under 1 s still reuse it", () => {
  const lock = new LanguageLock()
  lock.settle("fr", 0.95)
  lock.noteClip(-0.3, true)
  assert.equal(lock.needsDetection(1500), false)
  lock.noteClip(-1.2, false) // decoded badly under the lock: doubt
  assert.equal(lock.needsDetection(1500), true, "an English clip forced to French is caught on a short clip too")
  assert.equal(lock.needsDetection(600), false, "under 1 s nothing can be detected reliably")
})

// ---- ledger and diagnostics ----

test("DropLedger: per-minute counts expire, logs are rate limited, valves are tracked", () => {
  let now = 1_000_000
  const ledger = new DropLedger(() => now)
  const first = ledger.record("screen", "repetitive")
  assert.equal(first.log, true)
  for (let i = 0; i < 5; i++) assert.equal(ledger.record("screen", "repetitive").log, false)
  now += 6_000
  const later = ledger.record("screen", "repetitive")
  assert.equal(later.log, true)
  assert.equal(later.suppressed, 6, "the suppressed ones are reported with the next logged line")
  assert.equal(ledger.perMinute().screen, 7)
  now += 61_000
  assert.equal(ledger.perMinute().screen, 0)
  assert.equal(ledger.snapshotTotals()["screen:repetitive"], 7)
  ledger.setValve("deepgram-language", true)
  assert.deepEqual(ledger.openValves(), ["deepgram-language"])
  ledger.setValve("deepgram-language", false)
  assert.deepEqual(ledger.openValves(), [])
})

test("MicDiagnostics: forwarded audio with no transcript, loud-but-ignored input and an open valve each raise a warning", () => {
  const diag = new MicDiagnostics()
  assert.deepEqual(diag.evaluate({ loudClosedMs: 0, openValves: [] }), [])
  diag.observeForwarded(29_000)
  assert.deepEqual(diag.evaluate({ loudClosedMs: 0, openValves: [] }), [])
  diag.observeForwarded(1_500)
  assert.deepEqual(diag.evaluate({ loudClosedMs: 0, openValves: [] }), ["no-transcripts"])
  diag.observeTranscript() // a transcript, even one a guard later drops, proves the engine hears
  assert.deepEqual(diag.evaluate({ loudClosedMs: 0, openValves: [] }), [])
  assert.deepEqual(diag.evaluate({ loudClosedMs: 25_000, openValves: ["groq-language"] }), ["gate-closed-loud", "language-guard-bypassed"])
  diag.observeForwarded(Number.NaN)
  diag.observeForwarded(-5)
  assert.deepEqual(diag.evaluate({ loudClosedMs: 0, openValves: [] }), [])
})
