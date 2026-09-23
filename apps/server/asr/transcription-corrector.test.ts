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

test("corrector: 'somme' (observed live, 2026-09-23) is corrected to 'psaume'", () => {
  const result = correctTranscription("somme 3")
  assert.equal(result.correctedText, "psaume 3")
})

// Observed live (2026-09-23): "Habakkuk"/"Abacuc" heard as two separate
// words. RegexDetector's book-name group can only ever match one word, so
// this has to be collapsed before detection runs, not handled as a
// multi-word book alias.
test("corrector: 'Abba Kouk' (observed live, 2026-09-23) is corrected to 'Abacuc'", () => {
  const result = correctTranscription("Abba Kouk 1, verset 2")
  assert.equal(result.correctedText, "Abacuc 1, verset 2")
})

test("corrector: 'passé' before 'suivant' (observed live, 2026-09-23) is corrected to 'verset'", () => {
  const result = correctTranscription("Le passé suivant.")
  assert.equal(result.correctedText, "Le verset suivant.")
})

test("corrector: standalone 'passé' (valid word, 'the past') is left untouched", () => {
  const result = correctTranscription("dans le passé, Dieu a agi")
  assert.equal(result.correctedText, "dans le passé, Dieu a agi")
  assert.equal(result.corrections.length, 0)
})

test("corrector: 'Abba Bouk' (observed live, 2026-09-23) is corrected to 'Abacuc'", () => {
  const result = correctTranscription("Abba Bouk 1, verset 2.")
  assert.equal(result.correctedText, "Abacuc 1, verset 2.")
})

test("corrector: 'versic' (observed live, 2026-09-23) is corrected to 'verset'", () => {
  const result = correctTranscription("Esaïe 4, versic 7")
  assert.equal(result.correctedText, "Esaïe 4, verset 7")
})

// Observed live (2026-09-23): a distinct failure mode from every other
// "verset" confusion above — a MISSING separator (the abbreviation glued
// directly to the following digit), not an extra one, so neither the
// exact-token lookup nor its trailing-punctuation fallback could catch it.
test("corrector: an abbreviation glued directly to its digit ('vc2', 'wc4') is split and corrected", () => {
  assert.equal(correctTranscription("vc2. Zoom, abdias,").correctedText, "verset 2. Zoom, abdias,")
  assert.equal(correctTranscription("le WC4.").correctedText, "le verset 4.")
})

test("corrector: 'web' before a number (observed live, 2026-09-23) is corrected to 'verset'", () => {
  assert.equal(correctTranscription("au web 1 verset 2").correctedText, "au verset 1 verset 2")
})

test("corrector: standalone 'web' (valid loanword, 'site web') is left untouched", () => {
  const result = correctTranscription("le site web de l'église")
  assert.equal(result.correctedText, "le site web de l'église")
  assert.equal(result.corrections.length, 0)
})

test("corrector: 'bacille' before 'suivant' (observed live, 2026-09-23) is corrected to 'verset'", () => {
  assert.equal(correctTranscription("le bacille suivant").correctedText, "le verset suivant")
})

test("corrector: standalone 'bacille' (valid word, 'bacillus') is left untouched", () => {
  const result = correctTranscription("un bacille dangereux")
  assert.equal(result.correctedText, "un bacille dangereux")
  assert.equal(result.corrections.length, 0)
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