import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector, compactOnlyReferenceKeys } from "./regex-detector"
import { correctTranscription } from "../asr/transcription-corrector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { normalizeSpokenReferences } from "./spoken-reference-normalizer"
import { NavigationCommandDetector } from "./navigation-command-detector"
import { GlossaryDetector } from "../glossary/glossary-detector"

// AUDIT TS-06: tables keyed by transcribed text must be own-property lookups.
const PROTOTYPE_WORDS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]

test("TS-06: prototype member names never resolve as a book (detector, index, normalizer, corrector)", () => {
  const detector = new RegexDetector()
  const index = new KnownValidVerseIndex()
  for (const word of PROTOTYPE_WORDS) {
    const refs = detector.detect(`${word} 3:16`)
    for (const ref of refs) {
      assert.equal(typeof ref.book, "string", `${word}: book must stay a string`)
      assert.equal(index.exists(ref), false, `${word} 3:16 must not validate`)
    }
    // every other table keyed by transcribed text
    assert.doesNotThrow(() => detector.detect(`${word} chapitre 3 verset 16`), word)
    assert.doesNotThrow(() => detector.detect(`${word} 3 16`), word)
    assert.doesNotThrow(() => normalizeSpokenReferences(`${word} ${word} 3`, () => true), word)
    assert.doesNotThrow(() => new NavigationCommandDetector().detect(`${word} chapitre 3`), word)
    assert.doesNotThrow(() => new GlossaryDetector().detect(`${word} ${word}`), word)
    const corrected = correctTranscription(`${word} 3:16 ${word}, verset ${word}`)
    assert.equal(typeof corrected.correctedText, "string")
    assert.ok(!corrected.correctedText.includes("function"), corrected.correctedText)
    assert.ok(corrected.correctedText.toLowerCase().includes(word.toLowerCase()), `${word} must pass through untouched: ${corrected.correctedText}`)
  }
})

test("TS-06: the known-valid index never throws on a non-string book", () => {
  const index = new KnownValidVerseIndex()
  const bad = { book: Object.prototype.constructor as unknown as string, chapter: 3, verse: 16 }
  assert.equal(index.exists(bad), false)
})

test("TS-06: 'constructor 3:16' yields a string book the index rejects (French and English phrasing)", () => {
  const detector = new RegexDetector()
  const index = new KnownValidVerseIndex()
  for (const text of ["constructor 3:16", "Lisons constructor 3:16", "turn to __proto__ 3:16", "toString chapitre 3 verset 16"]) {
    const refs = detector.detect(text)
    assert.ok(refs.every((r) => typeof r.book === "string"))
    assert.ok(refs.every((r) => !index.exists(r)))
  }
})

// AUDIT TS-08: the bare "Name N M" form is only ever a suggestion.
test("TS-08: compactOnlyReferenceKeys flags the bare 'Name N M' form, FR and EN", () => {
  for (const [text, key] of [
    ["il y avait Jean 5 6 qui", "john 5:6"],
    ["Daniel 3 4", "daniel 3:4"],
    ["Amos 3 4", "amos 3:4"],
    ["Ruth 2 3 and", "ruth 2:3"],
  ] as const) {
    assert.ok(compactOnlyReferenceKeys(text).has(key), `${text} must be compact-only`)
  }
})

test("TS-08: explicit forms (colon, verset/verse, chapitre/chapter) are NOT compact-only", () => {
  for (const text of [
    "Jean 5:6",
    "Jean 5 verset 6",
    "Jean chapitre 5 verset 6",
    "John 5 verse 6",
    "John chapter 5 verse 6",
    "Ruth 2:3",
    "Daniel chapitre 3, verset 4",
  ]) {
    assert.equal(compactOnlyReferenceKeys(text).size, 0, text)
    assert.ok(new RegexDetector().detect(text).length > 0, `${text} still detected`)
  }
})

test("TS-08: detect() itself is unchanged (the compact form is still a candidate for the operator)", () => {
  assert.deepEqual(new RegexDetector().detect("Daniel 3 4"), [{ book: "daniel", chapter: 3, verse: 4 }])
})
