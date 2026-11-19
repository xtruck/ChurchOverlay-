import { test } from "node:test"
import assert from "node:assert/strict"
import type { TextCompleter } from "./claude-client"
import { AiCircuitOpenError, GuardedTextCompleter } from "./guarded-text-completer"
import type { CircuitState } from "../verse/circuit-breaker"

const request = { system: "s", user: "u" }

class FakeTextCompleter implements TextCompleter {
  calls = 0
  constructor(public behaviour: () => string) {}
  async complete(): Promise<string> {
    this.calls += 1
    return this.behaviour()
  }
}

const failing = (): string => {
  throw new Error("Groq text request failed (404)")
}

test("GuardedTextCompleter: passes answers through while healthy", async () => {
  const inner = new FakeTextCompleter(() => "ok")
  const guarded = new GuardedTextCompleter(inner)
  assert.equal(await guarded.complete(request), "ok")
  assert.equal(guarded.getState(), "closed")
})

test("GuardedTextCompleter: after the threshold it refuses locally and stops hitting the service", async () => {
  const inner = new FakeTextCompleter(failing)
  const states: Array<[CircuitState, string | undefined]> = []
  const guarded = new GuardedTextCompleter(inner, { failureThreshold: 3, onStateChange: (s, e) => states.push([s, e]) })

  for (let i = 0; i < 3; i++) await assert.rejects(guarded.complete(request), /404/)
  assert.equal(guarded.getState(), "open")
  assert.deepEqual(states, [["open", "Groq text request failed (404)"]])

  // 10 more transcripts' worth of calls: all refused, none reach the service.
  for (let i = 0; i < 10; i++) await assert.rejects(guarded.complete(request), AiCircuitOpenError)
  assert.equal(inner.calls, 3)
})

test("GuardedTextCompleter: after the cooldown one probe goes through; success closes the circuit", async () => {
  let now = 0
  const inner = new FakeTextCompleter(failing)
  const states: CircuitState[] = []
  const guarded = new GuardedTextCompleter(inner, {
    failureThreshold: 2,
    cooldownMs: 1000,
    now: () => now,
    onStateChange: (s) => states.push(s),
  })
  await assert.rejects(guarded.complete(request), /404/)
  await assert.rejects(guarded.complete(request), /404/)
  assert.equal(guarded.getState(), "open")

  now = 1000
  inner.behaviour = () => "recovered"
  assert.equal(await guarded.complete(request), "recovered")
  assert.equal(guarded.getState(), "closed")
  assert.deepEqual(states, ["open", "half-open", "closed"])
})

test("GuardedTextCompleter: a failed probe reopens the circuit and restarts the cooldown", async () => {
  let now = 0
  const inner = new FakeTextCompleter(failing)
  const guarded = new GuardedTextCompleter(inner, { failureThreshold: 1, cooldownMs: 1000, now: () => now })
  await assert.rejects(guarded.complete(request), /404/)
  now = 1000
  await assert.rejects(guarded.complete(request), /404/) // the probe
  assert.equal(guarded.getState(), "open")
  now = 1500
  await assert.rejects(guarded.complete(request), AiCircuitOpenError) // still cooling down
  assert.equal(inner.calls, 2)
})

test("GuardedTextCompleter: status is ok -> paused (with a FIXED reason code, never the error text) -> ok again", async () => {
  let now = 0
  const inner = new FakeTextCompleter(failing)
  const guarded = new GuardedTextCompleter(inner, { failureThreshold: 2, cooldownMs: 1000, now: () => now })
  const seen: Array<{ state: string; reason?: string }> = []
  guarded.subscribeStatus((status) => seen.push(status))
  assert.deepEqual(guarded.currentStatus(), { state: "ok" })

  await assert.rejects(guarded.complete(request), /404/)
  await assert.rejects(guarded.complete(request), /404/)
  assert.deepEqual(guarded.currentStatus(), { state: "paused", reason: "model-unavailable" })
  assert.equal(JSON.stringify(seen).includes("Groq text request failed"), false, "raw error text must not be in the status")

  now = 1000
  inner.behaviour = () => "back"
  await guarded.complete(request)
  assert.deepEqual(seen, [{ state: "paused", reason: "model-unavailable" }, { state: "ok" }])
})

test("GuardedTextCompleter: 401/403 maps to the 'auth' reason, anything else to 'repeated-failures'", async () => {
  const auth = new GuardedTextCompleter(new FakeTextCompleter(() => { throw new Error("Groq text request failed (401)") }), { failureThreshold: 1 })
  await assert.rejects(auth.complete(request))
  assert.deepEqual(auth.currentStatus(), { state: "paused", reason: "auth" })
  const other = new GuardedTextCompleter(new FakeTextCompleter(() => { throw new Error("socket hang up") }), { failureThreshold: 1 })
  await assert.rejects(other.complete(request))
  assert.deepEqual(other.currentStatus(), { state: "paused", reason: "repeated-failures" })
})

test("GuardedTextCompleter.checkAvailability: a definitive 'model-unavailable' opens the circuit before any real call; 'unknown' changes nothing", async () => {
  const inner = Object.assign(new FakeTextCompleter(() => "ok"), { checkAvailability: async () => "model-unavailable" as const })
  const guarded = new GuardedTextCompleter(inner, { failureThreshold: 3 })
  const seen: string[] = []
  guarded.subscribeStatus((status) => seen.push(`${status.state}:${status.reason}`))
  assert.equal(await guarded.checkAvailability(), "model-unavailable")
  assert.deepEqual(guarded.currentStatus(), { state: "unavailable", reason: "model-unavailable" })
  await assert.rejects(guarded.complete(request), AiCircuitOpenError)
  assert.equal(inner.calls, 0, "no completion was spent")
  assert.deepEqual(seen, ["unavailable:model-unavailable"])

  const flaky = Object.assign(new FakeTextCompleter(() => "ok"), { checkAvailability: async () => "unknown" as const })
  const calm = new GuardedTextCompleter(flaky)
  assert.equal(await calm.checkAvailability(), "unknown")
  assert.deepEqual(calm.currentStatus(), { state: "ok" })
  assert.equal(await calm.complete(request), "ok")
})

test("GuardedTextCompleter.checkAvailability: a completer without a check reports 'unknown'", async () => {
  assert.equal(await new GuardedTextCompleter(new FakeTextCompleter(() => "ok")).checkAvailability(), "unknown")
})

test("GuardedTextCompleter: 429 and 529 (overloaded) map to 'rate-limited', not to a bad key", async () => {
  for (const status of [429, 529]) {
    const guarded = new GuardedTextCompleter(new FakeTextCompleter(() => { throw new Error(`Claude request failed (${status})`) }), { failureThreshold: 1 })
    await assert.rejects(guarded.complete(request))
    assert.deepEqual(guarded.currentStatus(), { state: "paused", reason: "rate-limited" })
  }
})

test("GuardedTextCompleter.testConnection: success closes a paused circuit and clears 'unavailable'", async () => {
  const inner = Object.assign(new FakeTextCompleter(() => "OK"), { checkAvailability: async () => "auth" as const })
  const guarded = new GuardedTextCompleter(inner, { failureThreshold: 2 })
  await guarded.checkAvailability()
  assert.equal(guarded.currentStatus().state, "unavailable")
  assert.deepEqual(await guarded.testConnection(), { ok: true })
  assert.deepEqual(guarded.currentStatus(), { state: "ok" })
  assert.equal(await guarded.complete(request), "OK")
})

test("GuardedTextCompleter.testConnection: failures come back as fixed codes, never provider text", async () => {
  const cases: Array<[string, string]> = [
    ["Claude request failed (401)", "auth"],
    ["Claude request failed (404)", "model-unavailable"],
    ["Claude request failed (429)", "rate-limited"],
    ["Claude request failed (529)", "rate-limited"],
    ["Claude request timed out", "timeout"],
    ["Groq text request returned no answer (token limit reached)", "empty"],
    ["fetch failed", "network"],
    ["Claude request failed (500)", "repeated-failures"],
  ]
  for (const [message, expected] of cases) {
    const guarded = new GuardedTextCompleter(new FakeTextCompleter(() => { throw new Error(`${message} sk-ant-secret0123456789`) }))
    const result = await guarded.testConnection()
    assert.deepEqual(result, { ok: false, reason: expected }, message)
  }
})

test("GuardedTextCompleter.testConnection: an empty answer is not 'working'; a bad key marks the helpers unavailable", async () => {
  assert.deepEqual(await new GuardedTextCompleter(new FakeTextCompleter(() => "  ")).testConnection(), { ok: false, reason: "empty" })
  const guarded = new GuardedTextCompleter(new FakeTextCompleter(() => { throw new Error("Claude request failed (401)") }))
  const seen: string[] = []
  guarded.subscribeStatus((status) => seen.push(`${status.state}:${status.reason}`))
  await guarded.testConnection()
  assert.deepEqual(guarded.currentStatus(), { state: "unavailable", reason: "auth" })
  assert.deepEqual(seen, ["unavailable:auth"])
})

test("GuardedTextCompleter.testConnection: one tiny request, no transcript text", async () => {
  const requests: Array<{ system: string; user: string; maxTokens?: number }> = []
  const guarded = new GuardedTextCompleter({ complete: async (r) => { requests.push(r); return "OK" } })
  await guarded.testConnection()
  assert.equal(requests.length, 1)
  assert.ok((requests[0]?.maxTokens ?? 999) <= 16)
  assert.equal(requests[0]?.user, "ping")
})
