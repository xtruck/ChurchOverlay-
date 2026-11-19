import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

// P1-2 (ARCHITECTURE.md section 149): unit tests for the pure reference
// formatting extracted from dashboard.js into its own globalThis module
// (reference-format.js, the parse-reference.js convention). Previously these
// formatters could only be exercised through the source-reading parity
// guards; now the behaviour itself is pinned: capitalization, the range
// suffix ("Jean 3:16-18"), the French book table and the bilingual
// secondary-reference join. The parity guard (reference-parity.test.ts)
// still locks the tables equal across the surfaces.

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const source = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "reference-format.js"), "utf8")

type Reference = { book: string; chapter: number; verse: number }

function loadModule(): {
  capitalize: (book: string) => string
  FRENCH_BOOK_NAMES: Record<string, string>
  FRENCH_TRANSLATIONS: Set<string>
  rangeSuffix: (ref: Reference, verseEnd?: number) => string
  formatReference: (ref: Reference, verseEnd?: number) => string
  formatBilingualReference: (ref: Reference, verseEnd?: number) => string
} {
  const context: { ChurchOverlayReferenceFormat?: ReturnType<typeof loadModule> } = {}
  runInNewContext(source, context)
  const mod = context.ChurchOverlayReferenceFormat
  if (!mod || typeof mod.formatReference !== "function") {
    throw new Error("reference-format module did not register")
  }
  return mod
}

const ref: Reference = { book: "john", chapter: 3, verse: 16 }

test("reference-format: formatReference capitalizes the book and appends the range suffix", () => {
  const mod = loadModule()
  assert.equal(mod.formatReference(ref), "John 3:16")
  assert.equal(mod.formatReference(ref, 18), "John 3:16-18")
  // A range END equal to or before the start verse renders as a single verse.
  assert.equal(mod.formatReference(ref, 16), "John 3:16")
  assert.equal(mod.formatReference({ book: "1 corinthians", chapter: 13, verse: 4 }), "1 Corinthians 13:4")
})

test("reference-format: formatBilingualReference joins the French and English forms", () => {
  const mod = loadModule()
  assert.equal(mod.formatBilingualReference(ref), "Jean 3:16 · John 3:16")
  assert.equal(mod.formatBilingualReference(ref, 18), "Jean 3:16-18 · John 3:16-18")
  // Unknown book names degrade to the capitalized English name on the French side.
  assert.equal(
    mod.formatBilingualReference({ book: "3 john", chapter: 1, verse: 2 }),
    "3 Jean 1:2 · 3 John 1:2"
  )
})

test("reference-format: the French book table and translation set are intact", () => {
  const mod = loadModule()
  assert.equal(mod.FRENCH_BOOK_NAMES["psalm"], "Psaumes")
  assert.equal(mod.FRENCH_BOOK_NAMES["song of solomon"], "Cantique des Cantiques")
  assert.ok(Object.keys(mod.FRENCH_BOOK_NAMES).length >= 66, "the table lost books")
  for (const id of ["ls1910", "lsg", "segond", "darby"]) {
    assert.ok(mod.FRENCH_TRANSLATIONS.has(id), `FRENCH_TRANSLATIONS lost ${id}`)
  }
})

test("reference-format: capitalize uppercases each word boundary", () => {
  const mod = loadModule()
  assert.equal(mod.capitalize("song of solomon"), "Song Of Solomon")
})
