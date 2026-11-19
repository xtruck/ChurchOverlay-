import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector } from "./regex-detector"
import { LEARNED_WORD_PATTERN, isKnownBookWord, learnedAliasProblem, proposeAlias } from "./alias-proposal"
import { LearnedAliases, MAX_LEARNED_ALIASES, parseLearnedAliasesFile } from "./learned-aliases"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"

const index = new KnownValidVerseIndex()
const shown = (detector: RegexDetector, text: string): string[] =>
  detector.detect(text).filter((r) => index.exists(r)).map((r) => `${r.book} ${r.chapter}:${r.verse}`)

test("proposeAlias: the mis-heard word before the number is proposed for the book the operator typed", () => {
  assert.deepEqual(proposeAlias("Dans ezequiel 37, le verset 2", "ezekiel"), { word: "ezequiel", book: "ezekiel" })
  assert.deepEqual(proposeAlias("lisons phillipiens 4 verset 13", "philippians"), { word: "phillipiens", book: "philippians" })
})

test("proposeAlias: nothing is proposed when the word is already understood, too common, or too different", () => {
  // "nombre" was added to the app from the 2026-10-12 live log: the app already knows it.
  assert.equal(proposeAlias("dans nombre un, le verset 2,", "numbers"), null)
  assert.equal(proposeAlias("Allons-y dans, Esther un, verset 2.", "esther"), null) // a real catalog book
  assert.equal(proposeAlias("Noval verses cinq.", "john"), null) // nothing close to "john"/"jean"
  assert.equal(proposeAlias("voir chapitre 3", "john"), null) // stop words never qualify
  assert.equal(proposeAlias("anything", "not-a-book"), null)
})

test("learnedAliasProblem: only plain lower-case words for a real book that the app does not already know", () => {
  assert.equal(learnedAliasProblem("ezequiel", "ezekiel"), null)
  assert.match(learnedAliasProblem("Ezequiel", "ezekiel") ?? "", /plain letters/) // case
  assert.match(learnedAliasProblem("ezequiel 4", "ezekiel") ?? "", /plain letters/) // digits and spaces
  assert.match(learnedAliasProblem("ab", "ezekiel") ?? "", /plain letters/) // too short
  assert.match(learnedAliasProblem("ezequiel", "frogs") ?? "", /unknown book/)
  assert.match(learnedAliasProblem("trois", "john") ?? "", /common/)
  assert.match(learnedAliasProblem("jean", "john") ?? "", /already understands/)
  assert.equal(isKnownBookWord("jean"), true)
  assert.equal(isKnownBookWord("ezequiel"), false)
  assert.ok(LEARNED_WORD_PATTERN.test("abc"))
})

test("LearnedAliases: adds valid words, refuses invalid ones, is idempotent and bounded", () => {
  const learned = new LearnedAliases()
  assert.deepEqual(learned.add("ezequiel", "ezekiel"), { ok: true, added: true })
  assert.deepEqual(learned.add("ezequiel", "ezekiel"), { ok: true, added: false })
  assert.equal(learned.get("ezequiel"), "ezekiel")
  assert.equal(learned.add("jean", "john").ok, false)
  assert.equal(learned.add("Ezequiel", "ezekiel").ok, false)
  assert.equal(learned.size, 1)
  assert.deepEqual(learned.list(), [{ word: "ezequiel", book: "ezekiel" }])
  assert.equal(learned.remove("ezequiel"), true)
  assert.equal(learned.remove("ezequiel"), false)

  const full = new LearnedAliases()
  const letters = "abcdefghijklmnopqrstuvwxyz"
  for (let i = 0; i < MAX_LEARNED_ALIASES; i++) {
    assert.equal(full.add(`qz${letters[Math.floor(i / 26)]}${letters[i % 26]}`, "john").ok, true)
  }
  assert.equal(full.size, MAX_LEARNED_ALIASES)
  const overflow = full.add("qzzzz", "john")
  assert.equal(overflow.ok, false)
  assert.equal(full.size, MAX_LEARNED_ALIASES)
})

test("parseLearnedAliasesFile: malformed, hostile and over-long input is dropped and counted, never trusted", () => {
  assert.deepEqual(parseLearnedAliasesFile(null), { aliases: [], dropped: 0 })
  assert.deepEqual(parseLearnedAliasesFile("nope"), { aliases: [], dropped: 0 })
  assert.deepEqual(parseLearnedAliasesFile({ aliases: "x" }), { aliases: [], dropped: 0 })
  const { aliases, dropped } = parseLearnedAliasesFile({
    version: 1,
    aliases: [
      { word: "ezequiel", book: "ezekiel" },
      { word: "jean", book: "john" }, // already known
      { word: "../../etc", book: "john" },
      { word: "ok", book: "john" },
      { word: 5, book: "john" },
      null,
    ],
  })
  assert.deepEqual(aliases, [{ word: "ezequiel", book: "ezekiel" }])
  assert.equal(dropped, 5)
})

test("RegexDetector + learned alias: an approved word counts in explicit forms, never in the bare 'word N M' form", () => {
  const learned = new LearnedAliases([{ word: "ezequiel", book: "ezekiel" }])
  const detector = new RegexDetector({ learnedAliases: learned })
  assert.deepEqual(shown(detector, "Ezequiel 37:2"), ["ezekiel 37:2"])
  assert.deepEqual(shown(detector, "ezequiel chapitre 37 verset 2"), ["ezekiel 37:2"])
  assert.deepEqual(shown(detector, "ezequiel 37 verset 2"), ["ezekiel 37:2"])
  assert.deepEqual(shown(detector, "un grand ezequiel 37 2 fois"), [], "the bare form is deliberately not learned")
  // Without the approval the same words show nothing: the memory is what changed the outcome.
  assert.deepEqual(shown(new RegexDetector(), "Ezequiel 37:2"), [])
})

test("RegexDetector + learned alias: approvals apply live, and a learned word can never override a real catalog book", () => {
  const learned = new LearnedAliases()
  const detector = new RegexDetector({ learnedAliases: learned })
  assert.deepEqual(shown(detector, "ezequiel 37:2"), [])
  learned.add("ezequiel", "ezekiel")
  assert.deepEqual(shown(detector, "ezequiel 37:2"), ["ezekiel 37:2"]) // same detector instance, no restart
  const hostile = new RegexDetector({ learnedAliases: { get: () => "ezekiel" } })
  assert.deepEqual(shown(hostile, "Jean 3:16"), ["john 3:16"]) // a real book is never remapped
})
