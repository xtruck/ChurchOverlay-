import { test } from "node:test"
import assert from "node:assert/strict"
import { correctTranscription } from "./transcription-corrector"

// Regression coverage for the "wrong spellings" bug: the corrector was
// blanket-correcting VALID French words ("est" → "et", "ai" → "a",
// "marque" → "marc", "souvent" → "suivant"), corrupting correct sentences.

test("corrector: known phonetic confusions are corrected ('wc' → 'verset')", () => {
  const result = correctTranscription("au wc trois de Jean")
  assert.equal(result.correctedText, "au verset 3 de Jean")
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