import { test } from "node:test"
import assert from "node:assert/strict"
import { HandshakeRateLimiter, offeredRole } from "./handshake-rate-limiter"

/** Fixed clock so sliding windows and bans are exact, never racy. */
const T0 = 1_700_000_000_000

test("HandshakeRateLimiter: attempts up to the limit are allowed, then refused with Retry-After", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 3, windowMs: 60_000, refusalThreshold: 50, banMs: 60_000 })
  assert.deepEqual(limiter.attempt("203.0.113.10", T0), { allowed: true })
  assert.deepEqual(limiter.attempt("203.0.113.10", T0 + 1), { allowed: true })
  assert.deepEqual(limiter.attempt("203.0.113.10", T0 + 2), { allowed: true })

  const refused = limiter.attempt("203.0.113.10", T0 + 3)
  assert.equal(refused.allowed, false)
  assert.ok(refused.allowed === false && refused.retryAfterSeconds > 0)
  assert.ok(refused.allowed === false && refused.reason.includes("handshake rate limit"))
})

test("HandshakeRateLimiter: the window slides — old attempts expire and the address is allowed again", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 2, windowMs: 60_000, refusalThreshold: 50 })
  assert.equal(limiter.attempt("203.0.113.10", T0).allowed, true)
  assert.equal(limiter.attempt("203.0.113.10", T0 + 1).allowed, true)
  assert.equal(limiter.attempt("203.0.113.10", T0 + 2).allowed, false)
  // 61 s later the first two attempts are outside the window: allowed again.
  assert.equal(limiter.attempt("203.0.113.10", T0 + 61_000).allowed, true)
})

test("HandshakeRateLimiter: repeated refusals ban the address, and the ban expires", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 1, windowMs: 60_000, refusalThreshold: 2, banMs: 30_000 })
  assert.equal(limiter.attempt("198.51.100.7", T0).allowed, true)
  // Two refusals in a row cross the threshold and ban until T0+30_002.
  assert.equal(limiter.attempt("198.51.100.7", T0 + 1).allowed, false)
  assert.equal(limiter.attempt("198.51.100.7", T0 + 2).allowed, false)
  // Still inside the ban (T0+5_000 < T0+30_002): refused even though the
  // attempt rate itself would be allowed again.
  assert.equal(limiter.attempt("198.51.100.7", T0 + 5_000).allowed, false)
  assert.equal(limiter.isBanned("198.51.100.7", T0 + 5_000), true)
  // The ban expired at T0+30_002 and the window slid open at T0+60_000:
  // the address is usable again at T0+91_000.
  assert.equal(limiter.attempt("198.51.100.7", T0 + 91_000).allowed, true)
  assert.equal(limiter.isBanned("198.51.100.7", T0 + 91_000), false)
})

test("HandshakeRateLimiter: addresses are independent — one flooder never limits another client", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 1, windowMs: 60_000, refusalThreshold: 50 })
  assert.equal(limiter.attempt("203.0.113.10", T0).allowed, true)
  assert.equal(limiter.attempt("203.0.113.10", T0).allowed, false)
  assert.equal(limiter.attempt("203.0.113.11", T0).allowed, true)
})

test("HandshakeRateLimiter: loopback is always exempt, IPv4-mapped IPv6 included", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 1, windowMs: 60_000, refusalThreshold: 1 })
  for (let i = 0; i < 25; i++) {
    assert.equal(limiter.attempt("127.0.0.1", T0 + i).allowed, true)
    assert.equal(limiter.attempt("::ffff:127.0.0.1", T0 + i).allowed, true)
    assert.equal(limiter.attempt("::1", T0 + i).allowed, true)
  }
})

test("HandshakeRateLimiter: IPv4-mapped IPv6 flooders bucket under the same key as their IPv4 self", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 1, windowMs: 60_000, refusalThreshold: 50 })
  assert.equal(limiter.attempt("203.0.113.10", T0).allowed, true)
  assert.equal(limiter.attempt("::ffff:203.0.113.10", T0).allowed, false)
})

test("HandshakeRateLimiter: the tracked-address map is bounded — spoofed addresses cannot grow memory", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 1, windowMs: 60_000, refusalThreshold: 1, maxTrackedAddresses: 16 })
  for (let i = 0; i < 100; i++) {
    limiter.attempt(`203.0.113.${i % 255}`, T0 + i)
  }
  // 100 distinct addresses went through a 16-slot map: it must stay at the cap.
  const internalStates = (limiter as unknown as { states: Map<string, unknown> }).states
  assert.equal(internalStates.size <= 16, true, "the states map must never exceed its cap")
})

test("HandshakeRateLimiter: maxAttemptsPerMinute 0 disables the limiter entirely", () => {
  const limiter = new HandshakeRateLimiter({ maxAttemptsPerMinute: 0 })
  for (let i = 0; i < 100; i++) {
    assert.equal(limiter.attempt("203.0.113.10", T0 + i).allowed, true)
  }
})

test("offeredRole: operator checked first, viewer second, unknown tokens return null", () => {
  const tokens = { operatorToken: "op-token", viewerToken: "view-token" }
  const equals = (a: string, b: string) => a === b
  assert.equal(offeredRole("op-token", tokens, equals), "operator")
  assert.equal(offeredRole("view-token", tokens, equals), "viewer")
  assert.equal(offeredRole("garbage, view-token", tokens, equals), "viewer")
  assert.equal(offeredRole("garbage", tokens, equals), null)
  assert.equal(offeredRole(undefined, tokens, equals), null)
  assert.equal(offeredRole("", tokens, equals), null)
})
