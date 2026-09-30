import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { isNotFoundError, isPlainObject } from "./type-guards"

test("isPlainObject: accepts objects and rejects null, arrays and primitives", () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject({ a: 1 }), true)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(undefined), false)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject("text"), false)
  assert.equal(isPlainObject(42), false)
  assert.equal(isPlainObject(true), false)
})

test("isNotFoundError: true only for an error carrying code ENOENT", () => {
  assert.equal(isNotFoundError(Object.assign(new Error("missing"), { code: "ENOENT" })), true)
  assert.equal(isNotFoundError({ code: "ENOENT" }), true)
  assert.equal(isNotFoundError(Object.assign(new Error("denied"), { code: "EACCES" })), false)
  assert.equal(isNotFoundError(new Error("no code")), false)
  assert.equal(isNotFoundError(null), false)
  assert.equal(isNotFoundError("ENOENT"), false)
})

test("isNotFoundError: recognises the error Node actually throws for a missing file", async () => {
  await assert.rejects(readFile("this-file-does-not-exist-anywhere.json"), (err) => isNotFoundError(err))
})
