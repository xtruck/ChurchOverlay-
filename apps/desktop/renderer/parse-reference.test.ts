import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

// ARCHITECTURE.md section 146 (frontend pass): unit tests for the operator's
// typed-reference parser. The parser is a plain globalThis module
// (parse-reference.js, no build step) loaded into a fresh context here — the
// same pattern as audio-stream.test.ts. What the parser accepts, the server
// still re-validates (known-valid index + range clamp/cap), so these tests
// pin the OPERATOR-facing contract: what the typing box accepts and what it
// rejects with the format hint.

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const source = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "parse-reference.js"), "utf8")

type ParsedReference = { book: string; chapter: number; verse: number; verseEnd?: number } | null

function makeParser(): (text: string) => ParsedReference {
  const context: { ChurchOverlayParseReference?: { parseReference: (text: string) => ParsedReference } } = {}
  runInNewContext(source, context)
  const parseReference = context.ChurchOverlayParseReference?.parseReference
  if (typeof parseReference !== "function") throw new Error("parse-reference module did not register")
  // The parser builds its result inside the VM realm, whose Object.prototype
  // is a different object — deepStrictEqual would reject structurally equal
  // results. Copy the fields out into a host-realm object.
  return (text) => {
    const raw = parseReference(text)
    if (raw === null || raw === undefined) return null
    const out: NonNullable<ParsedReference> = {
      book: String(raw.book),
      chapter: Number(raw.chapter),
      verse: Number(raw.verse),
    }
    if (typeof raw.verseEnd === "number") out.verseEnd = raw.verseEnd
    return out
  }
}

const parse = makeParser()

test("single references parse exactly as before (the pre-section-146 contract)", () => {
  assert.deepEqual(parse("John 3:16"), { book: "john", chapter: 3, verse: 16 })
  assert.deepEqual(parse("  John 3:16  "), { book: "john", chapter: 3, verse: 16 })
  assert.deepEqual(parse("jn 3 16"), { book: "jn", chapter: 3, verse: 16 })
  assert.deepEqual(parse("1co 13 4"), { book: "1co", chapter: 13, verse: 4 })
  assert.deepEqual(parse("gen 1:1"), { book: "gen", chapter: 1, verse: 1 })
  assert.deepEqual(parse("Genèse 1:1"), { book: "genèse", chapter: 1, verse: 1 })
  assert.deepEqual(parse("Song of Solomon 2:1"), { book: "song of solomon", chapter: 2, verse: 1 })
  assert.deepEqual(parse("1 samuel 3 16"), { book: "1 samuel", chapter: 3, verse: 16 })
  assert.deepEqual(parse("Ps 23:1"), { book: "ps", chapter: 23, verse: 1 })
})

test("a range tail parses into the additive verseEnd", () => {
  assert.deepEqual(parse("Jean 3:16-18"), { book: "jean", chapter: 3, verse: 16, verseEnd: 18 })
  assert.deepEqual(parse("jn 3 16 18"), { book: "jn", chapter: 3, verse: 16, verseEnd: 18 })
  assert.deepEqual(parse("1co 13:4-7"), { book: "1co", chapter: 13, verse: 4, verseEnd: 7 })
  assert.deepEqual(parse("psalm 119 105 107"), { book: "psalm", chapter: 119, verse: 105, verseEnd: 107 })
  // French decimal style: the comma is the chapter-verse separator, the dash the tail.
  assert.deepEqual(parse("Jean 3,16-18"), { book: "jean", chapter: 3, verse: 16, verseEnd: 18 })
  // En dash and em dash, with or without surrounding spaces.
  assert.deepEqual(parse("John 3:16–18"), { book: "john", chapter: 3, verse: 16, verseEnd: 18 })
  assert.deepEqual(parse("John 3:16—18"), { book: "john", chapter: 3, verse: 16, verseEnd: 18 })
  assert.deepEqual(parse("John 3:16 - 18"), { book: "john", chapter: 3, verse: 16, verseEnd: 18 })
})

test("an equal tail is the single verse; a reversed tail is rejected to the format hint", () => {
  assert.deepEqual(parse("John 3:16-16"), { book: "john", chapter: 3, verse: 16 })
  assert.equal(parse("John 3:18-16"), null, "a reversed span must show the format hint, not a surprise verse")
  assert.equal(parse("John 3:16-0"), null)
})

test("non-references still fail to parse", () => {
  assert.equal(parse("hello"), null)
  assert.equal(parse("John"), null)
  assert.equal(parse("3:16"), null)
  assert.equal(parse("John 3:16 extra"), null)
  assert.equal(parse("John 3:16.5"), null, "a decimal-style tail that is not a dash or space is not accepted")
})
