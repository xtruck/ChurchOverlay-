import { test } from "node:test"
import assert from "node:assert/strict"
import { QuoteMatcher, quoteTokens } from "./quote-matcher"
import { loadOfflineBibleData } from "../verse/offline-verse-source"

const FIXTURE = {
  jean: {
    "3": {
      "16": "Car Dieu a tant aimé le monde qu’il a donné son Fils unique, afin que quiconque croit en lui ne périsse point, mais qu’il ait la vie éternelle.",
      "17": "Dieu, en effet, n’a pas envoyé son Fils dans le monde pour qu’il juge le monde, mais pour que le monde soit sauvé par lui.",
    },
  },
  philippiens: { "4": { "13": "Je puis tout par celui qui me fortifie." } },
}

test("quoteTokens: lower-case, accents and punctuation stripped, elisions folded", () => {
  assert.deepEqual(quoteTokens("L’Éternel, qu'il"), ["leternel", "quil"])
  assert.deepEqual(quoteTokens("quil"), ["quil"])
})

test("QuoteMatcher: a verse read aloud without its reference is recognized", () => {
  const matcher = new QuoteMatcher(FIXTURE)
  const match = matcher.match("car Dieu a tant aimé le monde qu'il a donné son fils unique")
  assert.deepEqual(match?.reference, { book: "john", chapter: 3, verse: 16 })
})

test("QuoteMatcher: a short verse read in full is recognized", () => {
  assert.deepEqual(new QuoteMatcher(FIXTURE).match("je puis tout par celui qui me fortifie")?.reference, {
    book: "philippians",
    chapter: 4,
    verse: 13,
  })
})

test("QuoteMatcher: reading over into the next verse still picks one of them", () => {
  const match = new QuoteMatcher(FIXTURE).match(
    "ne périsse point mais qu'il ait la vie éternelle Dieu en effet n'a pas envoyé son fils dans le monde pour qu'il juge le monde"
  )
  assert.ok(match && match.reference.book === "john" && [16, 17].includes(match.reference.verse))
})

test("QuoteMatcher: paraphrase and ordinary speech never match", () => {
  const matcher = new QuoteMatcher(FIXTURE)
  assert.equal(matcher.match("Dieu nous aime tellement qu'il a envoyé son fils pour nous sauver"), null)
  assert.equal(matcher.match("bienvenue à tous ce matin dans la maison du Seigneur"), null)
  assert.equal(matcher.match("Dieu a tant aimé"), null, "too short to be distinctive")
})

test("QuoteMatcher: real LSG 1910 — famous verses found, sermon talk and ubiquitous formulas ignored", async () => {
  const matcher = new QuoteMatcher(await loadOfflineBibleData())
  assert.ok(matcher.size > 31000)
  const ref = (text: string) => {
    const match = matcher.match(text)
    return match ? `${match.reference.book} ${match.reference.chapter}:${match.reference.verse}` : null
  }
  assert.equal(ref("L'Éternel est mon berger je ne manquerai de rien"), "psalm 23:1")
  assert.equal(ref("Au commencement était la Parole et la Parole était avec Dieu et la Parole était Dieu"), "john 1:1")
  assert.equal(
    ref("Nous savons du reste que toutes choses concourent au bien de ceux qui aiment Dieu"),
    "romans 8:28"
  )
  assert.equal(ref("et l'Éternel dit à Moïse"), null)
  assert.equal(ref("mes frères aujourd'hui nous allons parler de la foi et de la grâce de Dieu dans nos vies"), null)
})
