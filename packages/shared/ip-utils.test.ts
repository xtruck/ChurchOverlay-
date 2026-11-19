import { test } from "node:test"
import assert from "node:assert/strict"
import { isLoopbackAddress, normalizeRemoteAddress } from "./ip-utils"

test("normalizeRemoteAddress: IPv4-mapped IPv6 is unwrapped so one client buckets under one key", () => {
  assert.equal(normalizeRemoteAddress("::ffff:192.168.1.20"), "192.168.1.20")
  assert.equal(normalizeRemoteAddress("::FFFF:192.168.1.20"), "192.168.1.20")
  assert.equal(normalizeRemoteAddress("192.168.1.20"), "192.168.1.20")
  assert.equal(normalizeRemoteAddress("2001:db8::1"), "2001:db8::1")
})

test("normalizeRemoteAddress: missing or blank addresses never produce an empty key", () => {
  assert.equal(normalizeRemoteAddress(undefined), "unknown")
  assert.equal(normalizeRemoteAddress(""), "unknown")
  assert.equal(normalizeRemoteAddress("  "), "unknown")
})

test("isLoopbackAddress: loopback in every spelling, LAN addresses never", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true)
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true)
  assert.equal(isLoopbackAddress("::1"), true)
  assert.equal(isLoopbackAddress("localhost"), true)
  assert.equal(isLoopbackAddress("192.168.1.20"), false)
  assert.equal(isLoopbackAddress("::ffff:192.168.1.20"), false)
  assert.equal(isLoopbackAddress("10.0.0.5"), false)
  assert.equal(isLoopbackAddress(undefined), false)
})
