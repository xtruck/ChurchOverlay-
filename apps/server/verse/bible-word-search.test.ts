import { test } from "node:test"
import assert from "node:assert/strict"
import { BibleWordSearch, searchLoadedChapters, searchTokens } from "./bible-word-search"
import { loadOfflineBibleData, type OfflineBibleData } from "./offline-verse-source"
import { KnownValidVerseIndex } from "./known-valid-verse-index"
import type { Verse } from "../../../packages/contracts"

const SMALL: OfflineBibleData = {
  jean: {
    "3": {
      "16": "Car Dieu a tant aimé le monde qu'il a donné son Fils unique, afin que quiconque croit en lui ne périsse point, mais qu'il ait la vie éternelle.",
      "17": "Dieu, en effet, n'a pas envoyé son Fils dans le monde pour qu'il juge le monde, mais pour que le monde soit sauvé par lui.",
    },
    "11": { "35": "Jésus pleura." },
  },
  psaumes: { "23": { "1": "L'Éternel est mon berger: je ne manquerai de rien." } },
}

test("searchTokens: folds accents and case, splits at apostrophes, drops one-letter fragments", () => {
  assert.deepEqual(searchTokens("L'Éternel est mon BERGER, ô Dieu!"), ["eternel", "est", "mon", "berger", "dieu"])
})

test("BibleWordSearch: finds a verse from a few remembered words, accents and case ignored", () => {
  const search = new BibleWordSearch(SMALL)
  const result = search.search("dieu a tant aime le monde")
  assert.deepEqual(result.hits[0]?.reference, { book: "john", chapter: 3, verse: 16 })
  assert.equal(result.hits[0]?.translation, "ls1910")
  assert.ok(result.hits[0] && result.hits[0].score > 0.5)
})

test("BibleWordSearch: a word that is elided in the text (l'Éternel) is found without the article", () => {
  const search = new BibleWordSearch(SMALL)
  assert.deepEqual(search.search("eternel berger").hits[0]?.reference, { book: "psalm", chapter: 23, verse: 1 })
})

test("BibleWordSearch: the last word may be a prefix (the operator is still typing)", () => {
  const search = new BibleWordSearch(SMALL)
  assert.deepEqual(search.search("jesus pleu").hits[0]?.reference, { book: "john", chapter: 11, verse: 35 })
})

test("BibleWordSearch: words in the right order outrank the same words scattered", () => {
  const search = new BibleWordSearch({
    jean: { "1": { "1": "le monde pour que Dieu soit loué", "2": "pour que le monde soit sauvé" } },
  })
  const hits = search.search("pour que le monde").hits
  assert.deepEqual(hits[0]?.reference, { book: "john", chapter: 1, verse: 2 })
})

test("BibleWordSearch: unknown words, empty input and noise find nothing and never throw", () => {
  const search = new BibleWordSearch(SMALL)
  assert.deepEqual(search.search("zzzzzz qqqqqq").hits, [])
  assert.deepEqual(search.search("").hits, [])
  assert.deepEqual(search.search("!!! ??? a").hits, [])
  assert.deepEqual(search.search("x".repeat(5000)).hits, [])
})

test("BibleWordSearch: results are bounded by the limit and report the full match count", () => {
  const verses: Record<string, string> = {}
  for (let v = 1; v <= 40; v++) verses[String(v)] = `Dieu est amour numero${v}`
  const result = new BibleWordSearch({ jean: { "1": verses } }).search("amour", 5)
  assert.equal(result.hits.length, 5)
  assert.equal(result.total, 40)
})

test("BibleWordSearch.buildAsync builds the same index as the constructor", async () => {
  const built = await BibleWordSearch.buildAsync(SMALL, 0)
  assert.equal(built.size, 4)
  assert.deepEqual(built.search("jesus pleura").hits[0]?.reference, { book: "john", chapter: 11, verse: 35 })
})

test("BibleWordSearch on the real bundled Louis Segond text: well-known verses are found, and every hit exists in the known-valid index", async () => {
  const data = await loadOfflineBibleData()
  const search = await BibleWordSearch.buildAsync(data)
  const index = new KnownValidVerseIndex()
  assert.ok(search.size > 31000, `expected the whole Bible, got ${search.size} verses`)

  const cases: Array<[string, { book: string; chapter: number; verse: number }]> = [
    ["Dieu a tant aimé le monde", { book: "john", chapter: 3, verse: 16 }],
    ["l'Éternel est mon berger", { book: "psalm", chapter: 23, verse: 1 }],
    ["au commencement Dieu créa les cieux et la terre", { book: "genesis", chapter: 1, verse: 1 }],
    ["Jésus pleura", { book: "john", chapter: 11, verse: 35 }],
  ]
  for (const [query, expected] of cases) {
    const top = search.search(query).hits.slice(0, 3).map((h) => h.reference)
    assert.ok(
      top.some((ref) => ref.book === expected.book && ref.chapter === expected.chapter && ref.verse === expected.verse),
      `"${query}" should rank ${expected.book} ${expected.chapter}:${expected.verse} in its top 3, got ${JSON.stringify(top)}`
    )
  }
  for (const query of ["amour", "foi esperance charite", "paix"]) {
    for (const hit of search.search(query).hits) assert.ok(index.exists(hit.reference), `hit ${JSON.stringify(hit.reference)} must exist`)
  }
})

function chapterOf(translation: string, texts: string[]): Verse[] {
  return texts.map((text, i) => ({ reference: { book: "john", chapter: 3, verse: i + 1 }, text, translation, source: "x" }))
}

test("searchLoadedChapters: finds English text in chapters that were already read, skips French LSG (covered by the full index)", () => {
  const english = chapterOf("kjv", ["For God so loved the world", "God sent not his Son"])
  const french = chapterOf("ls1910", ["Car Dieu a tant aimé le monde"])
  const result = searchLoadedChapters("loved the world", [english, french])
  assert.deepEqual(result.hits[0]?.reference, { book: "john", chapter: 3, verse: 1 })
  assert.equal(result.hits[0]?.translation, "kjv")
  assert.equal(searchLoadedChapters("tant aime monde", [french]).total, 0)
})

test("searchLoadedChapters: bilingual chapters are searched in their English secondary text too", () => {
  const verse: Verse = {
    reference: { book: "john", chapter: 3, verse: 16 },
    text: "Car Dieu a tant aimé le monde",
    translation: "ls1910",
    source: "x",
    secondary: { text: "For God so loved the world", translation: "kjv", source: "y" },
  }
  const result = searchLoadedChapters("god so loved", [[verse]])
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.translation, "kjv")
})

test("createLazyBibleWordSearch: a failed build is reported (onError, failed()), never left as 'indexing' forever", async () => {
  const { createLazyBibleWordSearch } = await import("./bible-word-search")
  const broken = new Proxy({}, { get: () => { throw new Error("corrupt data") } }) as OfflineBibleData
  let reported: unknown = null
  const lazy = createLazyBibleWordSearch(broken, undefined, (error) => { reported = error })
  assert.equal(lazy.failed(), false)
  for (let i = 0; i < 50 && !lazy.failed(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lazy.failed(), true)
  assert.match(String(reported), /corrupt data/)
  assert.equal(lazy.current(), null)
})
