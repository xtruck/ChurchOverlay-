import { test } from "node:test"
import assert from "node:assert/strict"
import { correctTranscription, detectHallucination } from "./transcription-corrector"

// Regression coverage for the "wrong spellings" bug: the corrector was
// blanket-correcting VALID French words ("est" → "et", "ai" → "a",
// "marque" → "marc", "souvent" → "suivant"), corrupting correct sentences.

test("corrector: known phonetic confusions are corrected ('wc' → 'verset')", () => {
  const result = correctTranscription("au wc trois de Jean")
  assert.equal(result.correctedText, "au verset 3 de Jean")
})

// Observed live (2026-09): both from a real multi-minute test reading
// through a book chapter by chapter — recurring, not one-off garbling.
test("corrector: 'vestu' (observed live) is corrected to 'verset'", () => {
  const result = correctTranscription("au vestu suivant")
  assert.equal(result.correctedText, "au verset suivant")
})

test("corrector: 'som' (observed live, 'some' clipped further) is corrected to 'psaume'", () => {
  const result = correctTranscription("som 3")
  assert.equal(result.correctedText, "psaume 3")
})

test("corrector: the valid word 'est' is NOT corrected to 'et'", () => {
  const result = correctTranscription("il est trois heures")
  assert.equal(result.correctedText, "il est 3 heures")
  assert.equal(result.corrections.length, 1) // only "trois" -> 3
})

test("corrector: the valid word 'marque' is NOT corrected to 'marc'", () => {
  const result = correctTranscription("la marque du livre")
  assert.equal(result.correctedText, "la marque du livre")
  assert.equal(result.corrections.length, 0)
})

test("corrector: standalone 'souvent' (valid word) is left untouched", () => {
  const result = correctTranscription("j'y vais souvent le dimanche")
  assert.equal(result.correctedText, "j'y vais souvent le dimanche")
  assert.ok(!result.corrections.some((c) => c.original === "souvent"))
})

test("corrector: 'souvent' before a number is corrected to 'suivant'", () => {
  const result = correctTranscription("le verset souvent trois")
  assert.ok(result.correctedText.includes("suivant"), `'${result.correctedText}' should contain 'suivant'`)
  assert.ok(result.corrections.some((c) => c.original === "souvent" && c.corrected === "suivant"))
})

test("corrector: capitalization is preserved on a corrected token", () => {
  const result = correctTranscription("Wc trois")
  assert.equal(result.correctedText, "Verset 3")
})

test("corrector: already-correct text passes through unchanged", () => {
  const result = correctTranscription("Jean chapitre 3 verset 16")
  assert.equal(result.correctedText, "Jean chapitre 3 verset 16")
  assert.equal(result.corrections.length, 0)
})

test("corrector: live French ASR phonetic confusions recover Jean and Ésaïe", () => {
  const result = correctTranscription("jãum chapitre 3 verso 16 ézaiie")
  assert.equal(result.correctedText, "jean chapitre 3 verset 16 esaie")
  assert.equal(result.corrections.length, 3)
})

test("corrector: observed split-reference words are normalized conservatively", () => {
  const result = correctTranscription("azzain kaple vete versus 8 ezaïkat")
  assert.equal(result.correctedText, "esaie chapitre verset verset 8 esaie")
})

// Production audit (2026-09): a token with real sentence punctuation
// attached directly ("v.c.,") previously defeated the exact-match lookup
// even though the underlying confusion ("v.c." alone) is already known.
test("corrector: a known confusion with trailing punctuation attached is still corrected ('v.c.,' -> 'verset,')", () => {
  const result = correctTranscription("au v.c., trois de Jean")
  assert.equal(result.correctedText, "au verset, 3 de Jean")
})

test("corrector: a known confusion with a trailing question mark is still corrected", () => {
  const result = correctTranscription("wc? trois")
  assert.equal(result.correctedText, "verset? 3")
})

test("corrector: a protected word with trailing punctuation is still left alone (not miscorrected)", () => {
  const result = correctTranscription("verset? trois")
  assert.equal(result.correctedText, "verset? 3")
  assert.ok(!result.corrections.some((c) => c.original === "verset?"))
})

test("corrector: an already-punctuation-inclusive key ('verset.') still matches exactly, unaffected by the new fallback", () => {
  const result = correctTranscription("verset.")
  assert.equal(result.correctedText, "verset")
})

// Production audit (2026-09): correctTranscription() fixes mis-heard WORDS.
// It does nothing about invented sentences or degenerate repetition loops
// — a different, more damaging hallucination class — which is exactly why
// detectHallucination() exists as a separate, explicit check.
test("detectHallucination: a known Whisper YouTube-outro hallucination (French) is flagged", () => {
  const result = detectHallucination("Sous-titres réalisés par la communauté d'Amara.org")
  assert.deepEqual(result, { isHallucination: true, reason: "boilerplate" })
})

test("detectHallucination: a known Whisper YouTube-outro hallucination (English) is flagged regardless of trailing punctuation", () => {
  const result = detectHallucination("Thank you for watching!")
  assert.deepEqual(result, { isHallucination: true, reason: "boilerplate" })
})

test("detectHallucination: real speech merely mentioning similar words is NOT flagged (exact match only)", () => {
  const result = detectHallucination("Thank you for watching over us, Lord, through this difficult season.")
  assert.deepEqual(result, { isHallucination: false })
})

test("detectHallucination: a degenerate single-word repetition loop is flagged", () => {
  const result = detectHallucination(
    "sous-titres sous-titres sous-titres sous-titres sous-titres sous-titres sous-titres sous-titres"
  )
  assert.deepEqual(result, { isHallucination: true, reason: "degenerate-repetition" })
})

test("detectHallucination: genuine emphatic repetition in real preaching (\"Amen, amen, amen!\") is NOT flagged", () => {
  const result = detectHallucination("Amen, amen, amen! Hallelujah, hallelujah!")
  assert.deepEqual(result, { isHallucination: false })
})

test("detectHallucination: ordinary correct speech is never flagged", () => {
  const result = detectHallucination("Jean chapitre 3 verset 16")
  assert.deepEqual(result, { isHallucination: false })
})