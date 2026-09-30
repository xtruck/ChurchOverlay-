import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import express from "express"
import { installApiGuard, isLoopbackHost, resolveWebHost } from "./api-auth"

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
