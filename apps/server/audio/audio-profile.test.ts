import { test } from "node:test"
import assert from "node:assert/strict"
import { getAudioProfileSettings } from "./audio-profile"

test("audio profiles: balanced remains the safe default", () => {
  assert.deepEqual(getAudioProfileSettings(undefined), { chunkDurationMs: 2000, silenceThreshold: 150 })
})

test("audio profiles: responsive lowers latency and robust increases context", () => {
  assert.ok(getAudioProfileSettings("responsive").chunkDurationMs < getAudioProfileSettings("robust").chunkDurationMs)
  assert.ok(getAudioProfileSettings("responsive").silenceThreshold < getAudioProfileSettings("robust").silenceThreshold)
})
