import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { BOOK_CATALOG } from "../../server/verse/book-catalog"

// Compiled to dist/apps/desktop/renderer/ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const RENDERER = join(REPO_ROOT, "apps", "desktop", "renderer")
const script = readFileSync(join(RENDERER, "bible-browser.js"), "utf8")
const i18n = readFileSync(join(RENDERER, "i18n.js"), "utf8")
const html = readFileSync(join(RENDERER, "index.html"), "utf8")
const dashboard = readFileSync(join(RENDERER, "dashboard.js"), "utf8")

type Cursor = { book: string; chapter: number; verse: number }
type Logic = {
  BOOKS: Array<[string, string, string, number]>
  LAST_VERSE: number
  stepCursor(cursor: Cursor, direction: string, lastVerse: number): Cursor | null
  bookName(id: string, language: string): string
  highlightParts(text: string, query: string): Array<{ text: string; match: boolean }>
}

function loadLogic(): Logic {
  // No document in this context: the file registers its pure logic and skips the UI.
  const context: { ChurchOverlayBibleLogic?: Logic } = {}
  runInNewContext(script, context)
  if (!context.ChurchOverlayBibleLogic) throw new Error("bible-browser.js did not register its logic")
  return context.ChurchOverlayBibleLogic
}

const logic = loadLogic()
// Values built inside the vm context have that realm's Array/Object prototypes: normalize before deepEqual.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const at = (book: string, chapter: number, verse: number): Cursor => ({ book, chapter, verse })

test("book table: the 66 books, in catalog order, with the catalog's chapter counts (no drift from BOOK_CATALOG)", () => {
  assert.equal(logic.BOOKS.length, 66)
  assert.deepEqual(plain(logic.BOOKS.map((b) => b[0])), BOOK_CATALOG.map((b) => b.id))
  assert.deepEqual(plain(logic.BOOKS.map((b) => b[3])), BOOK_CATALOG.map((b) => b.chapters.length))
  assert.equal(new Set(logic.BOOKS.map((b) => b[1])).size, 66, "English names are unique")
  assert.equal(new Set(logic.BOOKS.map((b) => b[2])).size, 66, "French names are unique")
  assert.equal(logic.BOOKS[38]?.[0], "malachi", "39 Old Testament books")
  assert.equal(logic.BOOKS[39]?.[0], "matthew")
})

test("bookName: French and English names by UI language", () => {
  assert.equal(logic.bookName("john", "fr"), "Jean")
  assert.equal(logic.bookName("john", "en"), "John")
  assert.equal(logic.bookName("psalm", "en"), "Psalms")
  assert.equal(logic.bookName("psalm", "fr"), "Psaumes")
  assert.equal(logic.bookName("isaiah", "fr"), "Ésaïe")
  assert.equal(logic.bookName("not-a-book", "fr"), "not-a-book")
})

test("stepCursor: verse steps stay in the chapter, then cross chapters and books", () => {
  assert.deepEqual(plain(logic.stepCursor(at("john", 3, 16), "next-verse", 36)), at("john", 3, 17))
  assert.deepEqual(plain(logic.stepCursor(at("john", 3, 16), "previous-verse", 36)), at("john", 3, 15))
  assert.deepEqual(plain(logic.stepCursor(at("john", 3, 36), "next-verse", 36)), at("john", 4, 1))
  assert.deepEqual(plain(logic.stepCursor(at("john", 21, 25), "next-verse", 25)), at("acts", 1, 1))
  assert.deepEqual(plain(logic.stepCursor(at("john", 3, 1), "previous-verse", 36)), at("john", 2, logic.LAST_VERSE))
  assert.deepEqual(plain(logic.stepCursor(at("john", 1, 1), "previous-verse", 51)), at("luke", 24, logic.LAST_VERSE))
})

test("stepCursor: chapter steps land on verse 1, like the server's own navigation", () => {
  assert.deepEqual(plain(logic.stepCursor(at("john", 3, 16), "next-chapter", 36)), at("john", 4, 1))
  assert.deepEqual(plain(logic.stepCursor(at("john", 3, 16), "previous-chapter", 36)), at("john", 2, 1))
  assert.deepEqual(plain(logic.stepCursor(at("john", 21, 5), "next-chapter", 25)), at("acts", 1, 1))
  assert.deepEqual(plain(logic.stepCursor(at("acts", 1, 5), "previous-chapter", 26)), at("john", 21, 1))
})

test("stepCursor: no step past the ends of the Bible, and unknown input is a no-op", () => {
  assert.equal(logic.stepCursor(at("genesis", 1, 1), "previous-verse", 31), null)
  assert.equal(logic.stepCursor(at("genesis", 1, 1), "previous-chapter", 31), null)
  assert.equal(logic.stepCursor(at("revelation", 22, 21), "next-verse", 21), null)
  assert.equal(logic.stepCursor(at("revelation", 22, 21), "next-chapter", 21), null)
  assert.equal(logic.stepCursor(at("nope", 1, 1), "next-verse", 5), null)
  assert.equal(logic.stepCursor(at("john", 3, 16), "sideways", 36), null)
})

test("highlightParts: marks the searched words, accents and case ignored, and the word being typed as a prefix", () => {
  const parts = logic.highlightParts("Car Dieu a tant aimé le monde", "tant aime")
  assert.deepEqual(plain(parts.filter((p) => p.match).map((p) => p.text.trim())), ["tant aimé"])
  assert.equal(parts.map((p) => p.text).join(""), "Car Dieu a tant aimé le monde", "no character is lost")
  assert.deepEqual(plain(logic.highlightParts("Jésus pleura", "jesus pleu").filter((p) => p.match).map((p) => p.text.trim())), ["Jésus pleura"])
  assert.deepEqual(plain(logic.highlightParts("plain text", "")), [{ text: "plain text", match: false }])
})

test("i18n: every Bible Browser string exists in BOTH English and French, with the same placeholders", () => {
  const keys = [...new Set([...script.matchAll(/"(bible\.[\w.]+)"/g)].map((m) => m[1] as string))]
  assert.ok(keys.length > 30, "expected the view to use many labels")
  const table = (language: "en" | "fr"): string => {
    const start = i18n.indexOf(`    ${language}: {`)
    const end = language === "en" ? i18n.indexOf("    fr: {") : i18n.indexOf("  function ", start)
    return i18n.slice(start, end)
  }
  const valueOf = (source: string, key: string): string | null => {
    const match = source.match(new RegExp(`^\\s{6}"${key.replace(/\./g, "\\.")}":\\s*"((?:[^"\\\\]|\\\\.)*)",?\\s*$`, "m"))
    return match ? (match[1] as string) : null
  }
  const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const key of [...keys, "nav.bible"]) {
    const en = valueOf(table("en"), key)
    const fr = valueOf(table("fr"), key)
    assert.ok(en, `${key} missing in English`)
    assert.ok(fr, `${key} missing in French`)
    assert.deepEqual(params(fr as string), params(en as string), `placeholder mismatch for ${key}`)
  }
})

test("index.html and dashboard.js are wired to the Bible view", () => {
  assert.match(html, /id="view-bible"/)
  assert.match(html, /id="nav-bible"[^>]*data-view="bible"/)
  assert.match(html, /<script src="\.\/bible-browser\.js"><\/script>/)
  assert.match(html, /<link href="bible-browser\.css" rel="stylesheet"/)
  assert.match(dashboard, /const VIEW_ORDER = \[[^\]]*"bible"[^\]]*\]/)
  assert.match(dashboard, /bible: document\.getElementById\("view-bible"\)/)
  assert.match(dashboard, /window\.ChurchOverlayBridge = \{/)
  assert.ok(html.indexOf("dashboard.js") < html.indexOf("bible-browser.js"), "the bridge must exist before the view loads")
})

test("Bible Browser exposes the selected verse and leaves focused controls' keys alone", () => {
  assert.match(script, /row\.id = "bb-verse-option-" \+ entry\.verse/)
  assert.match(script, /setAttribute\("aria-activedescendant", selectedRow\.id\)/)
  assert.match(script, /else el\.verses\.removeAttribute\("aria-activedescendant"\)/)
  assert.match(script, /function interactiveTarget\(target\)[\s\S]*?target\.closest\('button, a\[href\], \[role="button"\], \[role="tab"\]'\)/)
  assert.match(script, /if \(interactiveTarget\(event\.target\)\) return/)
})

test("security: server text is only ever rendered with textContent (never innerHTML or eval)", () => {
  assert.doesNotMatch(script, /\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\b|\beval\(|new Function\(|document\.write/)
})
