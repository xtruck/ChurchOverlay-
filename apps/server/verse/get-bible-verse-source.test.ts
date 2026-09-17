import { test } from "node:test"
import assert from "node:assert/strict"
import { GetBibleVerseSource } from "./get-bible-verse-source"

const JOHN_3_16 = { book: "john", chapter: 3, verse: 16 }

function fakeFetch(responseFactory: (url: string) => Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    return responseFactory(String(input))
  }) as typeof fetch
}

function chapterResponse(verses: Array<{ verse: number; text: string }>): Response {
  return new Response(
    JSON.stringify({
      translation: "Louis Segond (1910)",
      abbreviation: "ls1910",
      book_nr: 43,
      chapter: 3,
      verses: verses.map((v) => ({ chapter: 3, verse: v.verse, name: `Jean 3:${v.verse}`, text: v.text })),
    }),
    { status: 200 }
  )
}

test("GetBibleVerseSource: parses a well-formed chapter response into a Verse for the requested verse", async () => {
  const source = new GetBibleVerseSource(
    fakeFetch(() =>
      chapterResponse([
        { verse: 15, text: "some other verse" },
        { verse: 16, text: "Car Dieu a tant aimé le monde..." },
        { verse: 17, text: "another verse" },
      ])
    )
  )
  const verse = await source.getVerse(JOHN_3_16)
  assert.deepEqual(verse, {
    reference: JOHN_3_16,
    text: "Car Dieu a tant aimé le monde...",
    translation: "ls1910",
    source: "getbible.net",
  })
})

test("GetBibleVerseSource: trims surrounding whitespace from the verse text", async () => {
  const source = new GetBibleVerseSource(
    fakeFetch(() => chapterResponse([{ verse: 16, text: "\n  Car Dieu a tant aimé le monde...\n\n" }]))
  )
  const verse = await source.getVerse(JOHN_3_16)
  assert.equal(verse?.text, "Car Dieu a tant aimé le monde...")
})

test("GetBibleVerseSource: requests book_nr computed from BOOK_CATALOG's own order, not a hardcoded guess", async () => {
  let requestedUrl = ""
  const source = new GetBibleVerseSource(
    fakeFetch((url) => {
      requestedUrl = url
      return chapterResponse([{ verse: 16, text: "x" }])
    })
  )
  await source.getVerse(JOHN_3_16)
  // John is BOOK_CATALOG index 42 -> book_nr 43, verified against the real API in ARCHITECTURE.md section 63.1.
  assert.equal(requestedUrl, "https://api.getbible.net/v2/ls1910/43/3.json")
})

test("GetBibleVerseSource: a verse number absent from the chapter resolves null — the versification-mismatch case (section 63.1)", async () => {
  const source = new GetBibleVerseSource(
    fakeFetch(() => chapterResponse([{ verse: 1, text: "x" }, { verse: 2, text: "y" }]))
  )
  assert.equal(await source.getVerse(JOHN_3_16), null)
})

test("GetBibleVerseSource: a book not in BOOK_CATALOG resolves null without making a request", async () => {
  let requested = false
  const source = new GetBibleVerseSource(
    fakeFetch(() => {
      requested = true
      return chapterResponse([])
    })
  )
  const result = await source.getVerse({ book: "not-a-real-book", chapter: 1, verse: 1 })
  assert.equal(result, null)
  assert.equal(requested, false)
})

test("GetBibleVerseSource: a 404 resolves to null, the confirmed not-found case", async () => {
  const source = new GetBibleVerseSource(
    fakeFetch(() => new Response(JSON.stringify({ type: "not_found" }), { status: 404 }))
  )
  assert.equal(await source.getVerse(JOHN_3_16), null)
})

test("GetBibleVerseSource: a non-404 error status is a real failure — it throws", async () => {
  const source = new GetBibleVerseSource(fakeFetch(() => new Response("error", { status: 500 })))
  await assert.rejects(() => source.getVerse(JOHN_3_16))
})

test("GetBibleVerseSource: a 200 response with a malformed (non-JSON) body is a real failure — it throws", async () => {
  const source = new GetBibleVerseSource(fakeFetch(() => new Response("not json", { status: 200 })))
  await assert.rejects(() => source.getVerse(JOHN_3_16))
})

test("GetBibleVerseSource: a 200 response missing the verses array is a real failure — it throws (never trust HTTP 200 alone)", async () => {
  const source = new GetBibleVerseSource(
    fakeFetch(() => new Response(JSON.stringify({ book_nr: 43 }), { status: 200 }))
  )
  await assert.rejects(() => source.getVerse(JOHN_3_16))
})

test("GetBibleVerseSource: a matched verse entry missing text is a real failure — it throws", async () => {
  const source = new GetBibleVerseSource(
    fakeFetch(() => new Response(JSON.stringify({ verses: [{ verse: 16 }] }), { status: 200 }))
  )
  await assert.rejects(() => source.getVerse(JOHN_3_16))
})

test("GetBibleVerseSource: a network failure (fetch rejects) is a real failure — it throws", async () => {
  const source = new GetBibleVerseSource(
    (async () => {
      throw new Error("network down")
    }) as typeof fetch
  )
  await assert.rejects(() => source.getVerse(JOHN_3_16), /network down/)
})
