import { test } from "node:test"
import assert from "node:assert/strict"
import { LruTtlCache } from "./lru-ttl-cache"

test("LruTtlCache: get/set roundtrip", () => {
  const cache = new LruTtlCache<string>(10)
  cache.set("a", "value-a", 1000)
  assert.equal(cache.get("a"), "value-a")
})

test("LruTtlCache: get on a missing key returns undefined", () => {
  const cache = new LruTtlCache<string>(10)
  assert.equal(cache.get("missing"), undefined)
})

test("LruTtlCache: an entry expires after its TTL elapses", () => {
  let now = 0
  const cache = new LruTtlCache<string>(10, () => now)
  cache.set("a", "value-a", 1000)
  now = 999
  assert.equal(cache.get("a"), "value-a")
  now = 1000
  assert.equal(cache.get("a"), undefined)
})

test("LruTtlCache: evicts the least-recently-used entry once over capacity", () => {
  const cache = new LruTtlCache<string>(2)
  cache.set("a", "1", 10_000)
  cache.set("b", "2", 10_000)
  cache.set("c", "3", 10_000) // over capacity -> evicts "a" (oldest, never re-touched)
  assert.equal(cache.get("a"), undefined)
  assert.equal(cache.get("b"), "2")
  assert.equal(cache.get("c"), "3")
})

test("LruTtlCache: get()'ing an entry protects it from eviction (marks it recently used)", () => {
  const cache = new LruTtlCache<string>(2)
  cache.set("a", "1", 10_000)
  cache.set("b", "2", 10_000)
  cache.get("a") // "a" is now more recently used than "b"
  cache.set("c", "3", 10_000) // over capacity -> evicts "b", not "a"
  assert.equal(cache.get("a"), "1")
  assert.equal(cache.get("b"), undefined)
  assert.equal(cache.get("c"), "3")
})

test("LruTtlCache: delete() removes a single key without affecting others", () => {
  const cache = new LruTtlCache<string>(10)
  cache.set("a", "1", 10_000)
  cache.set("b", "2", 10_000)
  cache.delete("a")
  assert.equal(cache.get("a"), undefined)
  assert.equal(cache.get("b"), "2")
})

test("LruTtlCache: clear() empties the cache", () => {
  const cache = new LruTtlCache<string>(10)
  cache.set("a", "1", 10_000)
  cache.set("b", "2", 10_000)
  cache.clear()
  assert.equal(cache.size(), 0)
  assert.equal(cache.get("a"), undefined)
})

test("LruTtlCache: size() reflects the current entry count, including after eviction/expiry", () => {
  let now = 0
  const cache = new LruTtlCache<string>(2, () => now)
  cache.set("a", "1", 1000)
  cache.set("b", "2", 1000)
  assert.equal(cache.size(), 2)
  cache.set("c", "3", 1000) // evicts "a"
  assert.equal(cache.size(), 2)
})

test("LruTtlCache: rejects a non-positive or non-integer maxEntries (must be bounded)", () => {
  assert.throws(() => new LruTtlCache<string>(0))
  assert.throws(() => new LruTtlCache<string>(-1))
  assert.throws(() => new LruTtlCache<string>(1.5))
})

// ARCHITECTURE.md production audit (section 74): getRemainingTtlMs()
// backs resolve-verse.ts's negative-cache-suppression diagnostic log.
test("LruTtlCache: getRemainingTtlMs() reports time left using the cache's own injected clock", () => {
  let now = 0
  const cache = new LruTtlCache<string>(10, () => now)
  cache.set("a", "value-a", 1000)
  assert.equal(cache.getRemainingTtlMs("a"), 1000)
  now = 400
  assert.equal(cache.getRemainingTtlMs("a"), 600)
})

test("LruTtlCache: getRemainingTtlMs() returns undefined for a missing or already-expired key", () => {
  let now = 0
  const cache = new LruTtlCache<string>(10, () => now)
  assert.equal(cache.getRemainingTtlMs("missing"), undefined)
  cache.set("a", "value-a", 1000)
  now = 1000
  assert.equal(cache.getRemainingTtlMs("a"), undefined)
})

test("LruTtlCache: getRemainingTtlMs() does not affect LRU recency ordering (a read-only diagnostic)", () => {
  const cache = new LruTtlCache<string>(2)
  cache.set("a", "1", 10_000)
  cache.set("b", "2", 10_000)
  cache.getRemainingTtlMs("a") // must NOT count as touching "a"
  cache.set("c", "3", 10_000) // over capacity -> still evicts "a" (the true least-recently-used)
  assert.equal(cache.get("a"), undefined)
  assert.equal(cache.get("b"), "2")
})
