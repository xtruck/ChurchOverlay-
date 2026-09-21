import { test } from "node:test"
import assert from "node:assert/strict"
import { DeepgramProvider } from "./deepgram-provider"

test("DeepgramProvider: requires an API key", () => {
  assert.throws(() => new DeepgramProvider({ apiKey: "" }))
})

test("DeepgramProvider: forwards final streaming results with confidence", () => {
  const provider = new DeepgramProvider({ apiKey: "test" })
  const results: unknown[] = []
  provider.onTranscript((result) => results.push(result))
  ;(provider as unknown as { handleMessage(raw: string): void }).handleMessage(
    JSON.stringify({
      is_final: true,
      channel: { alternatives: [{ transcript: "John 3:16", confidence: 0.97 }] },
    })
  )
  assert.equal(results.length, 1)
  assert.deepEqual(results[0], {
    id: (results[0] as { id: string }).id,
    correlationId: "",
    sequence: 1,
    text: "John 3:16",
    state: "final",
    providerConfidence: 0.97,
    timestamp: (results[0] as { timestamp: number }).timestamp,
  })
})
