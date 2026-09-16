import { test } from "node:test"
import assert from "node:assert/strict"
import { generateUlid, isValidUlid } from "./ulid"

test("generateUlid: produces a 26-character string in Crockford's base32 alphabet", () => {
  const ulid = generateUlid()
  assert.equal(ulid.length, 26)
  assert.match(ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/)
})

test("isValidUlid: accepts a freshly generated ULID", () => {
  assert.equal(isValidUlid(generateUlid()), true)
})

test("isValidUlid: rejects the wrong length", () => {
  assert.equal(isValidUlid("01ABC"), false)
  assert.equal(isValidUlid(generateUlid() + "X"), false)
})

test("isValidUlid: rejects lowercase and the excluded letters I, L, O, U", () => {
  const validButLowercase = generateUlid().toLowerCase()
  assert.equal(isValidUlid(validButLowercase), false)
  assert.equal(isValidUlid("0123456789ILOUABCDEFGHJK"), false)
})

test("generateUlid: the time component encodes a known value exactly (32 -> '10' in base32)", () => {
  const ulid = generateUlid(32)
  assert.equal(ulid.slice(0, 10), "0000000010")
})

test("generateUlid: timestamp 0 encodes as all zeros in the time component", () => {
  const ulid = generateUlid(0)
  assert.equal(ulid.slice(0, 10), "0000000000")
})

test("generateUlid: throws on a negative or non-integer timestamp", () => {
  assert.throws(() => generateUlid(-1))
  assert.throws(() => generateUlid(1.5))
})

test("generateUlid: is lexicographically sortable by creation time", () => {
  const earlier = generateUlid(1_700_000_000_000)
  const later = generateUlid(1_700_000_000_001)
  assert.ok(earlier < later, `expected "${earlier}" < "${later}"`)
})

test("generateUlid: the same timestamp produces the same time component but a different random component", () => {
  const a = generateUlid(1_700_000_000_000)
  const b = generateUlid(1_700_000_000_000)
  assert.equal(a.slice(0, 10), b.slice(0, 10))
  assert.notEqual(a.slice(10), b.slice(10))
})

test("generateUlid: many generations at the same instant do not collide", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    seen.add(generateUlid(1_700_000_000_000))
  }
  assert.equal(seen.size, 1000)
})
