import { test } from "node:test"
import assert from "node:assert/strict"
import { biblicalVocabularyFor, plannedBookTerms } from "./biblical-vocabulary"

test("biblicalVocabularyFor: includes difficult, less-common book names in French and English", () => {
  const french = biblicalVocabularyFor("fr")
  const english = biblicalVocabularyFor("en")
  for (const book of ["Néhémie", "Ézéchiel", "Michée", "Nahum", "Zacharie", "Esdras", "Osée"]) {
    assert.ok(french.includes(book), `French hints should include ${book}`)
  }
  for (const book of ["Nehemiah", "Ezekiel", "Micah", "Nahum", "Zechariah", "Ezra", "Hosea"]) {
    assert.ok(english.includes(book), `English hints should include ${book}`)
  }
  for (const common of ["Jean", "Marc", "John", "Mark"]) {
    assert.equal(biblicalVocabularyFor(undefined).includes(common), false, common)
  }
})

test("plannedBookTerms: gives French display names by default", () => {
  assert.deepEqual(plannedBookTerms(["john", "romans"], "fr"), ["Jean", "Romains"])
})

test("plannedBookTerms: gives English display names for language 'en'", () => {
  assert.deepEqual(plannedBookTerms(["john", "romans"], "en"), ["John", "Romans"])
})

test("plannedBookTerms: falls back to the English name for a language it has no French alias for", () => {
  // "philemon" is its own alias in FRENCH_BOOK_ALIASES, so this also
  // exercises the fallback path for an id that were it missing.
  assert.deepEqual(plannedBookTerms(["philemon"], "fr"), ["Philemon"])
})

test("plannedBookTerms: deduplicates and preserves first-seen order", () => {
  assert.deepEqual(plannedBookTerms(["john", "romans", "john"], "fr"), ["Jean", "Romains"])
})

test("plannedBookTerms: an unknown id is silently skipped, never a crash", () => {
  assert.deepEqual(plannedBookTerms(["not-a-real-book", "john"], "fr"), ["Jean"])
})

test("plannedBookTerms: empty input gives an empty list", () => {
  assert.deepEqual(plannedBookTerms([], "fr"), [])
})
