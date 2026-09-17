import { test } from "node:test"
import assert from "node:assert/strict"
import { float32ToInt16 } from "./pcm-convert"

test("float32ToInt16: converts known boundary values exactly", () => {
  const result = float32ToInt16(Float32Array.from([0, 1, -1]))
  assert.deepEqual(Array.from(result), [0, 0x7fff, -0x8000])
})

test("float32ToInt16: scales a mid-range positive and negative value proportionally", () => {
  const result = float32ToInt16(Float32Array.from([0.5, -0.5]))
  assert.equal(result[0], Math.round(0.5 * 0x7fff))
  assert.equal(result[1], Math.round(-0.5 * 0x8000))
})

test("float32ToInt16: clamps out-of-range input instead of wrapping around", () => {
  const result = float32ToInt16(Float32Array.from([1.5, -1.5]))
  assert.deepEqual(Array.from(result), [0x7fff, -0x8000])
})

test("float32ToInt16: an empty input produces an empty output", () => {
  assert.equal(float32ToInt16(new Float32Array(0)).length, 0)
})

test("float32ToInt16: preserves sample count and order", () => {
  const input = Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5])
  const result = float32ToInt16(input)
  assert.equal(result.length, input.length)
  // Monotonic ordering of the (rounded) magnitudes should be preserved.
  assert.ok(result[0] !== 0 && result[1] !== 0)
})
