import { test } from "node:test"
import assert from "node:assert/strict"
import { FreeApiSource } from "./free-api-source"

const JOHN_3_16 = { book: "john", chapter: 3, verse: 16 }

function fakeFetch(responseFactory: (url: string) => Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    return responseFactory(String(input))
  }) as typeof fetch
}

test("FreeApiSource: parses a well-formed 200 response into a Verse", async () => {
  const source = new FreeApiSource(
    fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            reference: "John 3:16",
            text: "For God so loved the world...",
            translation_id: "kjv",
            translation_name: "King James Version",
          }),
          { status: 200 }
        )
    )
  )
  const verse = await source.getVerse(JOHN_3_16)
  assert.deepEqual(verse, {
    reference: JOHN_3_16,
    text: "For God so loved the world...",
    translation: "kjv",
    source: "bible-api.com",
  })
})

test("FreeApiSource: trims surrounding whitespace from the verse text", async () => {
  const source = new FreeApiSource(
    fakeFetch(
      () =>
        new Response(
          JSON.stringify({ text: "\n   For God so loved the world...\n\n", translation_id: "kjv" }),
          { status: 200 }
        )
    )
  )
  const verse = await source.getVerse(JOHN_3_16)
  assert.equal(verse?.text, "For God so loved the world...")
})

test("FreeApiSource: requests the kjv translation and a correctly-encoded reference URL", async () => {
  let requestedUrl = ""
  const source = new FreeApiSource(
    fakeFetch((url) => {
      requestedUrl = url
      return new Response(JSON.stringify({ text: "x", translation_id: "kjv" }), { status: 200 })
    })
  )
  await source.getVerse({ book: "1 corinthians", chapter: 13, verse: 4 })
  assert.equal(requestedUrl, "https://bible-api.com/1%20corinthians+13:4?translation=kjv")
})

// Observed directly against the live API: an unknown book comes back as a
// JSON error body with a 404 status.
test("FreeApiSource: a JSON error body with a non-OK status yields no verse", async () => {
  const source = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
  )
  assert.equal(await source.getVerse({ book: "frogs", chapter: 3, verse: 16 }), null)
})

// Observed directly against the live API: some 404s come back as a bare
// HTML page, not JSON — must not throw or be treated as success.
test("FreeApiSource: a non-JSON HTML 404 body yields no verse, without throwing", async () => {
  const source = new FreeApiSource(
    fakeFetch(
      () => new Response("<html><body>404 Not Found</body></html>", { status: 404 })
    )
  )
  await assert.doesNotReject(() => source.getVerse(JOHN_3_16))
  assert.equal(await source.getVerse(JOHN_3_16), null)
})

test("FreeApiSource: an OK status with a malformed (non-JSON) body yields no verse, without throwing", async () => {
  const source = new FreeApiSource(fakeFetch(() => new Response("not json", { status: 200 })))
  await assert.doesNotReject(() => source.getVerse(JOHN_3_16))
  assert.equal(await source.getVerse(JOHN_3_16), null)
})

test("FreeApiSource: an OK response missing required fields yields no verse (never trust HTTP 200 alone)", async () => {
  const missingText = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ translation_id: "kjv" }), { status: 200 }))
  )
  const missingTranslation = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ text: "x" }), { status: 200 }))
  )
  const wrongTypes = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ text: 42, translation_id: "kjv" }), { status: 200 }))
  )
  const arrayBody = new FreeApiSource(fakeFetch(() => new Response(JSON.stringify([1, 2, 3]), { status: 200 })))

  assert.equal(await missingText.getVerse(JOHN_3_16), null)
  assert.equal(await missingTranslation.getVerse(JOHN_3_16), null)
  assert.equal(await wrongTypes.getVerse(JOHN_3_16), null)
  assert.equal(await arrayBody.getVerse(JOHN_3_16), null)
})

test("FreeApiSource: a network failure (fetch rejects) yields no verse, without throwing", async () => {
  const source = new FreeApiSource(
    (async () => {
      throw new Error("network down")
    }) as typeof fetch
  )
  await assert.doesNotReject(() => source.getVerse(JOHN_3_16))
  assert.equal(await source.getVerse(JOHN_3_16), null)
})
