import { test } from "node:test"
import assert from "node:assert/strict"
import { NavigationCommandDetector } from "./navigation-command-detector"

test("NavigationCommandDetector: 'next verse' as a substring triggers next-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Let's look at the next verse now."), [{ kind: "next-verse" }])
})

test("NavigationCommandDetector: 'previous verse' and 'go back' both trigger previous-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Go to the previous verse."), [{ kind: "previous-verse" }])
  assert.deepEqual(detector.detect("Let's go back for a moment."), [{ kind: "previous-verse" }])
})

test("NavigationCommandDetector: 'next chapter' / 'previous chapter' trigger chapter navigation", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to the next chapter."), [{ kind: "next-chapter" }])
  assert.deepEqual(detector.detect("Back to the previous chapter please."), [{ kind: "previous-chapter" }])
})

test("NavigationCommandDetector: 'clear the screen' triggers cancel as a substring", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Let's clear the screen for a moment."), [{ kind: "cancel" }])
})

test("NavigationCommandDetector: short synonyms ('next', 'previous', 'cancel', 'clear') only trigger as the WHOLE utterance", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Next"), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("  next  "), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("Previous"), [{ kind: "previous-verse" }])
  assert.deepEqual(detector.detect("Cancel"), [{ kind: "cancel" }])
  assert.deepEqual(detector.detect("Clear"), [{ kind: "cancel" }])
})

test("NavigationCommandDetector: short synonyms embedded in a longer sentence do NOT trigger", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("The next thing I want to say is important."), [])
  assert.deepEqual(detector.detect("I previously mentioned this."), [])
  assert.deepEqual(detector.detect("Please cancel your plans for tonight."), [])
  assert.deepEqual(detector.detect("The sky is clear today."), [])
})

test("NavigationCommandDetector: 'goto-chapter' parses 'Book chapter N' correctly", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Let's go to Romans chapter 8 now."), [
    { kind: "goto-chapter", book: "romans", chapter: 8 },
  ])
})

test("NavigationCommandDetector: 'goto-chapter' handles a numeral-prefixed book name", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to 1 Corinthians chapter 13."), [
    { kind: "goto-chapter", book: "1 corinthians", chapter: 13 },
  ])
})

test("NavigationCommandDetector: 'goto-chapter' does NOT fire on RegexDetector's own territory ('Book Chapter:Verse')", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to Romans 8:28 tonight."), [])
})

test("NavigationCommandDetector: returns no commands for an empty or unrelated transcript", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect(""), [])
  assert.deepEqual(detector.detect("Welcome everyone, let's begin worship."), [])
})

test("NavigationCommandDetector: a transcript can trigger multiple distinct commands at once", () => {
  const detector = new NavigationCommandDetector()
  const result = detector.detect("Let's go to Romans chapter 8, then show the next verse.")
  assert.deepEqual(result, [{ kind: "next-verse" }, { kind: "goto-chapter", book: "romans", chapter: 8 }])
})
