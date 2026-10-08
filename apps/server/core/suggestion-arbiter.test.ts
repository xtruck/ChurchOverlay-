import { test } from "node:test"
import assert from "node:assert/strict"
import { SuggestionArbiter, suggestionKey } from "./suggestion-arbiter"

const JOHN_3_16 = { book: "john", chapter: 3, verse: 16 }
const ROMANS_8_28 = { book: "romans", chapter: 8, verse: 28 }

function arbiterWithClock(options: { maxEntries?: number } = {}, start = 1_000_000) {
  let now = start
  const arbiter = new SuggestionArbiter({ now: () => now, ...options })
  return { arbiter, advance: (ms: number) => { now += ms } }
}

test("suggestionKey: book chapter:verse", () => {
  assert.equal(suggestionKey(JOHN_3_16), "john 3:16")
})

test("a verse that was never offered can be offered", () => {
  const { arbiter } = arbiterWithClock()
  assert.equal(arbiter.canOffer(JOHN_3_16, null), true)
})

test("canOffer alone does not start the cooldown: only markOffered does (a failed lookup must not hide the verse)", () => {
  const { arbiter } = arbiterWithClock()
  assert.equal(arbiter.canOffer(JOHN_3_16, null), true)
  assert.equal(arbiter.canOffer(JOHN_3_16, null), true)
  arbiter.markOffered(JOHN_3_16)
  assert.equal(arbiter.canOffer(JOHN_3_16, null), false)
})

test("the cooldown is 60 s and applies per verse", () => {
  const { arbiter, advance } = arbiterWithClock()
  arbiter.markOffered(JOHN_3_16)
  advance(59_999)
  assert.equal(arbiter.canOffer(JOHN_3_16, null), false)
  assert.equal(arbiter.canOffer(ROMANS_8_28, null), true)
  advance(1)
  assert.equal(arbiter.canOffer(JOHN_3_16, null), true)
})

test("a verse already on screen is never offered", () => {
  const { arbiter } = arbiterWithClock()
  assert.equal(arbiter.canOffer(JOHN_3_16, JOHN_3_16), false)
  assert.equal(arbiter.canOffer(JOHN_3_16, ROMANS_8_28), true)
})

test("the cooldown map is pruned above its bound, keeping only unexpired entries", () => {
  const { arbiter, advance } = arbiterWithClock({ maxEntries: 3 })
  for (let verse = 1; verse <= 4; verse++) arbiter.markOffered({ book: "john", chapter: 1, verse })
  assert.equal(arbiter.size, 4)
  advance(60_000)
  arbiter.markOffered({ book: "john", chapter: 1, verse: 5 })
  assert.equal(arbiter.size, 1)
})

test("unexpired entries survive pruning, so the map can briefly exceed its bound but never loses a live cooldown", () => {
  const { arbiter } = arbiterWithClock({ maxEntries: 2 })
  for (let verse = 1; verse <= 5; verse++) arbiter.markOffered({ book: "john", chapter: 1, verse })
  assert.equal(arbiter.size, 5)
  assert.equal(arbiter.canOffer({ book: "john", chapter: 1, verse: 1 }, null), false)
})

test("a detected verse waiting holds AI suggestions for 20 s, then releases them", () => {
  const { arbiter, advance } = arbiterWithClock()
  assert.equal(arbiter.aiMayReplacePending(), true)
  arbiter.noteDetectedWaiting()
  assert.equal(arbiter.aiMayReplacePending(), false)
  advance(20_000)
  assert.equal(arbiter.aiMayReplacePending(), false)
  advance(1)
  assert.equal(arbiter.aiMayReplacePending(), true)
})

test("clearDetectedWaiting releases the hold at once", () => {
  const { arbiter } = arbiterWithClock()
  arbiter.noteDetectedWaiting()
  arbiter.clearDetectedWaiting()
  assert.equal(arbiter.aiMayReplacePending(), true)
})
