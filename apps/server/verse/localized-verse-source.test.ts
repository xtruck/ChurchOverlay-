import { test } from "node:test"
import assert from "node:assert/strict"
import { LocalizedVerseSource } from "./localized-verse-source"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"

const JOHN_3_16: VerseReference = { book: "john", chapter: 3, verse: 16 }

/** Named per AGENTS.md section 45 — a test double, not a real verse source. */
class StubVerseSource implements VerseSource {
  callCount = 0
  constructor(private readonly result: Verse | null | (() => Promise<Verse | null>)) {}
  async getVerse(): Promise<Verse | null> {
    this.callCount += 1
    if (typeof this.result === "function") return this.result()
    return this.result
  }
}

function makeVerse(text: string, translation: string, source: string): Verse {
  return { reference: JOHN_3_16, text, translation, source }
}

const ENGLISH_VERSE = makeVerse("For God so loved the world...", "kjv", "bible-api.com")
const FRENCH_VERSE = makeVerse("Car Dieu a tant aimé le monde...", "ls1910", "getbible.net")

test("LocalizedVerseSource: english mode calls only the English source", async () => {
  const english = new StubVerseSource(ENGLISH_VERSE)
  const french = new StubVerseSource(FRENCH_VERSE)
  const source = new LocalizedVerseSource(english, french, "english")

  const result = await source.getVerse(JOHN_3_16)
  assert.deepEqual(result, ENGLISH_VERSE)
  assert.equal(english.callCount, 1)
  assert.equal(french.callCount, 0)
})

test("LocalizedVerseSource: french mode calls only the French source", async () => {
  const english = new StubVerseSource(ENGLISH_VERSE)
  const french = new StubVerseSource(FRENCH_VERSE)
  const source = new LocalizedVerseSource(english, french, "french")

  const result = await source.getVerse(JOHN_3_16)
  assert.deepEqual(result, FRENCH_VERSE)
  assert.equal(english.callCount, 0)
  assert.equal(french.callCount, 1)
})

test("LocalizedVerseSource: bilingual mode calls both and returns French as primary with English as secondary", async () => {
  const english = new StubVerseSource(ENGLISH_VERSE)
  const french = new StubVerseSource(FRENCH_VERSE)
  const source = new LocalizedVerseSource(english, french, "bilingual")

  const result = await source.getVerse(JOHN_3_16)
  assert.deepEqual(result, {
    ...FRENCH_VERSE,
    secondary: { text: ENGLISH_VERSE.text, translation: ENGLISH_VERSE.translation, source: ENGLISH_VERSE.source },
  })
  assert.equal(english.callCount, 1)
  assert.equal(french.callCount, 1)
})

test("LocalizedVerseSource: bilingual mode with French not found resolves null, even if English resolved", async () => {
  const english = new StubVerseSource(ENGLISH_VERSE)
  const french = new StubVerseSource(null)
  const source = new LocalizedVerseSource(english, french, "bilingual")

  assert.equal(await source.getVerse(JOHN_3_16), null)
})

test("LocalizedVerseSource: bilingual mode with English not found (versification mismatch) still returns French alone", async () => {
  const english = new StubVerseSource(null)
  const french = new StubVerseSource(FRENCH_VERSE)
  const source = new LocalizedVerseSource(english, french, "bilingual")

  const result = await source.getVerse(JOHN_3_16)
  assert.deepEqual(result, FRENCH_VERSE)
  assert.equal(result?.secondary, undefined)
})

test("LocalizedVerseSource: setMode()/getMode() change behavior live, without reconstructing the instance", async () => {
  const english = new StubVerseSource(ENGLISH_VERSE)
  const french = new StubVerseSource(FRENCH_VERSE)
  const source = new LocalizedVerseSource(english, french, "english")

  assert.equal(source.getMode(), "english")
  assert.deepEqual(await source.getVerse(JOHN_3_16), ENGLISH_VERSE)

  source.setMode("french")
  assert.equal(source.getMode(), "french")
  assert.deepEqual(await source.getVerse(JOHN_3_16), FRENCH_VERSE)
})

test("LocalizedVerseSource: bilingual mode resolves both sources concurrently, not sequentially", async () => {
  const order: string[] = []
  const english: VerseSource = {
    getVerse: async () => {
      order.push("english-start")
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push("english-end")
      return ENGLISH_VERSE
    },
  }
  const french: VerseSource = {
    getVerse: async () => {
      order.push("french-start")
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push("french-end")
      return FRENCH_VERSE
    },
  }
  const source = new LocalizedVerseSource(english, french, "bilingual")
  await source.getVerse(JOHN_3_16)

  // Both must start before either finishes — proves Promise.all, not sequential
  // awaits. French is listed first in the Promise.all array (it's primary in
  // bilingual mode), so it starts first; English's own async work still begins
  // before French's shorter timer resolves, proving true concurrency.
  assert.deepEqual(order, ["french-start", "english-start", "french-end", "english-end"])
})
