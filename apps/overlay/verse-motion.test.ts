import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

/**
 * ARCHITECTURE.md section 133: the pure half of the verse card choreography
 * (apps/overlay/public/verse-motion.js, a plain browser script that also
 * exports CommonJS). The CSS animations themselves are not unit-testable here
 * (TESTING.md: no real browser in `npm test`); these tests pin the numbers and
 * decisions that drive them.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..")

interface Plan {
  delays: number[]
  secondaryDelay: number
  refDelay: number
  settleMs: number
  dense: boolean
  wordDur: number
  refDur: number
}
interface FitLimits {
  maxWidthFraction: number
  maxHeightFraction: number
  maxFontPx: number
  minFontPx: number
}
interface VerseMotionApi {
  TRANSITIONS: string[]
  LATE_JOIN_WINDOW_MS: number
  DENSE_WORDS: number
  splitRevealUnits(text: unknown): string[]
  splitDropCap(word: unknown): { cap: string; rest: string } | null
  groupLines(tops: number[], tolerance?: number): number[]
  revealPlan(lines: number[], card: string, options?: { swap?: boolean }): Plan
  swapOutMs(card: string): number
  pickVerseTransition(input: { wasVisible?: boolean; msSinceConnect?: number; reducedMotion?: boolean; motion?: string }): string
  fitLimits(isFullscreen: boolean, card: string): FitLimits
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const M = require(join(REPO_ROOT, "apps", "overlay", "public", "verse-motion.js")) as VerseMotionApi

const NBSP = " "
const DESIGNS = ["classic", "banner", "minimal", "elegant", "glass", "ribbon", "cinema", "manuscript", "stained", "poster", "split", "bold"]

test("splitRevealUnits: words in order, joining them gives back the text with collapsed spacing", () => {
  const text = "Car Dieu a tant aimé le monde\nqu'il a donné  son Fils unique"
  const units = M.splitRevealUnits(text)
  assert.equal(units.join(" "), text.replace(/\s+/g, " "))
  assert.equal(units[0], "Car")
  assert.equal(units.length, 13)
})

test("splitRevealUnits: lone French punctuation is glued to its word so a line never starts with it", () => {
  assert.deepEqual(M.splitRevealUnits("Jésus lui dit : Je suis le chemin !"), ["Jésus", "lui", `dit${NBSP}:`, "Je", "suis", "le", `chemin${NBSP}!`])
  assert.deepEqual(M.splitRevealUnits("« Que la lumière soit » ."), [`«${NBSP}Que`, "la", "lumière", `soit${NBSP}»${NBSP}.`])
})

test("splitRevealUnits: existing no-break spaces are never split points", () => {
  assert.deepEqual(M.splitRevealUnits(`dit${NBSP}: Je`), [`dit${NBSP}:`, "Je"])
  assert.deepEqual(M.splitRevealUnits("a ; b"), ["a ;", "b"])
})

test("splitRevealUnits: degenerate input never throws", () => {
  assert.deepEqual(M.splitRevealUnits(""), [])
  assert.deepEqual(M.splitRevealUnits("   "), [])
  assert.deepEqual(M.splitRevealUnits(undefined), [])
  assert.deepEqual(M.splitRevealUnits(":"), [":"])
  assert.deepEqual(M.splitRevealUnits("« "), ["«"])
})

test("splitDropCap: first letter (with any opening quote) becomes the initial", () => {
  assert.deepEqual(M.splitDropCap("Car"), { cap: "C", rest: "ar" })
  assert.deepEqual(M.splitDropCap("Éternel"), { cap: "É", rest: "ternel" })
  assert.deepEqual(M.splitDropCap(`«${NBSP}Que`), { cap: `«${NBSP}Q`, rest: "ue" })
  assert.deepEqual(M.splitDropCap("A"), { cap: "A", rest: "" })
  assert.equal(M.splitDropCap("...") , null)
  assert.equal(M.splitDropCap(""), null)
})

test("groupLines: a new line starts when the top moves down past the tolerance", () => {
  assert.deepEqual(M.groupLines([10, 10, 11, 52, 52, 94]), [0, 0, 0, 1, 1, 2])
  assert.deepEqual(M.groupLines([]), [])
  // A drop cap shifts nothing: sub-pixel jitter on one line stays one line.
  assert.deepEqual(M.groupLines([0, 1.5, 2.9, 0.4]), [0, 0, 0, 0])
})

test("revealPlan: words start in reading order, line by line, inside the design's spread cap", () => {
  const lines = [0, 0, 0, 1, 1, 2]
  const plan = M.revealPlan(lines, "classic")
  for (let i = 1; i < plan.delays.length; i++) assert.ok((plan.delays[i] ?? 0) >= (plan.delays[i - 1] ?? 0), "delays never go backwards")
  const p = M.revealPlan(Array.from({ length: 40 }, (_, i) => Math.floor(i / 8)), "classic")
  const spread = Math.max(...p.delays) - Math.min(...p.delays)
  assert.ok(spread <= 300, `classic spread ${spread} must stay within its 300 ms cap`)
  assert.ok(p.refDelay > Math.max(...p.delays), "the reference follows the text")
})

test("revealPlan: every design settles within ~1.3 s even for a long verse, and never before its own layers end", () => {
  const longLines = Array.from({ length: 55 }, (_, i) => Math.floor(i / 9))
  for (const card of DESIGNS) {
    const plan = M.revealPlan(longLines, card)
    assert.ok(plan.settleMs <= 1300, `${card} settles at ${plan.settleMs} ms`)
    assert.ok(plan.settleMs >= 1000, `${card} must not cut its card-level layers short`)
    const lastWordEnd = Math.max(...plan.delays) + plan.wordDur
    assert.ok(plan.settleMs >= lastWordEnd, `${card}: settle must come after the last word lands`)
    assert.ok(plan.settleMs >= plan.refDelay + plan.refDur, `${card}: settle must come after the reference lands`)
  }
})

test("revealPlan: a verse-to-verse swap starts its words sooner than a full entrance", () => {
  for (const card of DESIGNS) {
    const enter = M.revealPlan([0, 0, 1], card)
    const swap = M.revealPlan([0, 0, 1], card, { swap: true })
    assert.ok((swap.delays[0] ?? 0) < (enter.delays[0] ?? 0), card)
  }
})

test("revealPlan: dense verses drop the in-line ripple (only per-line steps remain)", () => {
  const lines = Array.from({ length: M.DENSE_WORDS + 1 }, (_, i) => Math.floor(i / 12))
  const plan = M.revealPlan(lines, "classic")
  assert.equal(plan.dense, true)
  assert.equal(plan.delays[0], plan.delays[11], "all words of one line start together")
  assert.equal(M.revealPlan([0, 0], "classic").dense, false)
})

test("revealPlan: unknown design falls back to the shared profile; empty input is safe", () => {
  assert.deepEqual(M.revealPlan([0, 1], "nope"), M.revealPlan([0, 1], "classic"))
  const empty = M.revealPlan([], "cinema")
  assert.deepEqual(empty.delays, [])
  assert.ok(empty.settleMs > 0)
})

test("swapOutMs: the outgoing half is short (exit window 200-400 ms) for every design", () => {
  for (const card of DESIGNS) {
    const ms = M.swapOutMs(card)
    assert.ok(ms >= 200 && ms <= 400, `${card}: ${ms}`)
  }
})

test("pickVerseTransition: first show, replacement, late join, gentle, reduced motion and cut", () => {
  const far = 60_000
  assert.equal(M.pickVerseTransition({ wasVisible: false, msSinceConnect: far }), "enter")
  assert.equal(M.pickVerseTransition({ wasVisible: true, msSinceConnect: far }), "swap")
  // Connect-time resync of an already-showing verse: no long intro.
  assert.equal(M.pickVerseTransition({ wasVisible: false, msSinceConnect: 120 }), "resync")
  assert.equal(M.pickVerseTransition({ wasVisible: false, msSinceConnect: M.LATE_JOIN_WINDOW_MS }), "enter")
  assert.equal(M.pickVerseTransition({ wasVisible: false, msSinceConnect: far, motion: "gentle" }), "fade")
  assert.equal(M.pickVerseTransition({ wasVisible: true, msSinceConnect: far, motion: "gentle" }), "fade-swap")
  assert.equal(M.pickVerseTransition({ wasVisible: false, msSinceConnect: far, reducedMotion: true }), "fade")
  assert.equal(M.pickVerseTransition({ wasVisible: true, msSinceConnect: far, reducedMotion: true }), "fade-swap")
  assert.equal(M.pickVerseTransition({ wasVisible: true, msSinceConnect: far, motion: "cut" }), "cut")
  assert.equal(M.pickVerseTransition({ wasVisible: false, msSinceConnect: 10, motion: "cut" }), "cut")
  // Unknown or missing style is treated as the default.
  assert.equal(M.pickVerseTransition({ wasVisible: true, msSinceConnect: far, motion: "<script>" }), "swap")
  assert.equal(M.pickVerseTransition({ wasVisible: false, msSinceConnect: -Infinity }), "enter")
})

test("fitLimits: lower-third and fullscreen keep their historical caps; designs adjust only what they need", () => {
  assert.deepEqual(M.fitLimits(false, "classic"), { maxWidthFraction: 0.9, maxHeightFraction: 0.84, maxFontPx: 44, minFontPx: 14 })
  assert.deepEqual(M.fitLimits(true, "classic"), { maxWidthFraction: 0.9, maxHeightFraction: 0.9, maxFontPx: 120, minFontPx: 18 })
  for (const card of ["banner", "minimal", "elegant", "glass", "ribbon"]) {
    assert.deepEqual(M.fitLimits(false, card), M.fitLimits(false, "classic"), card)
    assert.deepEqual(M.fitLimits(true, card), M.fitLimits(true, "classic"), card)
  }
  // Cinema: the card must stay clear of both letterbox bars (10vh each).
  assert.ok(M.fitLimits(true, "cinema").maxHeightFraction <= 0.8 - 0.05)
  assert.ok(M.fitLimits(false, "cinema").maxHeightFraction + 0.1 <= 0.9 - 0.1)
  for (const card of DESIGNS) {
    for (const fs of [false, true]) {
      const l = M.fitLimits(fs, card)
      assert.ok(l.minFontPx >= 14 && l.minFontPx < l.maxFontPx, `${card} legibility floor`)
      assert.ok(l.maxHeightFraction > 0.5 && l.maxHeightFraction <= 0.9, `${card} height`)
      assert.ok(l.maxWidthFraction > 0.5 && l.maxWidthFraction <= 1, `${card} width`)
    }
  }
})
