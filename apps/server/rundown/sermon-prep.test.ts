import test from "node:test"
import assert from "node:assert/strict"
import { MAX_SERMON_PREP_CHARS, MAX_SERMON_PREP_REFERENCES, parseSermonPrep } from "./sermon-prep"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"

const index = new KnownValidVerseIndex()

function refs(text: string): string[] {
  const outcome = parseSermonPrep(text, index)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return []
  return outcome.result.references.map((r) => `${r.book} ${r.chapter}:${r.verse}`)
}

test("parseSermonPrep: French outline, in the order the notes name them", () => {
  const notes = [
    "Titre : La grâce qui transforme",
    "Introduction — lire Jean 3:16",
    "1. Le constat : Romains 3.23",
    "2. La réponse : Éphésiens 2, 8",
    "Conclusion : 1 Corinthiens 13:13",
  ].join("\n")
  assert.deepEqual(refs(notes), ["john 3:16", "romans 3:23", "ephesians 2:8", "1 corinthians 13:13"])
})

test("parseSermonPrep: English notes and written abbreviations resolve to catalog books", () => {
  assert.deepEqual(refs("Read Jn 3:16; then Rom 8:28; finally 1 Co 13:4"), ["john 3:16", "romans 8:28", "1 corinthians 13:4"])
  assert.deepEqual(refs("Psalm 23:1\nGen 1:1"), ["psalm 23:1", "genesis 1:1"])
})

test("parseSermonPrep: duplicates removed, first position kept; bookIds deduplicated in order", () => {
  const outcome = parseSermonPrep("Jean 3:16\nRomains 8:28\nJohn 3:16\nJean 1:1", index)
  assert.ok(outcome.ok)
  if (!outcome.ok) return
  assert.deepEqual(
    outcome.result.references.map((r) => `${r.book} ${r.chapter}:${r.verse}`),
    ["john 3:16", "romans 8:28", "john 1:1"],
  )
  assert.deepEqual(outcome.result.bookIds, ["john", "romans"])
})

test("parseSermonPrep: references the known-valid index rejects are counted, never kept", () => {
  const outcome = parseSermonPrep("Jean 3:99\nJude 2:1\nRomains 8:28", index)
  assert.ok(outcome.ok)
  if (!outcome.ok) return
  assert.deepEqual(outcome.result.references, [{ book: "romans", chapter: 8, verse: 28 }])
  assert.equal(outcome.result.rejectedCount, 2)
})

test("parseSermonPrep: prose without references yields nothing (times, dates, numbered points)", () => {
  assert.deepEqual(refs("Culte à 10:30 le 12 octobre\nPoint 1 : 3 raisons de prier\nThe meeting starts at 3:16 today"), [])
  assert.deepEqual(refs(""), [])
})

test("parseSermonPrep: input is bounded — too long is refused, non-text is refused", () => {
  assert.deepEqual(parseSermonPrep("x".repeat(MAX_SERMON_PREP_CHARS + 1), index), { ok: false, reason: "too-long" })
  assert.deepEqual(parseSermonPrep(42, index), { ok: false, reason: "not-text" })
  assert.equal(parseSermonPrep("x".repeat(MAX_SERMON_PREP_CHARS), index).ok, true)
})

test("parseSermonPrep: at most MAX_SERMON_PREP_REFERENCES references, flagged as truncated", () => {
  const lines = Array.from({ length: MAX_SERMON_PREP_REFERENCES + 10 }, (_, i) => `Psaumes 119:${i + 1}`)
  const outcome = parseSermonPrep(lines.join("\n"), index)
  assert.ok(outcome.ok)
  if (!outcome.ok) return
  assert.equal(outcome.result.references.length, MAX_SERMON_PREP_REFERENCES)
  assert.equal(outcome.result.truncated, true)
  assert.deepEqual(outcome.result.references[0], { book: "psalm", chapter: 119, verse: 1 })
})

test("parseSermonPrep: deterministic — same input, same output", () => {
  const notes = "Jean 3:16\nRm 8:28; Hé 11:1"
  assert.deepEqual(parseSermonPrep(notes, index), parseSermonPrep(notes, index))
})
