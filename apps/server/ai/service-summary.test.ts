import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildServiceSummaryInput,
  buildYouTubeDescription,
  generatePreachingAnalytics,
  generateSocialQuoteCardSvg,
} from "./service-summary"
import type { SessionEntry } from "../core/session-recorder"

function makeEntry(book: string, chapter: number, verse: number, text: string, offsetMs = 0): SessionEntry {
  return { reference: { book, chapter, verse }, text, translation: "kjv", timestamp: Date.now() + offsetMs }
}

test("buildServiceSummaryInput: includes every shown verse with its reference and text", () => {
  const entries = [makeEntry("john", 3, 16, "For God so loved the world..."), makeEntry("psalm", 23, 1, "The Lord is my shepherd...")]
  const input = buildServiceSummaryInput(entries, "")
  assert.match(input, /john 3:16: "For God so loved the world\.\.\."/)
  assert.match(input, /psalm 23:1: "The Lord is my shepherd\.\.\."/)
})

test("buildServiceSummaryInput: includes the sermon notes text when present", () => {
  const input = buildServiceSummaryInput([], "- Grace and forgiveness\n- Living by faith")
  assert.match(input, /Grace and forgiveness/)
  assert.match(input, /Living by faith/)
})

test("buildServiceSummaryInput: says nothing was shown/noted when both are empty, rather than an empty section", () => {
  const input = buildServiceSummaryInput([], "")
  assert.match(input, /No verses were shown during this service\./)
  assert.match(input, /No sermon notes were generated during this service\./)
})

test("buildYouTubeDescription: builds structured timestamped text", () => {
  const entries = [
    makeEntry("john", 3, 16, "For God so loved the world...", 0),
    makeEntry("romans", 8, 28, "All things work together for good...", 125000),
  ]
  const desc = buildYouTubeDescription(entries, "Sunday Morning")
  assert.match(desc, /00:00 - Service Start/)
  assert.match(desc, /02:05 - Scripture: Romans 8:28/)
})

test("generatePreachingAnalytics: calculates OT vs NT distribution and top books", () => {
  const entries = [
    makeEntry("genesis", 1, 1, "In the beginning..."),
    makeEntry("psalm", 23, 1, "The Lord is my shepherd..."),
    makeEntry("john", 3, 16, "For God so loved the world..."),
    makeEntry("john", 14, 6, "I am the way..."),
  ]
  const analytics = generatePreachingAnalytics(entries)
  assert.equal(analytics.totalVerses, 4)
  assert.equal(analytics.uniqueBooksCount, 3)
  assert.equal(analytics.oldTestamentCount, 2)
  assert.equal(analytics.newTestamentCount, 2)
  assert.equal(analytics.topBooks[0]?.book, "john")
  assert.equal(analytics.topBooks[0]?.count, 2)
})

test("generateSocialQuoteCardSvg: produces clean SVG graphic", () => {
  const svg = generateSocialQuoteCardSvg("For God so loved the world", "John 3:16", "Grace Church")
  assert.ok(svg.startsWith("<svg"))
  assert.ok(svg.includes("For God so loved the world"))
  assert.ok(svg.includes("John 3:16"))
  assert.ok(svg.includes("Grace Church"))
})
