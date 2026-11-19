import { test } from "node:test"
import assert from "node:assert/strict"
import { GetBibleVerseSource } from "./get-bible-verse-source"
import { FreeApiSource } from "./free-api-source"
import { OfflineVerseSource } from "./offline-verse-source"
import { OfflineFallbackVerseSource } from "./offline-fallback-verse-source"
import { LocalizedVerseSource } from "./localized-verse-source"
import type { Verse, VerseSource } from "../../../packages/contracts"

// Bible Browser: the optional getChapter() capability of each existing VerseSource.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function fetchReturning(make: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (url: string) => make(String(url))) as unknown as typeof fetch
}

const FIXTURE = {
  jean: { "3": { "1": "Il y avait un homme.", "2": "Cet homme vint.", "16": "Car Dieu a tant aimé le monde." } },
}

test("GetBibleVerseSource.getChapter: one request, every verse, sorted, in the requested book and chapter", async () => {
  let requests = 0
  const fetchImpl = fetchReturning((url) => {
    requests += 1
    assert.match(url, /\/ls1910\/43\/3\.json$/)
    return jsonResponse({ verses: [{ chapter: 3, verse: 2, text: " b " }, { chapter: 3, verse: 1, text: "a" }] })
  })
  const chapter = await new GetBibleVerseSource(fetchImpl).getChapter("john", 3)
  assert.equal(requests, 1)
  assert.deepEqual(
    chapter?.map((v) => [v.reference.verse, v.text, v.translation, v.source]),
    [
      [1, "a", "ls1910", "getbible.net"],
      [2, "b", "ls1910", "getbible.net"],
    ]
  )
})

test("GetBibleVerseSource.getChapter: 404 is null, a malformed entry throws, a network error throws", async () => {
  assert.equal(await new GetBibleVerseSource(fetchReturning(() => new Response("", { status: 404 }))).getChapter("john", 3), null)
  assert.equal(await new GetBibleVerseSource().getChapter("notabook", 1), null)
  await assert.rejects(new GetBibleVerseSource(fetchReturning(() => jsonResponse({ verses: [{ verse: 1, text: "" }] }))).getChapter("john", 3))
  await assert.rejects(new GetBibleVerseSource(fetchReturning(() => jsonResponse({ nope: true }))).getChapter("john", 3))
  await assert.rejects(
    new GetBibleVerseSource(
      fetchReturning(() => {
        throw new Error("offline")
      })
    ).getChapter("john", 3)
  )
})

test("FreeApiSource.getChapter: whole chapter in one request; a verse of another chapter is rejected", async () => {
  const fetchImpl = fetchReturning((url) => {
    assert.match(url, /\/john\+3\?translation=kjv$/)
    return jsonResponse({ translation_id: "kjv", verses: [{ chapter: 3, verse: 2, text: "two" }, { chapter: 3, verse: 1, text: "one" }] })
  })
  const chapter = await new FreeApiSource(fetchImpl).getChapter("john", 3)
  assert.deepEqual(chapter?.map((v) => v.text), ["one", "two"])
  assert.equal(chapter?.[0]?.source, "bible-api.com")
  const wrong = fetchReturning(() => jsonResponse({ translation_id: "kjv", verses: [{ chapter: 4, verse: 1, text: "x" }] }))
  await assert.rejects(new FreeApiSource(wrong).getChapter("john", 3))
  assert.equal(await new FreeApiSource(fetchReturning(() => new Response("", { status: 404 }))).getChapter("john", 3), null)
})

test("OfflineVerseSource.getChapter: reads the bundled data, null for an unknown book or chapter", async () => {
  const source = new OfflineVerseSource(FIXTURE)
  const chapter = await source.getChapter("john", 3)
  assert.deepEqual(chapter?.map((v) => v.reference.verse), [1, 2, 16])
  assert.equal(chapter?.[0]?.source, "offline-bundled")
  assert.equal(await source.getChapter("john", 9), null)
  assert.equal(await source.getChapter("nope", 1), null)
})

test("OfflineFallbackVerseSource.getChapter: live when healthy, bundled when the live read fails, rethrows when neither knows", async () => {
  const live: Verse[] = [{ reference: { book: "john", chapter: 3, verse: 1 }, text: "live", translation: "ls1910", source: "getbible.net" }]
  const healthy: VerseSource & { getChapter(): Promise<readonly Verse[]> } = { getVerse: async () => null, getChapter: async () => live }
  const broken: VerseSource & { getChapter(): Promise<never> } = {
    getVerse: async () => null,
    getChapter: async () => {
      throw new Error("down")
    },
  }
  const offline = new OfflineVerseSource(FIXTURE)

  assert.equal((await new OfflineFallbackVerseSource({ primary: healthy, offline }).getChapter("john", 3))?.[0]?.text, "live")
  assert.equal((await new OfflineFallbackVerseSource({ primary: broken, offline }).getChapter("john", 3))?.[0]?.source, "offline-bundled")
  await assert.rejects(new OfflineFallbackVerseSource({ primary: broken, offline }).getChapter("john", 9), /down/)
})

test("LocalizedVerseSource.getChapter: follows the display mode; bilingual attaches English as secondary per verse", async () => {
  const en: VerseSource & { getChapter(): Promise<readonly Verse[]> } = {
    getVerse: async () => null,
    getChapter: async () => [{ reference: { book: "john", chapter: 3, verse: 1 }, text: "english one", translation: "kjv", source: "bible-api.com" }],
  }
  const localized = new LocalizedVerseSource(en, new OfflineVerseSource(FIXTURE), "english")
  assert.equal((await localized.getChapter("john", 3))?.[0]?.text, "english one")
  localized.setMode("french")
  assert.equal((await localized.getChapter("john", 3))?.[0]?.text, "Il y avait un homme.")
  localized.setMode("bilingual")
  const both = await localized.getChapter("john", 3)
  assert.equal(both?.[0]?.secondary?.text, "english one")
  assert.equal(both?.[1]?.secondary, undefined, "no English text for verse 2: French alone, never a wrong pairing")
})

test("LocalizedVerseSource.getChapter: a failing SECONDARY language degrades to French; a failing primary rethrows", async () => {
  const brokenEn: VerseSource & { getChapter(): Promise<never> } = {
    getVerse: async () => null,
    getChapter: async () => {
      throw new Error("en down")
    },
  }
  const localized = new LocalizedVerseSource(brokenEn, new OfflineVerseSource(FIXTURE), "bilingual")
  const chapter = await localized.getChapter("john", 3)
  assert.equal(chapter?.length, 3)
  assert.equal(chapter?.[0]?.secondary, undefined)
  const brokenFr = new LocalizedVerseSource(brokenEn, { getVerse: async () => null }, "french")
  await assert.rejects(brokenFr.getChapter("john", 3))
})
