import { test } from "node:test"
import assert from "node:assert/strict"
import { EchoWatch, HOLD_MS, MEDIA_LOUD_MS, REPEAT_WINDOW_MS, normalizeSentence } from "./echo-warning"

const SENTENCE = "Car Dieu a tellement aimé le monde"

test("EchoWatch: speech at level while media plays warns only after MEDIA_LOUD_MS in a row", () => {
  const watch = new EchoWatch()
  watch.observeMic(0, true, true)
  watch.observeMic(MEDIA_LOUD_MS - 1, true, true)
  assert.equal(watch.current(MEDIA_LOUD_MS - 1), null)
  watch.observeMic(MEDIA_LOUD_MS, true, true)
  assert.deepEqual(watch.current(MEDIA_LOUD_MS), { reason: "media-loud", since: MEDIA_LOUD_MS })
})

test("EchoWatch: a quiet reading resets the streak, so a preacher pausing never accumulates", () => {
  const watch = new EchoWatch()
  watch.observeMic(0, true, true)
  watch.observeMic(3000, false, true)
  watch.observeMic(4000, true, true)
  watch.observeMic(4000 + MEDIA_LOUD_MS - 1, true, true)
  assert.equal(watch.current(4000 + MEDIA_LOUD_MS - 1), null)
})

test("EchoWatch: loud speech with no media playing never warns", () => {
  const watch = new EchoWatch()
  for (let t = 0; t <= 60_000; t += 1000) watch.observeMic(t, true, false)
  assert.equal(watch.current(60_000), null)
  assert.equal(watch.episodeCount(), 0)
})

test("EchoWatch: the same sentence twice within the window warns, even with different case and punctuation", () => {
  const watch = new EchoWatch()
  watch.observeFinalTranscript(1000, SENTENCE)
  watch.observeFinalTranscript(1000 + REPEAT_WINDOW_MS, "car dieu a tellement aime le monde.")
  assert.equal(watch.current(1000 + REPEAT_WINDOW_MS)?.reason, "repeated-sentence")
})

test("EchoWatch: the same sentence after the window, or a different sentence, does not warn", () => {
  const watch = new EchoWatch()
  watch.observeFinalTranscript(1000, SENTENCE)
  watch.observeFinalTranscript(1000 + REPEAT_WINDOW_MS + 1, SENTENCE)
  watch.observeFinalTranscript(1000 + REPEAT_WINDOW_MS + 2, "Car Dieu a tellement aimé les hommes")
  assert.equal(watch.current(1000 + REPEAT_WINDOW_MS + 2), null)
})

test("EchoWatch: short phrases such as 'amen' never count as an echo", () => {
  const watch = new EchoWatch()
  watch.observeFinalTranscript(0, "Amen")
  watch.observeFinalTranscript(500, "Amen")
  watch.observeFinalTranscript(900, "oui oui oui")
  watch.observeFinalTranscript(1200, "oui oui oui")
  assert.equal(watch.current(1200), null)
})

test("EchoWatch: a warning expires HOLD_MS after the last trigger and is renewed by a new one", () => {
  const watch = new EchoWatch()
  watch.observeFinalTranscript(0, SENTENCE)
  watch.observeFinalTranscript(100, SENTENCE)
  assert.ok(watch.current(100))
  assert.ok(watch.current(100 + HOLD_MS))
  assert.equal(watch.current(100 + HOLD_MS + 1), null)
  // a later repeat is a second, separate episode
  watch.observeFinalTranscript(30_000, SENTENCE)
  watch.observeFinalTranscript(30_100, SENTENCE)
  assert.equal(watch.current(30_100)?.since, 30_100)
  assert.equal(watch.episodeCount(), 2)
})

test("EchoWatch: reset clears the warning and the memory (mic stopped)", () => {
  const watch = new EchoWatch()
  watch.observeFinalTranscript(0, SENTENCE)
  watch.observeFinalTranscript(100, SENTENCE)
  watch.reset()
  assert.equal(watch.current(100), null)
  watch.observeFinalTranscript(200, SENTENCE)
  assert.equal(watch.current(200), null)
})

test("normalizeSentence: lowercases, strips accents and punctuation, collapses spaces", () => {
  assert.equal(normalizeSentence("  Qu'est-ce  que   l'ÉGLISE ? "), "qu est ce que l eglise")
})
