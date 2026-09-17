import { test } from "node:test"
import assert from "node:assert/strict"
import { decodeAudioFrame, encodeAudioFrame } from "./audio-frame-codec"
import type { AudioFrame } from "../contracts"

test("encodeAudioFrame/decodeAudioFrame: round-trips sequence and samples exactly", () => {
  const frame: AudioFrame = {
    samples: Int16Array.from([0, 1, -1, 32767, -32768, 12345, -12345]),
    sampleRate: 16000,
    sequence: 42,
  }
  const decoded = decodeAudioFrame(encodeAudioFrame(frame))
  assert.equal(decoded.sequence, 42)
  assert.equal(decoded.sampleRate, 16000)
  assert.deepEqual(Array.from(decoded.samples), Array.from(frame.samples))
})

test("encodeAudioFrame/decodeAudioFrame: round-trips a frame with zero samples (sequence-only)", () => {
  const frame: AudioFrame = { samples: new Int16Array(0), sampleRate: 16000, sequence: 7 }
  const decoded = decodeAudioFrame(encodeAudioFrame(frame))
  assert.equal(decoded.sequence, 7)
  assert.equal(decoded.samples.length, 0)
})

test("encodeAudioFrame: output length is exactly 4 + 2*sampleCount bytes", () => {
  const frame: AudioFrame = { samples: new Int16Array(160), sampleRate: 16000, sequence: 1 }
  assert.equal(encodeAudioFrame(frame).byteLength, 4 + 160 * 2)
})

test("decodeAudioFrame: throws on a buffer shorter than the sequence prefix", () => {
  assert.throws(() => decodeAudioFrame(new Uint8Array([1, 2, 3])))
})

test("decodeAudioFrame: throws when the sample payload length is odd (not a whole number of Int16 samples)", () => {
  assert.throws(() => decodeAudioFrame(new Uint8Array([0, 0, 0, 0, 1])))
})

test("decodeAudioFrame: a large sequence number round-trips correctly (uint32 range, not signed int32)", () => {
  const frame: AudioFrame = { samples: Int16Array.from([100]), sampleRate: 16000, sequence: 3_000_000_000 }
  const decoded = decodeAudioFrame(encodeAudioFrame(frame))
  assert.equal(decoded.sequence, 3_000_000_000)
})
