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

// ARCHITECTURE.md section 101 — the second probing round over natural French
// phrasing. These are the rewrites themselves, asserted as strings so a
// future pattern change can't quietly move the goalposts.
test("normalizeSpokenReferences: a French/English preposition before the verse keyword is dropped", () => {
  assert.equal(normalizeSpokenReferences("Jean 3 au verset 16"), "Jean 3 verset 16")
  assert.equal(normalizeSpokenReferences("Jean 3, au verset seize"), "Jean 3, verset 16")
  assert.equal(normalizeSpokenReferences("Jean au chapitre 3 au verset 16"), "Jean au chapitre 3 verset 16")
  assert.equal(normalizeSpokenReferences("John 3 at verse 16"), "John 3 verse 16")
  // Deliberately NOT applied before "chapitre": NavigationCommandDetector's
  // bare-chapter-verse lookbehind depends on the lowercase word sitting in
  // front of "chapitre", and the chapter side is already handled by
  // SPOKEN_REFERENCE_DOUBLE_KEYWORD_PATTERN's own "au|à|dans le|in|at" link.
  assert.equal(normalizeSpokenReferences("Allons au chapitre 9, verset 3."), "Allons au chapitre 9, verset 3.")
  assert.equal(normalizeSpokenReferences("deuxième épître aux Corinthiens"), "2 Corinthiens")
})

test("normalizeSpokenReferences: positional ordinals become the number every pattern expects", () => {
  assert.equal(normalizeSpokenReferences("Jean chapitre premier"), "Jean chapitre 1")
  assert.equal(normalizeSpokenReferences("Jean chapitre 1er"), "Jean chapitre 1")
  assert.equal(normalizeSpokenReferences("Jean verset premier"), "Jean verset 1")
  assert.equal(normalizeSpokenReferences("au premier verset"), "verset 1")
  assert.equal(normalizeSpokenReferences("le deuxième chapitre"), "le chapitre 2")
  assert.equal(normalizeSpokenReferences("Jean chapitre premier verset premier"), "Jean chapitre 1 verset 1")
  assert.equal(normalizeSpokenReferences("Jean chapitre trois"), "Jean chapitre 3", "a count, not an ordinal")
})

test("normalizeSpokenReferences: English 'second'/'first' are left alone in a position", () => {
  // "second" is also a unit of time and "a second verse" means "another
  // verse" — an English ordinal in a position slot would be a wrong-verse
  // generator, so the position table is French-only on purpose.
  assert.equal(normalizeSpokenReferences("give me a second verse"), "give me a second verse")
  assert.equal(normalizeSpokenReferences("the first chapter of the book"), "the first chapter of the book")
  assert.equal(normalizeSpokenReferences("read the third verse"), "read the third verse")
})

test("normalizeSpokenReferences: a positional ordinal is left alone when the chapter is stated later", () => {
  // "chapter 3 verse 1", not "verse 1 of the current chapter" — a valid but
  // wrong verse is exactly what the hallucination guard cannot catch, so the
  // rewrite refuses and the utterance produces no command at all.
  assert.equal(
    normalizeSpokenReferences("dans le premier verset du chapitre trois"),
    "dans le premier verset du chapitre 3"
  )
  assert.equal(
    normalizeSpokenReferences("dans le verset premier du chapitre trois"),
    "dans le verset premier du chapitre 3"
  )
})

test("normalizeSpokenReferences: the two French titles that are really phrases", () => {
  assert.equal(normalizeSpokenReferences("l'Apocalypse de Jean chapitre 21 verset 4"), "l'Apocalypse chapitre 21 verset 4")
  assert.equal(normalizeSpokenReferences("l'Apocalypse de saint Jean 21:4"), "l'Apocalypse 21:4")
  assert.equal(normalizeSpokenReferences("Actes des apôtres 2:4"), "Actes 2:4")
  assert.equal(normalizeSpokenReferences("Actes de la réunion 2026"), "Actes de la réunion 2026", "not a title")
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
  // ARCHITECTURE.md section 101 (second probing round).
  ["Jean 3 au verset 16", "john 3:16"],
  ["Jean 3, au verset seize", "john 3:16"],
  ["Jean chapitre 3 au verset 16", "john 3:16"],
  ["Jean chapitre 3, au verset 16", "john 3:16"],
  ["lisons Jean au chapitre 3 au verset 16", "john 3:16"],
  ["Jean chapitre 3, le verset 16", "john 3:16"],
  ["Jean chapitre premier verset premier", "john 1:1"],
  ["Actes des apôtres chapitre 2 verset 4", "acts 2:4"],
  ["l'Apocalypse de Jean chapitre 21 verset 4", "revelation 21:4"],
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

// Same failure class, second probing round: "l'Apocalypse de Jean chapitre
// 21 verset 4" used to resolve as the Gospel of John, and John 21:4 exists,
// so nothing downstream could have caught it.
test("RegexDetector: 'l'Apocalypse de Jean' is never detected as the Gospel of John (wrong-verse regression)", () => {
  assert.deepEqual(detect("l'Apocalypse de Jean chapitre 21 verset 4"), ["revelation 21:4"])
  assert.equal(detect("l'Apocalypse de Jean 21:4").includes("john 21:4"), false)
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
  // ARCHITECTURE.md section 101: a positional ordinal with a chapter stated
  // LATER is never rewritten into a bare verse (wrong-verse guard), and an
  // ordinal that is only a count is not one at all.
  "dans le premier verset du chapitre trois",
  "le premier chapitre de ce livre est long",
  "il est au chapitre trois de sa vie",
  "give me a second verse please",
  "read the first chapter and the third verse",
]

test("RegexDetector: zero false positives on everyday sentences with names and numbers", () => {
  for (const sentence of NEGATIVES) assert.deepEqual(detect(sentence), [], sentence)
})
