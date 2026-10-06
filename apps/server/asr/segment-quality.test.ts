import { test } from "node:test"
import assert from "node:assert/strict"
import { filterSegments, parseScoredSegments } from "./segment-quality"

test("filterSegments: drops a segment that is both likely non-speech and low-confidence", () => {
  const { kept, dropped } = filterSegments([
    { text: " Jean chapitre 3 verset 16", noSpeechProb: 0.05, avgLogprob: -0.3 },
    { text: " Merci d'avoir regardé", noSpeechProb: 0.92, avgLogprob: -1.4 },
  ])
  assert.deepEqual(kept.map((s) => s.text), [" Jean chapitre 3 verset 16"])
  assert.equal(dropped[0]?.reason, "no-speech")
  assert.equal(dropped[0]?.words, 3)
})

test("filterSegments: high no_speech_prob alone, or low avg_logprob alone, is kept (conservative)", () => {
  const { kept } = filterSegments([
    { text: "a", noSpeechProb: 0.95, avgLogprob: -0.4 },
    { text: "b", noSpeechProb: 0.1, avgLogprob: -1.8 },
  ])
  assert.equal(kept.length, 2)
})

test("filterSegments: an extreme compression ratio (a looping repetition) is dropped on its own", () => {
  const { kept, dropped } = filterSegments([{ text: "amen amen amen amen amen amen", compressionRatio: 4.2 }])
  assert.equal(kept.length, 0)
  assert.equal(dropped[0]?.reason, "compression-ratio")
})

test("filterSegments: segments without score fields are always kept (whisper.cpp has no compression_ratio)", () => {
  const { kept, dropped } = filterSegments([{ text: "x" }, { text: "y", noSpeechProb: 0.99 }])
  assert.equal(kept.length, 2)
  assert.equal(dropped.length, 0)
})

test("parseScoredSegments: the filter is disabled (null) for any response it cannot read, never an error", () => {
  assert.equal(parseScoredSegments({ text: "plain json" }), null)
  assert.equal(parseScoredSegments({ text: "x", segments: [] }), null)
  assert.equal(parseScoredSegments({ text: "x", segments: "nope" }), null)
  assert.equal(parseScoredSegments({ text: "x", segments: [{ no_speech_prob: 0.9 }] }), null, "a segment without text")
  assert.equal(parseScoredSegments(null), null)
  assert.equal(parseScoredSegments("text"), null)
})

test("parseScoredSegments: reads whisper.cpp and sidecar field names; non-finite scores are ignored", () => {
  const parsed = parseScoredSegments({
    text: "x",
    segments: [{ text: "a", avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.3, tokens: [1, 2] }, { text: "b", avg_logprob: "bad", no_speech_prob: null }],
  })
  assert.deepEqual(parsed, [
    { text: "a", avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.3 },
    { text: "b", avgLogprob: undefined, noSpeechProb: undefined, compressionRatio: undefined },
  ])
})
