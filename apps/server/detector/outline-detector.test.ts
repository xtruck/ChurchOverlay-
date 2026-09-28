import { test } from "node:test"
import assert from "node:assert/strict"
import { OutlineDetector } from "./outline-detector"

const detector = new OutlineDetector()

test("OutlineDetector: recognizes French point phrasings", () => {
  const p1 = detector.detect("Et mon premier point: La persévérance dans la foi.")
  assert.ok(p1)
  assert.equal(p1.pointNumber, 1)
  assert.equal(p1.title, "Point 1")
  assert.equal(p1.text, "La persévérance dans la foi")

  const p2 = detector.detect("Deuxièmement, Dieu entend toujours nos prières.")
  assert.ok(p2)
  assert.equal(p2.pointNumber, 2)
  assert.equal(p2.title, "Point 2")
  assert.equal(p2.text, "Dieu entend toujours nos prières")

  const p3 = detector.detect("Passons au point numéro 3: Vivre dans l'amour fraternel.")
  assert.ok(p3)
  assert.equal(p3.pointNumber, 3)
  assert.equal(p3.title, "Point 3")
  assert.equal(p3.text, "Vivre dans l'amour fraternel")

  const concl = detector.detect("En conclusion: Jésus est le seul chemin.")
  assert.ok(concl)
  assert.equal(concl.pointNumber, 99)
  assert.equal(concl.title, "Conclusion")
  assert.equal(concl.text, "Jésus est le seul chemin")
})

test("OutlineDetector: recognizes English point phrasings", () => {
  const p1 = detector.detect("Here is our first point: Walking by faith and not by sight.")
  assert.ok(p1)
  assert.equal(p1.pointNumber, 1)
  assert.equal(p1.title, "Point 1")
  assert.equal(p1.text, "Walking by faith and not by sight")

  const p2 = detector.detect("Point number 2: The power of humble prayer.")
  assert.ok(p2)
  assert.equal(p2.pointNumber, 2)
  assert.equal(p2.title, "Point 2")

  const concl = detector.detect("In conclusion: God's grace is sufficient for you.")
  assert.ok(concl)
  assert.equal(concl.pointNumber, 99)
  assert.equal(concl.title, "Conclusion")
})

test("OutlineDetector: rejects plain non-outline sentences", () => {
  assert.equal(detector.detect(""), null)
  assert.equal(detector.detect("Hello brothers and sisters"), null)
  assert.equal(detector.detect("Turn with me to John 3:16"), null)
})
