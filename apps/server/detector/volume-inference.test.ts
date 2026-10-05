import { test } from "node:test"
import assert from "node:assert/strict"
import { applyVolumeHints, buildVolumeHints, volumeOfBookId } from "./volume-inference"
import { RegexDetector } from "./regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"

const detector = new RegexDetector()
const index = new KnownValidVerseIndex()
const detect = (text: string) =>
  detector.detect(text).filter((r) => index.exists(r)).map((r) => `${r.book} ${r.chapter}:${r.verse}`)

test("volumeOfBookId: only volume-only families", () => {
  assert.deepEqual(volumeOfBookId("1 corinthians"), { family: "corinthians", volume: "1" })
  assert.deepEqual(volumeOfBookId("2 kings"), { family: "kings", volume: "2" })
  assert.equal(volumeOfBookId("1 john"), null, "a bare Jean is the Gospel, so John takes no part")
  assert.equal(volumeOfBookId("john"), null)
})

test("buildVolumeHints: the book on screen wins, a planned family with two volumes is ambiguous", () => {
  assert.equal(buildVolumeHints(["1 corinthians"], null).get("corinthians"), "1")
  assert.equal(buildVolumeHints(["1 corinthians", "2 corinthians"], null).has("corinthians"), false)
  assert.equal(buildVolumeHints(["1 corinthians"], "2 corinthians").get("corinthians"), "2")
  assert.equal(buildVolumeHints([], "john").size, 0)
})

test("applyVolumeHints: a bare book gets the hinted volume and then detects", () => {
  const hints = buildVolumeHints([], "2 corinthians")
  const text = applyVolumeHints("Corinthiens 5 verset 17", hints)
  assert.equal(text, "2 Corinthiens 5 verset 17")
  assert.deepEqual(detect(text as string), ["2 corinthians 5:17"])
})

test("applyVolumeHints: live mishearing and accents, whitespace and punctuation preserved", () => {
  const hints = buildVolumeHints(["1 timothy"], null)
  assert.equal(applyVolumeHints("Timothée,  4 verset 12", hints), "1 Timothée,  4 verset 12")
  assert.equal(applyVolumeHints("Corretien 5", buildVolumeHints([], "1 corinthians")), "1 Corretien 5")
})

test("applyVolumeHints: never overrides a volume the preacher already said", () => {
  const hints = buildVolumeHints([], "1 corinthians")
  assert.equal(applyVolumeHints("deux Corinthiens 5 verset 17", hints), null)
  assert.equal(applyVolumeHints("deuxième épître aux Corinthiens 5 verset 17", hints), null)
  assert.equal(applyVolumeHints("2 Corinthiens 5:17", hints), null)
  assert.equal(applyVolumeHints("1 Samuel 3", buildVolumeHints([], "2 samuel")), null)
})

test("applyVolumeHints: no hint, or another family, changes nothing", () => {
  assert.equal(applyVolumeHints("Corinthiens 5 verset 2", buildVolumeHints([], null)), null)
  assert.equal(applyVolumeHints("Samuel 3 verset 1", buildVolumeHints([], "1 corinthians")), null)
  assert.equal(applyVolumeHints("Jean 3 verset 16", buildVolumeHints([], "1 corinthians")), null)
})
