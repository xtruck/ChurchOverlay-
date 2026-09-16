import { test } from "node:test"
import assert from "node:assert/strict"
import { CircuitBreaker } from "./circuit-breaker"

test("CircuitBreaker: starts closed and allows calls", () => {
  const breaker = new CircuitBreaker()
  assert.equal(breaker.getState(), "closed")
  assert.equal(breaker.canProceed(), true)
})

test("CircuitBreaker: opens after reaching the consecutive-failure threshold", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 })
  breaker.recordFailure()
  breaker.recordFailure()
  assert.equal(breaker.getState(), "closed")
  breaker.recordFailure()
  assert.equal(breaker.getState(), "open")
  assert.equal(breaker.canProceed(), false)
})

test("CircuitBreaker: a success before the threshold resets the failure streak", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 })
  breaker.recordFailure()
  breaker.recordFailure()
  breaker.recordSuccess()
  breaker.recordFailure()
  breaker.recordFailure()
  // Two failures again, but the streak was reset — should still be closed.
  assert.equal(breaker.getState(), "closed")
})

test("CircuitBreaker: stays open until the cooldown elapses", () => {
  let now = 0
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now })
  breaker.recordFailure()
  assert.equal(breaker.getState(), "open")

  now = 999
  assert.equal(breaker.canProceed(), false)
  assert.equal(breaker.getState(), "open")

  now = 1000
  assert.equal(breaker.canProceed(), true)
  assert.equal(breaker.getState(), "half-open")
})

test("CircuitBreaker: only one probe is allowed in flight while half-open", () => {
  let now = 0
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now })
  breaker.recordFailure()
  now = 1000
  assert.equal(breaker.canProceed(), true) // the one probe
  assert.equal(breaker.canProceed(), false) // a second concurrent attempt is refused
})

test("CircuitBreaker: a successful probe closes the circuit and resets the failure count", () => {
  let now = 0
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now })
  breaker.recordFailure()
  breaker.recordFailure()
  assert.equal(breaker.getState(), "open")

  now = 1000
  assert.equal(breaker.canProceed(), true) // probe allowed
  breaker.recordSuccess()
  assert.equal(breaker.getState(), "closed")

  // A single failure right after should not reopen it — the streak was reset.
  breaker.recordFailure()
  assert.equal(breaker.getState(), "closed")
})

test("CircuitBreaker: a failed probe reopens the circuit and restarts the cooldown", () => {
  let now = 0
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now })
  breaker.recordFailure()
  now = 1000
  assert.equal(breaker.canProceed(), true) // probe allowed
  breaker.recordFailure() // probe fails
  assert.equal(breaker.getState(), "open")

  // Cooldown restarted at now=1000, so it should still be closed-for-calls at 1500.
  now = 1500
  assert.equal(breaker.canProceed(), false)

  now = 2000
  assert.equal(breaker.canProceed(), true)
})

test("CircuitBreaker: rejects an invalid failureThreshold or cooldownMs", () => {
  assert.throws(() => new CircuitBreaker({ failureThreshold: 0 }))
  assert.throws(() => new CircuitBreaker({ failureThreshold: 1.5 }))
  assert.throws(() => new CircuitBreaker({ cooldownMs: -1 }))
})
