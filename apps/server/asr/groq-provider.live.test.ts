import { test } from "node:test"
import assert from "node:assert/strict"
import { GroqProvider } from "./groq-provider"
import type { AudioFrame } from "../../../packages/contracts"

/**
 * Live integration test against the real Groq API (AGENTS.md section 33:
 * "Use real external services only in dedicated integration tests. Tests
 * must not depend on unstable third-party availability.") — deliberately
 * NOT part of the default `npm test` run, and skips itself cleanly when
 * no API key is configured, so no other machine's test run can fail on a
 * missing secret.
 *
 * Run explicitly with: npm run test:live-groq
 * (requires a .env file at the repo root with GROQ_API_KEY=...)
 */
const apiKey = process.env.GROQ_API_KEY
const skipReason = apiKey ? false : "GROQ_API_KEY is not set — see the comment above to run this test"

function toneFrame(): AudioFrame {
  // One second of a pure 440Hz tone at 16kHz. Real speech isn't required
  // to verify the request/response mechanics (auth, multipart upload,
  // response parsing) — this is not a transcription-accuracy test.
  const sampleRate = 16000
  const samples = new Int16Array(sampleRate)
  for (let i = 0; i < sampleRate; i++) {
    samples[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate))
  }
  return { samples, sampleRate: 16000, sequence: 0 }
}

test(
  "GroqProvider (live): a real request to the Groq API succeeds and returns a final transcript",
  { skip: skipReason },
  async () => {
    const provider = new GroqProvider({ apiKey: apiKey as string, chunkDurationMs: 500 })
    const results: unknown[] = []
    const errors: Error[] = []
    provider.onTranscript((r) => results.push(r))
    provider.onError((e) => errors.push(e))

    await provider.start()
    await provider.sendAudio(toneFrame())
    await provider.stop()

    assert.deepEqual(errors, [])
    assert.equal(results.length, 1)
    const result = results[0] as { state: string; text: string }
    assert.equal(result.state, "final")
    assert.equal(typeof result.text, "string")
  }
)

test(
  "GroqProvider (live): an invalid API key reports a real 'invalid_api_key' error via onError",
  { skip: skipReason },
  async () => {
    const provider = new GroqProvider({ apiKey: "gsk_invalid_key_for_testing", chunkDurationMs: 500 })
    const errors: Error[] = []
    provider.onTranscript(() => {
      throw new Error("should not emit a transcript with an invalid key")
    })
    provider.onError((e) => errors.push(e))

    await provider.start()
    await provider.sendAudio(toneFrame())

    assert.equal(errors.length, 1)
    assert.match(errors[0]?.message ?? "", /api key/i)
  }
)
