import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import express from "express"
import {
  createApiRateLimiter,
  installApiGuard,
  isLoopbackHost,
  resolveWebHost,
  validateConfiguredTokens,
  MIN_CONFIGURED_TOKEN_LENGTH,
} from "./api-auth"

const OPERATOR_TOKEN = "operator-secret-token-0123456789"

/** Real Express + HTTP on an ephemeral loopback port — the guard's whole job is Express middleware ordering. */
async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  installApiGuard(app, OPERATOR_TOKEN, "1kb")
  app.get("/api/status", (_req, res) => res.json({ token: OPERATOR_TOKEN }))
  app.post("/api/echo", (req, res) => res.json({ body: req.body }))
  app.get("/public/page", (_req, res) => res.send("static"))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("installApiGuard: an /api request with no credentials is rejected and never reaches the route (no token leak)", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/status`)
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("www-authenticate"), "Bearer")
    const text = await res.text()
    assert.ok(!text.includes(OPERATOR_TOKEN))
  })
})

test("installApiGuard: a wrong token is rejected", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/status`, { headers: { Authorization: "Bearer not-the-token" } })
    assert.equal(res.status, 401)
  })
})

test("installApiGuard: the operator token in an Authorization header is accepted", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } })
    assert.equal(res.status, 200)
  })
})

test("installApiGuard: the scheme is case-insensitive, but a token-only header without the Bearer scheme is rejected", async () => {
  await withApp(async (base) => {
    const lower = await fetch(`${base}/api/status`, { headers: { Authorization: `bearer ${OPERATOR_TOKEN}` } })
    assert.equal(lower.status, 200)
    const bare = await fetch(`${base}/api/status`, { headers: { Authorization: OPERATOR_TOKEN } })
    assert.equal(bare.status, 401)
  })
})

test("installApiGuard: the token is not accepted from the URL (AGENTS.md section 18)", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/status?token=${OPERATOR_TOKEN}`)
    assert.equal(res.status, 401)
  })
})

test("installApiGuard: a mutating request without a token is rejected, not parsed — even a body over the JSON limit gets 401, not 413", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(10_000) }),
    })
    assert.equal(res.status, 401)
  })
})

test("installApiGuard: with the token, JSON bodies are parsed and the size limit still applies", async () => {
  await withApp(async (base) => {
    const auth = { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" }
    const ok = await fetch(`${base}/api/echo`, { method: "POST", headers: auth, body: JSON.stringify({ a: 1 }) })
    assert.deepEqual(await ok.json(), { body: { a: 1 } })
    const tooBig = await fetch(`${base}/api/echo`, { method: "POST", headers: auth, body: JSON.stringify({ filler: "x".repeat(10_000) }) })
    assert.equal(tooBig.status, 413)
  })
})

test("installApiGuard: routes outside /api are unaffected", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/public/page`)
    assert.equal(res.status, 200)
  })
})

test("resolveWebHost: defaults to loopback, and only an explicit value opens it to the network", () => {
  assert.equal(resolveWebHost(undefined), "127.0.0.1")
  assert.equal(resolveWebHost(""), "127.0.0.1")
  assert.equal(resolveWebHost("   "), "127.0.0.1")
  assert.equal(resolveWebHost("0.0.0.0"), "0.0.0.0")
  assert.equal(resolveWebHost(" 192.168.1.20 "), "192.168.1.20")
})

test("isLoopbackHost: recognizes only loopback addresses", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true)
  assert.equal(isLoopbackHost("localhost"), true)
  assert.equal(isLoopbackHost("::1"), true)
  assert.equal(isLoopbackHost("0.0.0.0"), false)
  assert.equal(isLoopbackHost("192.168.1.20"), false)
})

test("validateConfiguredTokens: unset tokens are fine (random ones are generated)", () => {
  assert.equal(validateConfiguredTokens(undefined, undefined), null)
  assert.equal(validateConfiguredTokens("", ""), null)
})

test("validateConfiguredTokens: two distinct long tokens are accepted", () => {
  assert.equal(validateConfiguredTokens("a".repeat(MIN_CONFIGURED_TOKEN_LENGTH), "b".repeat(MIN_CONFIGURED_TOKEN_LENGTH)), null)
})

test("validateConfiguredTokens: a short token is rejected, naming the variable", () => {
  assert.match(validateConfiguredTokens("church123", undefined) ?? "", /OPERATOR_TOKEN must be at least/)
  assert.match(validateConfiguredTokens(undefined, "short") ?? "", /VIEWER_TOKEN must be at least/)
})

test("validateConfiguredTokens: identical operator and viewer tokens are rejected (viewer pages would get operator rights)", () => {
  const same = "x".repeat(32)
  assert.match(validateConfiguredTokens(same, same) ?? "", /must differ/)
})

// S-03: the /api rate limiter. Loopback (the server's own machine) is
// exempt — these middleware unit tests fake a NON-loopback socket address
// so the sliding-window logic is exercised deterministically, then a real
// loopback server proves the exemption end to end.
type FakeReq = { socket: { remoteAddress: string | undefined } }
type FakeRes = {
  statusCode: number
  headers: Record<string, string>
  body: unknown
  setHeader(name: string, value: string): void
  status(code: number): FakeRes
  json(payload: unknown): void
}

function fakePair(address: string | undefined): { req: FakeReq; res: FakeRes; nexted: string[] } {
  const nexted: string[] = []
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      res.headers[name] = value
    },
    status(code) {
      res.statusCode = code
      return res
    },
    json(payload) {
      res.body = payload
    },
  }
  return { req: { socket: { remoteAddress: address } }, res, nexted }
}

test("createApiRateLimiter: requests up to the limit pass, the next one gets 429 + Retry-After", () => {
  const limiter = createApiRateLimiter({ maxRequestsPerWindow: 3 })
  let passed = 0
  for (let i = 0; i < 3; i++) {
    const { req, res } = fakePair("203.0.113.10")
    limiter(req as never, res as never, () => passed++)
  }
  assert.equal(passed, 3)
  const { req, res } = fakePair("203.0.113.10")
  limiter(req as never, res as never, () => assert.fail("must not pass the limit"))
  assert.equal(res.statusCode, 429)
  assert.ok(Number(res.headers["Retry-After"]) > 0)
  assert.deepEqual(res.body, { error: "Too many requests" })
})

test("createApiRateLimiter: the window slides — after it elapses the address is allowed again", () => {
  const limiter = createApiRateLimiter({ maxRequestsPerWindow: 1, windowMs: 50 })
  const first = fakePair("198.51.100.7")
  limiter(first.req as never, first.res as never, () => undefined)
  const second = fakePair("198.51.100.7")
  limiter(second.req as never, second.res as never, () => assert.fail("must be limited"))
  assert.equal(second.res.statusCode, 429)
  // The sliding window uses Date.now(); a 50 ms window is deterministic
  // enough for a single retry boundary check with a small sleep.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const third = fakePair("198.51.100.7")
      limiter(third.req as never, third.res as never, () => undefined)
      assert.equal(third.res.statusCode, 0, "the window must have slid open again")
      resolve()
    }, 60)
  })
})

test("createApiRateLimiter: loopback is exempt and IPv4-mapped IPv6 flooders share one bucket", () => {
  const limiter = createApiRateLimiter({ maxRequestsPerWindow: 1 })
  for (let i = 0; i < 20; i++) {
    const loop = fakePair("127.0.0.1")
    limiter(loop.req as never, loop.res as never, () => undefined)
    assert.equal(loop.res.statusCode, 0)
  }
  const first = fakePair("203.0.113.10")
  limiter(first.req as never, first.res as never, () => undefined)
  const mapped = fakePair("::ffff:203.0.113.10")
  limiter(mapped.req as never, mapped.res as never, () => assert.fail("mapped IPv6 must share the IPv4 bucket"))
  assert.equal(mapped.res.statusCode, 429)
})

test("createApiRateLimiter: maxRequestsPerWindow 0 disables it, distinct addresses are independent", () => {
  const disabled = createApiRateLimiter({ maxRequestsPerWindow: 0 })
  let passed = 0
  for (let i = 0; i < 30; i++) {
    const { req, res } = fakePair("203.0.113.10")
    disabled(req as never, res as never, () => passed++)
  }
  assert.equal(passed, 30)

  const limiter = createApiRateLimiter({ maxRequestsPerWindow: 1 })
  const a = fakePair("203.0.113.10")
  limiter(a.req as never, a.res as never, () => undefined)
  const b = fakePair("203.0.113.11")
  limiter(b.req as never, b.res as never, () => undefined)
  assert.equal(b.res.statusCode, 0, "another client must not be limited by the first one")
})

test("installApiGuard: loopback /api callers are never rate limited (the app's own dashboard traffic)", async () => {
  const app = express()
  installApiGuard(app, OPERATOR_TOKEN, "1kb", { maxRequestsPerWindow: 1 })
  app.get("/api/status", (_req, res) => res.json({ ok: true }))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } })
      assert.equal(res.status, 200, `loopback request ${i} must not be limited`)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
