import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MAX_KEYTERM_CHARS,
  MAX_KEYTERM_TOKENS,
  MAX_KEYTERMS,
  boundedKeyterms,
  estimateKeytermTokens,
  sameKeyterms,
  sanitizeKeyterm,
} from "./deepgram-keyterms"

test("sanitizeKeyterm: commas, semicolons and weight colons never reach Deepgram (they silently boost nothing)", () => {
  assert.equal(sanitizeKeyterm("Jean, John"), "Jean John")
  assert.equal(sanitizeKeyterm("Romains;"), "Romains")
  assert.equal(sanitizeKeyterm("Psaume:2"), "Psaume 2")
})

test("sanitizeKeyterm: trims, collapses whitespace, removes control characters and line breaks, NFC-normalizes", () => {
  assert.equal(sanitizeKeyterm("  1   Corinthiens \n"), "1 Corinthiens")
  assert.equal(sanitizeKeyterm("Hé\u0000breux"), "Hé breux")
  assert.equal(sanitizeKeyterm("Hébreux"), "Hébreux", "decomposed accent is composed")
  assert.equal(sanitizeKeyterm("Jean​"), "Jean", "zero-width format characters are removed")
})

test("sanitizeKeyterm: empty, separator-only and over-long terms are rejected whole, never truncated", () => {
  assert.equal(sanitizeKeyterm(""), null)
  assert.equal(sanitizeKeyterm(" , ; : "), null)
  assert.equal(sanitizeKeyterm("x".repeat(MAX_KEYTERM_CHARS)), "x".repeat(MAX_KEYTERM_CHARS))
  assert.equal(sanitizeKeyterm("x".repeat(MAX_KEYTERM_CHARS + 1)), null)
  assert.equal(sanitizeKeyterm(42 as unknown as string), null)
})

test("boundedKeyterms: dedupes case-insensitively keeping the first (most relevant) spelling and order", () => {
  assert.deepEqual(boundedKeyterms(["Jean", "Romains", "jean", "JEAN", "Romains ", "Psaume"]), ["Jean", "Romains", "Psaume"])
})

test("boundedKeyterms: caps the count, dropping the least relevant (last) terms", () => {
  const many = Array.from({ length: MAX_KEYTERMS + 20 }, (_, i) => `t${i}`)
  const kept = boundedKeyterms(many)
  assert.equal(kept.length, MAX_KEYTERMS)
  assert.equal(kept[0], "t0")
  assert.equal(kept.at(-1), `t${MAX_KEYTERMS - 1}`)
})

test("boundedKeyterms: the estimated token total stays under the budget (Deepgram's is 500 per list)", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Thessaloniciens${String(i).padStart(2, "0")}`)
  const kept = boundedKeyterms(long)
  const tokens = kept.reduce((sum, term) => sum + estimateKeytermTokens(term), 0)
  assert.ok(tokens <= MAX_KEYTERM_TOKENS, `${tokens} <= ${MAX_KEYTERM_TOKENS}`)
  assert.ok(MAX_KEYTERM_TOKENS < 500)
  assert.ok(kept.length < long.length, "something had to be dropped")
  assert.deepEqual(kept, long.slice(0, kept.length), "the most relevant are the ones kept")
})

test("boundedKeyterms is deterministic", () => {
  const input = ["Jean", "Marc, Luc", "x".repeat(99), "Actes"]
  assert.deepEqual(boundedKeyterms(input), boundedKeyterms(input))
  assert.deepEqual(boundedKeyterms(input), ["Jean", "Marc Luc", "Actes"])
})

test("sameKeyterms: compares the set (order carries no meaning for Deepgram)", () => {
  assert.equal(sameKeyterms(["a", "b"], ["b", "a"]), true)
  assert.equal(sameKeyterms(["a", "b"], ["a", "c"]), false)
  assert.equal(sameKeyterms(["a"], ["a", "b"]), false)
  assert.equal(sameKeyterms([], []), true)
})
