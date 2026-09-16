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

// getVerse()'s Promise<Verse|null> contract only has room for two
// outcomes: null must mean a confirmed, healthy "no verse here" so that a
// CircuitBreaker sitting in front of this never opens over legitimately
// missing references — a thrown error means something about the request
// or the service actually failed, which a CircuitBreaker should count.
// Observed directly against the live API: an unknown book reliably
// returns HTTP 404 (as either a JSON error body or a bare HTML page,
// depending on the failure mode) — both are the "not found" case.
test("FreeApiSource: a 404 (JSON error body) resolves to null, the confirmed not-found case", async () => {
  const source = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
  )
  assert.equal(await source.getVerse({ book: "frogs", chapter: 3, verse: 16 }), null)
})

test("FreeApiSource: a 404 (bare HTML body) also resolves to null, without throwing", async () => {
  const source = new FreeApiSource(
    fakeFetch(() => new Response("<html><body>404 Not Found</body></html>", { status: 404 }))
  )
  await assert.doesNotReject(() => source.getVerse(JOHN_3_16))
  assert.equal(await source.getVerse(JOHN_3_16), null)
})

test("FreeApiSource: a non-404 error status is a real failure — it throws", async () => {
  const source = new FreeApiSource(fakeFetch(() => new Response("Internal Server Error", { status: 500 })))
  await assert.rejects(() => source.getVerse(JOHN_3_16))
})

test("FreeApiSource: a 200 response with a malformed (non-JSON) body is a real failure — it throws", async () => {
  const source = new FreeApiSource(fakeFetch(() => new Response("not json", { status: 200 })))
  await assert.rejects(() => source.getVerse(JOHN_3_16))
})

test("FreeApiSource: a 200 response missing required fields is a real failure — it throws (never trust HTTP 200 alone)", async () => {
  const missingText = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ translation_id: "kjv" }), { status: 200 }))
  )
  const missingTranslation = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ text: "x" }), { status: 200 }))
  )
  const wrongTypes = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify({ text: 42, translation_id: "kjv" }), { status: 200 }))
  )
  const arrayBody = new FreeApiSource(
    fakeFetch(() => new Response(JSON.stringify([1, 2, 3]), { status: 200 }))
  )

  await assert.rejects(() => missingText.getVerse(JOHN_3_16))
  await assert.rejects(() => missingTranslation.getVerse(JOHN_3_16))
  await assert.rejects(() => wrongTypes.getVerse(JOHN_3_16))
  await assert.rejects(() => arrayBody.getVerse(JOHN_3_16))
})

test("FreeApiSource: a network failure (fetch rejects) is a real failure — it throws", async () => {
  const source = new FreeApiSource(
    (async () => {
      throw new Error("network down")
    }) as typeof fetch
  )
  await assert.rejects(() => source.getVerse(JOHN_3_16), /network down/)
})
