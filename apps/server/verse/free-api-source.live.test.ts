/**
 * Live integration test for FreeApiSource against the real bible-api.com.
 * Self-skips when BIBLE_API_URL is not set (defaults to bible-api.com if set to "default").
 * This is the only test that makes real network requests to the Bible API.
 * All other tests mock the fetch implementation (AGENTS.md sections 32-33).
 */

import { strict as assert } from "node:assert"
import { test, before, after } from "node:test"
import { FreeApiSource } from "./free-api-source"
import type { VerseReference } from "../../../packages/contracts"

const API_URL = process.env.BIBLE_API_URL ?? (process.env.TEST_LIVE_BIBLE_API === "true" ? "https://bible-api.com" : null)

before(() => {
  if (!API_URL) {
    console.log("Skipping live Bible API test: set BIBLE_API_URL environment variable (or TEST_LIVE_BIBLE_API=true for default)")
  }
})

test("FreeApiSource live: fetches a valid verse from the real Bible API", async () => {
  if (!API_URL) return

  const source = new FreeApiSource(fetch, API_URL)
  const reference: VerseReference = { book: "John", chapter: 3, verse: 16 }

  const verse = await source.getVerse(reference)

  assert.ok(verse !== null, "John 3:16 should exist")
  assert.equal(verse.reference.book, "John")
  assert.equal(verse.reference.chapter, 3)
  assert.equal(verse.reference.verse, 16)
  assert.ok(verse.text.length > 0, "verse text should not be empty")
  assert.ok(verse.text.toLowerCase().includes("god") || verse.text.toLowerCase().includes("son"), "verse should contain expected content")
  assert.equal(verse.source, "bible-api.com")
})

test("FreeApiSource live: returns null for a non-existent reference", async () => {
  if (!API_URL) return

  const source = new FreeApiSource(fetch, API_URL)
  const reference: VerseReference = { book: "FakeBook", chapter: 999, verse: 999 }

  const verse = await source.getVerse(reference)

  assert.equal(verse, null, "non-existent reference should return null")
})

test("FreeApiSource live: handles network errors gracefully", async () => {
  if (!API_URL) return

  const source = new FreeApiSource(fetch, "https://this-domain-does-not-exist-12345.com")
  const reference: VerseReference = { book: "John", chapter: 3, verse: 16 }

  await assert.rejects(
    async () => source.getVerse(reference),
    /network request failed/i,
    "should throw on network error"
  )
})

test("FreeApiSource live: schema validation rejects malformed responses", async () => {
  if (!API_URL) return

  // Test with a valid URL that returns non-JSON (example.com returns HTML)
  const source = new FreeApiSource(fetch, "https://example.com")
  const reference: VerseReference = { book: "John", chapter: 3, verse: 16 }

  await assert.rejects(
    async () => source.getVerse(reference),
    /not valid JSON|missing required verse fields/i,
    "should reject non-JSON or malformed responses"
  )
})
