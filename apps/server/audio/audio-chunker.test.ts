import { test } from "node:test"
import assert from "node:assert/strict"
import { AudioChunker } from "./audio-chunker"
import type { AudioFrame } from "../../../packages/contracts"

function frame(sequence: number, samples = 1600): AudioFrame {
  return { samples: new Int16Array(samples), sampleRate: 16000, sequence }
}

test("AudioChunker: keeps duration bounded and drops oldest complete frames", () => {
  const chunker = new AudioChunker({ maxDurationMs: 200, maxFrames: 10 })
  chunker.push(frame(1))
  chunker.push(frame(2))
  chunker.push(frame(3))
  assert.equal(chunker.bufferedDurationMs, 200)
  assert.deepEqual(chunker.drain().map((item) => item.sequence), [2, 3])
  assert.equal(chunker.size, 0)
})

test("AudioChunker: also enforces a frame-count cap", () => {
  const chunker = new AudioChunker({ maxDurationMs: 10000, maxFrames: 2 })
  chunker.push(frame(1, 100))
  chunker.push(frame(2, 100))
  chunker.push(frame(3, 100))
  assert.deepEqual(chunker.drain().map((item) => item.sequence), [2, 3])
})
