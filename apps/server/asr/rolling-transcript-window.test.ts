import { test } from "node:test"
import assert from "node:assert/strict"
import { RollingTranscriptWindow } from "./rolling-transcript-window"
import { QuoteMatcher } from "../detector/quote-matcher"

test("RollingTranscriptWindow: joins consecutive finals, oldest first", () => {
  const window = new RollingTranscriptWindow()
  assert.equal(window.push("car Dieu a tant aimé", 0), "car Dieu a tant aimé")
  assert.equal(window.push("le monde qu'il a donné", 1500), "car Dieu a tant aimé le monde qu'il a donné")
})

test("RollingTranscriptWindow: drops old speech and bounds the word count", () => {
  const window = new RollingTranscriptWindow({ maxAgeMs: 5000, maxWords: 6 })
  window.push("un deux trois", 0)
  assert.equal(window.push("quatre cinq six", 2000), "un deux trois quatre cinq six")
  assert.equal(window.push("sept huit", 3000), "trois quatre cinq six sept huit")
  assert.equal(window.push("neuf", 9000), "neuf", "everything older than maxAgeMs is gone")
})

test("RollingTranscriptWindow: a re-sent identical final is not doubled", () => {
  const window = new RollingTranscriptWindow()
  window.push("Ce n'est pas bon", 0)
  assert.equal(window.push("Ce n'est pas bon", 600), "Ce n'est pas bon")
})

// The point of the window: a verse read across a breath is invisible to the
// matcher one final at a time, and recognised once the window joins the halves.
test("RollingTranscriptWindow + QuoteMatcher: a verse read across two finals is recognised", () => {
  const matcher = new QuoteMatcher({
    jean: {
      "3": {
        "16": "Car Dieu a tant aimé le monde qu’il a donné son Fils unique, afin que quiconque croit en lui ne périsse point, mais qu’il ait la vie éternelle.",
      },
    },
  })
  const firstHalf = "car Dieu a tant aimé le monde qu'il a donné"
  const secondHalf = "son fils unique afin que quiconque croit en lui ne périsse point"
  assert.equal(matcher.match(firstHalf), null, "one final alone is too short to match")
  assert.equal(matcher.match(secondHalf), null)
  const window = new RollingTranscriptWindow()
  window.push(firstHalf, 0)
  const match = matcher.match(window.push(secondHalf, 1800))
  assert.deepEqual(match?.reference, { book: "john", chapter: 3, verse: 16 })
})
