import { test } from "node:test"
import assert from "node:assert/strict"
import { TranscriptAssembler } from "./transcript-assembler"

test("TranscriptAssembler: joins a short final reference split across chunks", () => {
  const assembler = new TranscriptAssembler()
  assert.equal(assembler.push({ text: "Ésaïe 4, le verset", timestamp: 1000 }), null)
  assert.equal(assembler.push({ text: "8", timestamp: 1800 }), "Ésaïe 4, le verset 8")
})

test("TranscriptAssembler: expires unrelated old fragments", () => {
  const assembler = new TranscriptAssembler({ windowMs: 1000 })
  assembler.push({ text: "Jean 3", timestamp: 1000 })
  assert.equal(assembler.push({ text: "verset 16", timestamp: 2501 }), null)
})

// ---- Long window: an OPEN reference completed several seconds later ----
// Real log (2026-10-05): "Corentin 5" ... 8 s ... "2." and the user's own
// example "Genesis 5" then "verse 2", both lost to the old 4 s window.
import { isCatalogBookWord, RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"

const longWindow = () => new TranscriptAssembler({ isBookWord: isCatalogBookWord })
const detector = new RegexDetector()
const index = new KnownValidVerseIndex()
const verses = (text: string | null) =>
  text === null ? null : detector.detect(text).filter((r) => index.exists(r)).map((r) => `${r.book} ${r.chapter}:${r.verse}`)

test("TranscriptAssembler (long window): 'Genesis 5' then 'verse 2' nine seconds later", () => {
  const assembler = longWindow()
  assert.equal(assembler.push({ text: "let's open our Bible in the book of Genesis 5", timestamp: 0 }), null)
  const joined = assembler.push({ text: "verse 2", timestamp: 9000 })
  assert.deepEqual(verses(joined), ["genesis 5:2"])
})

test("TranscriptAssembler (long window): chatter in between does not break an open reference", () => {
  const assembler = longWindow()
  assembler.push({ text: "Éphésiens 5", timestamp: 0 })
  assembler.push({ text: "nous allons voir ensemble ce que Dieu dit", timestamp: 4000 })
  assembler.push({ text: "à son peuple aujourd'hui", timestamp: 8000 })
  assert.deepEqual(verses(assembler.push({ text: "au verset 7", timestamp: 12000 })), ["ephesians 5:7"])
})

test("TranscriptAssembler (long window): a bare trailing number completes 'book chapter' only soon after", () => {
  const soon = longWindow()
  soon.push({ text: "dans le livre de Jean 14", timestamp: 0 })
  assert.deepEqual(verses(soon.push({ text: "6.", timestamp: 8000 })), ["john 14:6"])
  const late = longWindow()
  late.push({ text: "dans le livre de Jean 14", timestamp: 0 })
  assert.equal(late.push({ text: "6.", timestamp: 20000 }), null)
})

test("TranscriptAssembler (long window): 'chapter N verse M' completes a book said alone", () => {
  const assembler = longWindow()
  assembler.push({ text: "nous allons prendre notre Bible dans le livre de Romains", timestamp: 0 })
  assert.deepEqual(verses(assembler.push({ text: "chapitre 8 verset 28", timestamp: 7000 })), ["romans 8:28"])
})

test("TranscriptAssembler (long window): stale, complete or unrelated fragments never combine", () => {
  const stale = longWindow()
  stale.push({ text: "Genesis 5", timestamp: 0 })
  assert.equal(stale.push({ text: "verse 2", timestamp: 40000 }), null)

  const complete = longWindow()
  complete.push({ text: "Genesis 5 verse 2", timestamp: 0 })
  assert.equal(complete.push({ text: "verse 3", timestamp: 9000 }), null)

  const unrelated = longWindow()
  unrelated.push({ text: "Genesis 5", timestamp: 0 })
  assert.equal(unrelated.push({ text: "2 minutes later we left", timestamp: 9000 }), null)
  assert.equal(unrelated.push({ text: "we paid 2", timestamp: 10000 }), null, "a bare number needs to be alone")
})

test("TranscriptAssembler (long window): only an open fragment ending on a book is joined, not 'book mentioned earlier'", () => {
  const assembler = longWindow()
  assembler.push({ text: "Jean 3 était un grand homme et nous parlons de lui depuis longtemps", timestamp: 0 })
  assert.equal(assembler.push({ text: "verset 2", timestamp: 9000 }), null)
})

