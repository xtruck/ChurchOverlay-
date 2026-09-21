import { test } from "node:test"
import assert from "node:assert/strict"
import { wordErrorRate } from "./wer"

test("WER: identical transcripts have zero error", () => {
  assert.deepEqual(wordErrorRate("Jean 3:16", "Jean 3:16"), {
    substitutions: 0, deletions: 0, insertions: 0, referenceWords: 2, wer: 0,
  })
})

test("WER: reports deterministic normalized distance", () => {
  const result = wordErrorRate("Jean chapitre trois", "Jean chapitre")
  assert.equal(result.referenceWords, 3)
  assert.equal(result.wer, 1 / 3)
  assert.equal(result.deletions, 1)
})
