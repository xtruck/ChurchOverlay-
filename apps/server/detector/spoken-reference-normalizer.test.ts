import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeSpokenReferences, parseNumberWords } from "./spoken-reference-normalizer"
import { RegexDetector, isCatalogBookWord } from "./regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"

const detector = new RegexDetector()
const index = new KnownValidVerseIndex()
const detect = (text: string) =>
  detector.detect(text).filter((r) => index.exists(r)).map((r) => `${r.book} ${r.chapter}:${r.verse}`)

test("parseNumberWords: French and English compounds, back-to-back numbers stay separate", () => {
  const value = (text: string) => parseNumberWords(text.split(" "), 0)?.value ?? null
  assert.equal(value("seize"), 16)
  assert.equal(value("vingt-huit"), 28)
  assert.equal(value("vingt et un"), 21)
  assert.equal(value("soixante-dix-sept"), 77)
  assert.equal(value("soixante et onze"), 71)
  assert.equal(value("quatre-vingt-dix-neuf"), 99)
  assert.equal(value("cent soixante-seize"), 176)
  assert.equal(value("twenty one"), 21)
  assert.equal(value("one hundred and nineteen"), 119)
  assert.equal(value("trois seize"), 3)
  assert.equal(value("huit vingt-huit"), 8)
  assert.equal(value("deux cents"), null, "no chapter or verse above 199")
  assert.equal(value("bonjour"), null)
})

test("normalizeSpokenReferences: ordinals only before numbered books", () => {
  assert.equal(normalizeSpokenReferences("Premier Corinthiens 13:4"), "1 Corinthiens 13:4")
  assert.equal(normalizeSpokenReferences("première épître de Jean"), "1 Jean")
  assert.equal(normalizeSpokenReferences("deuxième épître aux Corinthiens"), "2 Corinthiens")
  assert.equal(normalizeSpokenReferences("I Corinthians 13:4"), "1 Corinthians 13:4")
  assert.equal(normalizeSpokenReferences("wait a second John"), "wait a second John", "idiom, not 2 John")
  assert.equal(normalizeSpokenReferences("the second letter of John"), "the 2 John")
  assert.equal(normalizeSpokenReferences("le premier jour"), "le premier jour")
})

test("normalizeSpokenReferences: 'v.' abbreviation and multi-word book names", () => {
  assert.equal(normalizeSpokenReferences("Jean 3 v. 16"), "Jean 3 verset 16")
  assert.equal(normalizeSpokenReferences("Cantique des cantiques 2:4"), "Cantique 2:4")
  assert.equal(normalizeSpokenReferences("Song of Solomon 2:4"), "Cantique 2:4")
})

test("normalizeSpokenReferences: number words only in a reference context", () => {
  assert.equal(normalizeSpokenReferences("Jean chapitre trois verset seize"), "Jean chapitre 3 verset 16")
  assert.equal(normalizeSpokenReferences("Romains huit vingt-huit", isCatalogBookWord), "Romains 8 28")
  assert.equal(normalizeSpokenReferences("Jean avait trois ans", isCatalogBookWord), "Jean avait trois ans")
})

// The 20 natural phrasings probed against the real detector: 8 were missed
// and 2 displayed the WRONG verse (John instead of 1 John) before this change.
const POSITIVES: ReadonlyArray<readonly [string, string]> = [
  ["Premier Corinthiens 13:4", "1 corinthians 13:4"],
  ["1ère Jean 4:8", "1 john 4:8"],
  ["première épître de Jean chapitre 4 verset 8", "1 john 4:8"],
  ["deuxième Timothée 3:16", "2 timothy 3:16"],
  ["Jean chapitre trois verset seize", "john 3:16"],
  ["Romains 8 v. 28", "romans 8:28"],
  ["Romains 8, 28", "romans 8:28"],
  ["Romains huit vingt-huit", "romans 8:28"],
  ["Psaume 23 verset 1", "psalm 23:1"],
  ["John chapter 3 verse 16", "john 3:16"],
  ["First Corinthians 13 verse 4", "1 corinthians 13:4"],
  ["Second Timothy 3:16", "2 timothy 3:16"],
  ["Jean 3.16", "john 3:16"],
  ["Jean 3 v 16", "john 3:16"],
  ["lisons dans Matthieu au chapitre 5 verset 3", "matthew 5:3"],
  ["Ésaïe 53:5", "isaiah 53:5"],
  ["Esaie 53 5", "isaiah 53:5"],
  ["1 Jean 1 9", "1 john 1:9"],
  ["Cantique des cantiques 2:4", "song of solomon 2:4"],
  ["Song of Solomon 2:4", "song of solomon 2:4"],
]

for (const [spoken, expected] of POSITIVES) {
  test(`RegexDetector recognizes: ${spoken}`, () => {
    assert.deepEqual(detect(spoken), [expected])
  })
}

test("RegexDetector: '1ère Jean' is never detected as the Gospel of John (wrong-verse regression)", () => {
  assert.equal(detect("1ère Jean 4:8").includes("john 4:8"), false)
  assert.equal(detect("première épître de Jean chapitre 4 verset 8").includes("john 4:8"), false)
})

const NEGATIVES: readonly string[] = [
  "wait a second John will read",
  "le premier jour de la semaine",
  "nous avons 3 enfants et 16 petits-enfants",
  "la réunion est à 3.16 aujourd'hui",
  "il a 12 ans et 5 mois",
  "Jean est venu à 3 heures 16",
  "Marc a acheté 2 pains, 5 poissons",
  "I think Jean 3 is long",
  "chapitre trois",
  "the meeting starts at 3:16 today",
  "Pierre a 1 frère et 2 soeurs",
  "Le prix est 3,16 euros",
  "Luc un des douze",
  "Jean avait trois ans",
  "nous chantons le cantique numéro 12",
  "Daniel a 45 ans",
  "Job 5 minutes",
  "Actes de la réunion 2026",
  "version 2.5 du logiciel",
  "Romains et Grecs 3 fois",
]

test("RegexDetector: zero false positives on everyday sentences with names and numbers", () => {
  for (const sentence of NEGATIVES) assert.deepEqual(detect(sentence), [], sentence)
})
