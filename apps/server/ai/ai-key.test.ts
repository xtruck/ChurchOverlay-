import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeAnthropicKeyInput } from "./ai-key"

const GOOD = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"

test("a well-formed Anthropic key is accepted and cleaned of whitespace and quotes", () => {
  assert.deepEqual(normalizeAnthropicKeyInput(GOOD), { ok: true, key: GOOD })
  assert.deepEqual(normalizeAnthropicKeyInput(`  "${GOOD}"\n`), { ok: true, key: GOOD })
})

test("empty and non-Anthropic input is refused with a fixed code", () => {
  assert.deepEqual(normalizeAnthropicKeyInput("   "), { ok: false, error: "empty" })
  assert.deepEqual(normalizeAnthropicKeyInput("gsk_notanthropickey0123456789012345678"), { ok: false, error: "format" })
  assert.deepEqual(normalizeAnthropicKeyInput("sk-ant-short"), { ok: false, error: "format" })
  assert.deepEqual(normalizeAnthropicKeyInput(`sk-ant-api03-abc def0123456789012345678901234`), { ok: false, error: "format" })
  assert.deepEqual(normalizeAnthropicKeyInput(`sk-ant-api03-abc​def0123456789012345678901234`), { ok: false, error: "format" })
  assert.deepEqual(normalizeAnthropicKeyInput(undefined), { ok: false, error: "format" })
  assert.deepEqual(normalizeAnthropicKeyInput(42), { ok: false, error: "format" })
})

import { normalizeGroqKeyInput } from "./ai-key"

test("Groq key: gsk_ prefix required, cleaned of quotes/whitespace, empty and foreign keys refused", () => {
  const good = "gsk_abcdefghijklmnopqrstuvwxyz0123456789"
  assert.deepEqual(normalizeGroqKeyInput(` '${good}' `), { ok: true, key: good })
  assert.deepEqual(normalizeGroqKeyInput(""), { ok: false, error: "empty" })
  assert.deepEqual(normalizeGroqKeyInput("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"), { ok: false, error: "format" })
  assert.deepEqual(normalizeGroqKeyInput("gsk_short"), { ok: false, error: "format" })
})
