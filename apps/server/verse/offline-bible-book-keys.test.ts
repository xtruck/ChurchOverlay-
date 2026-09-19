import { test } from "node:test"
import assert from "node:assert/strict"
import { OFFLINE_BIBLE_BOOK_KEYS } from "./offline-bible-book-keys"
import { BOOK_CATALOG } from "./book-catalog"
import { loadOfflineBibleData } from "./offline-verse-source"

test("OFFLINE_BIBLE_BOOK_KEYS: covers exactly the same 66 canonical ids as BOOK_CATALOG, no more, no fewer", () => {
  const catalogIds = BOOK_CATALOG.map((entry) => entry.id).sort()
  const mappedIds = Object.keys(OFFLINE_BIBLE_BOOK_KEYS).sort()
  assert.deepEqual(mappedIds, catalogIds)
})

test("OFFLINE_BIBLE_BOOK_KEYS: every mapped key is unique — no two canonical ids collide on the same offline key", () => {
  const values = Object.values(OFFLINE_BIBLE_BOOK_KEYS)
  assert.equal(new Set(values).size, values.length)
})

// "Verify, don't assume" (this codebase's own standing discipline for
// external/bundled data, e.g. BOOK_CATALOG's own comment about its KJV
// source): this hand-written 66-entry mapping table is exactly the kind
// of thing a single typo could silently break for one specific book —
// checked directly against the real bundled file, not just internal
// self-consistency.
test("OFFLINE_BIBLE_BOOK_KEYS: every mapped key actually exists as a top-level entry in the real bundled data file", async () => {
  const data = await loadOfflineBibleData()
  for (const [canonicalId, offlineKey] of Object.entries(OFFLINE_BIBLE_BOOK_KEYS)) {
    assert.ok(data[offlineKey], `"${canonicalId}" maps to "${offlineKey}", which is missing from the bundled file`)
  }
})

test("OFFLINE_BIBLE_BOOK_KEYS + the real bundled file: every book maps to real data, with the same chapter count as BOOK_CATALOG", async () => {
  const data = await loadOfflineBibleData()
  for (const book of BOOK_CATALOG) {
    const offlineKey = OFFLINE_BIBLE_BOOK_KEYS[book.id] as string
    const offlineBook = data[offlineKey]
    assert.ok(offlineBook, `"${book.id}" (offline key "${offlineKey}") is missing entirely`)
    assert.equal(
      Object.keys(offlineBook).length,
      book.chapters.length,
      `"${book.id}" has ${book.chapters.length} chapters in BOOK_CATALOG but ${Object.keys(offlineBook).length} in the offline data`
    )
    // Deliberately NOT asserting per-chapter verse counts match BOOK_CATALOG
    // exactly: a real, one-time comprehensive comparison found 106 chapters
    // (Psalms overwhelmingly, plus scattered others) where they legitimately
    // differ — this is real versification variation between the KJV-based
    // counts BOOK_CATALOG documents itself as sourced from and Louis
    // Segond's own French text (most commonly the Hebrew-tradition
    // convention of counting a Psalm's superscription as verse 1, which
    // KJV prints as an unnumbered heading instead, shifting every later
    // verse by one) — not a data error in either dataset. See
    // ARCHITECTURE.md section 77.1 for the full finding and why it's
    // recorded as a known, deferred gap rather than "fixed" here.
  }
})
