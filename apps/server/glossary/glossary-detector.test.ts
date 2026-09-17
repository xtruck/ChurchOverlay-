import { test } from "node:test"
import assert from "node:assert/strict"
import { GlossaryDetector } from "./glossary-detector"

test("GlossaryDetector: 'define grace' returns the matching English definition", () => {
  const detector = new GlossaryDetector()
  const result = detector.detect("Can you define grace for us?")
  assert.deepEqual(result, {
    term: "Grace",
    definition: "Unmerited favor from God — a gift given freely, not earned by good works.",
  })
})

test("GlossaryDetector: 'what does X mean' also triggers, for a different term", () => {
  const detector = new GlossaryDetector()
  const result = detector.detect("What does salvation mean, exactly?")
  assert.equal(result?.term, "Salvation")
})

test("GlossaryDetector: French phrases, with or without an accent, trigger the French definition", () => {
  const detector = new GlossaryDetector()
  assert.equal(detector.detect("Pouvez-vous définir la grâce ? Non, definis la grace.")?.term, "Grâce")
  assert.equal(detector.detect("Que veut dire le péché ?")?.term, "Péché")
})

test("GlossaryDetector: a term not in the glossary returns null", () => {
  const detector = new GlossaryDetector()
  assert.equal(detector.detect("Define supercalifragilisticexpialidocious."), null)
})

test("GlossaryDetector: an unrelated transcript returns null", () => {
  const detector = new GlossaryDetector()
  assert.equal(detector.detect("Welcome everyone, let's begin worship."), null)
  assert.equal(detector.detect(""), null)
})

test("GlossaryDetector: only the first matching definition is returned when multiple trigger phrases appear", () => {
  const detector = new GlossaryDetector()
  const result = detector.detect("Please define grace, and also define sin.")
  assert.equal(result?.term, "Grace")
})
