import test from "node:test"
import assert from "node:assert/strict"
import { hasForeignScript } from "./script-guard"

test("French and English text is kept", () => {
  assert.equal(hasForeignScript("Jean 3:16 — Car Dieu a tant aimé le monde"), false)
  assert.equal(hasForeignScript("Où est l'œuvre ? Ça c'est à Noël, naïve façon."), false)
  assert.equal(hasForeignScript("For God so loved the world"), false)
  assert.equal(hasForeignScript("123 ... !?"), false)
  assert.equal(hasForeignScript(""), false)
})

test("other scripts are rejected", () => {
  assert.equal(hasForeignScript("यह एक परीक्षण है"), true) // Hindi
  assert.equal(hasForeignScript("یہ ایک ٹیسٹ ہے"), true) // Urdu
  assert.equal(hasForeignScript("ਇਹ ਇੱਕ ਟੈਸਟ ਹੈ"), true) // Punjabi
  assert.equal(hasForeignScript("Jean 3 यह 16"), true) // mixed
  assert.equal(hasForeignScript("这是一个测试"), true)
})
