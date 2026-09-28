import { test } from "node:test"
import assert from "node:assert/strict"
import {
  canonicalReferenceKey,
  getCrossReferences,
  prefetchCrossReferences,
} from "./cross-reference-engine"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts/verse"

test("canonicalReferenceKey: normalizes book names and numbers", () => {
  assert.equal(canonicalReferenceKey({ book: "  John ", chapter: 3, verse: 16 }), "john:3:16")
  assert.equal(canonicalReferenceKey({ book: "1 John", chapter: 4, verse: 9 }), "1 john:4:9")
})

test("getCrossReferences: returns cross references for known theological keystones", () => {
  const john316 = getCrossReferences({ book: "john", chapter: 3, verse: 16 })
  assert.ok(john316.length >= 3)
  assert.ok(john316.some((r) => r.reference.book === "romans" && r.reference.chapter === 5))

  const unknown = getCrossReferences({ book: "obadiah", chapter: 1, verse: 4 })
  assert.deepEqual(unknown, [])
})

test("prefetchCrossReferences: queries source for each cross reference and returns loaded count", async () => {
  const queried: VerseReference[] = []
  const mockSource: VerseSource = {
    async getVerse(ref: VerseReference): Promise<Verse | null> {
      queried.push(ref)
      return {
        reference: ref,
        text: "Mock text",
        translation: "kjv",
        source: "mock",
      }
    },
  }

  const count = await prefetchCrossReferences({ book: "john", chapter: 3, verse: 16 }, mockSource)
  assert.equal(count, 4)
  assert.equal(queried.length, 4)
})

test("prefetchCrossReferences: handles null or errors gracefully without failing", async () => {
  const mockFailingSource: VerseSource = {
    async getVerse(ref: VerseReference): Promise<Verse | null> {
      if (ref.book === "romans") throw new Error("Network timeout")
      return null
    },
  }

  const count = await prefetchCrossReferences({ book: "john", chapter: 3, verse: 16 }, mockFailingSource)
  assert.equal(count, 0)
})
