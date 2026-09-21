import { test } from "node:test"
import assert from "node:assert/strict"
import { postprocessTranscript } from "./pipeline"
import { normalizeTranscript } from "./normalize"
import { normalizePunctuation } from "./punctuation"

test("postprocess: removes control characters and collapses whitespace", () => {
  assert.equal(normalizeTranscript("  Jean\u00003:16 \n  "), "Jean 3:16")
})

test("postprocess: normalizes punctuation spacing without changing words", () => {
  assert.equal(normalizePunctuation("Jean 3 : 16 , Amen!"), "Jean 3: 16, Amen!")
})

test("postprocess: normalizes known Bible terms conservatively", () => {
  assert.equal(postprocessTranscript("jesus et saint esprit"), "Jésus et Saint-Esprit")
})
