import { test } from "node:test"
import assert from "node:assert/strict"
import { InterpreterEchoGuard, guessSpokenLanguage } from "./interpreter-echo-guard"

const JOHN_3_16 = { book: "John", chapter: 3, verse: 16 }

function guardWithClock(start = 1_000_000) {
  let now = start
  const guard = new InterpreterEchoGuard({ now: () => now })
  return { guard, advance: (ms: number) => { now += ms } }
}

test("guessSpokenLanguage: tells English from French and treats ties as unknown", () => {
  assert.equal(guessSpokenLanguage("Let us read John chapter 3 verse 16"), "en")
  assert.equal(guessSpokenLanguage("Lisons Jean chapitre 3 verset 16"), "fr")
  assert.equal(guessSpokenLanguage("3:16"), "unknown")
})

test("guessSpokenLanguage: bare book names are enough to tell the language", () => {
  assert.equal(guessSpokenLanguage("John 3:16"), "en")
  assert.equal(guessSpokenLanguage("Jean 3:16"), "fr")
})

test("guessSpokenLanguage: words shared by both languages ('on', 'a') never tip a French sentence to English", () => {
  assert.notEqual(guessSpokenLanguage("Jean 3:16 on a lu"), "en")
  assert.equal(guessSpokenLanguage("on a lu"), "unknown")
})

test("guessSpokenLanguage: a narrow, one-vote lead is unknown, not a language", () => {
  assert.equal(guessSpokenLanguage("the 3:16"), "unknown")
})

test("echo guard: the interpreter's French repeat of an English verse is suppressed", () => {
  const { guard, advance } = guardWithClock()
  assert.deepEqual(guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16"), { suppress: false })
  advance(12_000)
  const decision = guard.check(JOHN_3_16, "Allons à Jean chapitre 3 verset 16")
  assert.equal(decision.suppress, true)
  assert.equal(decision.suppress && decision.reason, "interpreter-echo")
  assert.equal(decision.suppress && decision.ageMs, 12_000)
})

test("echo guard: a French-only service never loses a second reading to a misread language", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Lisons Jean chapitre 3 verset 16")
  advance(20_000)
  assert.deepEqual(guard.check(JOHN_3_16, "Jean 3:16 on a lu"), { suppress: false })
})

test("echo guard: the same verse in the same language after the repeat window is shown again", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(20_000)
  assert.deepEqual(guard.check(JOHN_3_16, "Again, John chapter 3 verse 16"), { suppress: false })
})

test("echo guard: an immediate same-language repeat (overlapping chunks) is dropped", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(3_000)
  const decision = guard.check(JOHN_3_16, "John chapter 3 verse 16")
  assert.equal(decision.suppress && decision.reason, "repeat")
})

test("echo guard: a French repeat after the echo window is shown (the preacher may have returned to it)", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(31_000)
  assert.deepEqual(guard.check(JOHN_3_16, "Jean chapitre 3 verset 16"), { suppress: false })
})

test("echo guard: a different verse is never suppressed", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(5_000)
  assert.deepEqual(guard.check({ book: "John", chapter: 3, verse: 17 }, "Jean chapitre 3 verset 17"), { suppress: false })
})

test("echo guard: an unknown language is never treated as an echo (ambiguity shows the verse)", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "3:16")
  advance(12_000)
  assert.deepEqual(guard.check(JOHN_3_16, "Jean chapitre 3 verset 16"), { suppress: false })
})

test("echo guard: forget() (operator took control) makes the next detection show", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(10_000)
  guard.forget()
  assert.deepEqual(guard.check(JOHN_3_16, "Jean chapitre 3 verset 16"), { suppress: false })
})

test("echo guard: learns a slow interpreter and widens the window, within bounds", () => {
  const { guard, advance } = guardWithClock()
  assert.equal(guard.currentEchoWindowMs(), 30_000)
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(20_000)
  guard.check(JOHN_3_16, "Jean chapitre 3 verset 16")
  assert.equal(guard.currentEchoWindowMs(), 40_000)

  const fast = guardWithClock()
  fast.guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  fast.advance(4_000)
  fast.guard.check(JOHN_3_16, "Jean chapitre 3 verset 16")
  assert.equal(fast.guard.currentEchoWindowMs(), 15_000, "never narrower than the floor")
})

test("echo guard: a long gap is a deliberate return, not an interpreter delay, and is not learned", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(25_000)
  guard.check(JOHN_3_16, "Jean chapitre 3 verset 16") // suppressed (inside 30 s), lag 25 s -> window 45 s (cap)
  assert.equal(guard.currentEchoWindowMs(), 45_000)
  const other = guardWithClock()
  other.guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  other.advance(30_001)
  // outside the 30 s initial window: shown, nothing learned
  assert.deepEqual(other.guard.check(JOHN_3_16, "Jean chapitre 3 verset 16"), { suppress: false })
  assert.equal(other.guard.currentEchoWindowMs(), 30_000)
})

test("echo guard: a suppressed echo does not refresh the original record", () => {
  const { guard, advance } = guardWithClock()
  guard.check(JOHN_3_16, "Turn to John chapter 3 verse 16")
  advance(15_000)
  guard.check(JOHN_3_16, "Jean chapitre 3 verset 16") // echo, suppressed; window is now 30 s
  advance(25_000) // 40 s after the original, 25 s after the echo
  assert.deepEqual(guard.check(JOHN_3_16, "Jean chapitre 3 verset 16"), { suppress: false })
})
