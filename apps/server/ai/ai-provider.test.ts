import { test } from "node:test"
import assert from "node:assert/strict"
import { ClaudeClient } from "./claude-client"
import { GroqTextClient } from "./groq-text-client"
import { aiProviderReady, createTextCompleter, isAiProvider, selectedAiProvider } from "./ai-provider"

test("isAiProvider: only the two known providers", () => {
  assert.equal(isAiProvider("anthropic"), true)
  assert.equal(isAiProvider("groq"), true)
  assert.equal(isAiProvider("openai"), false)
  assert.equal(isAiProvider(undefined), false)
})

test("no choice and an Anthropic key: Anthropic, exactly as before this option existed", () => {
  const config = { anthropicApiKey: "sk-ant-x", groqApiKey: "gsk_x" }
  assert.equal(selectedAiProvider(config), "anthropic")
  assert.ok(createTextCompleter(config) instanceof ClaudeClient)
})

test("no choice and only a Groq key: no AI until the operator picks one (the transcription key alone does not start sending text)", () => {
  const config = { groqApiKey: "gsk_x" }
  assert.equal(selectedAiProvider(config), null)
  assert.equal(aiProviderReady(config), false)
  assert.equal(createTextCompleter(config), undefined)
})

test("an explicit Groq choice uses the Groq key, even when an Anthropic key exists", () => {
  const config = { aiProvider: "groq" as const, anthropicApiKey: "sk-ant-x", groqApiKey: "gsk_x" }
  assert.ok(createTextCompleter(config) instanceof GroqTextClient)
})

test("an explicit Anthropic choice uses Anthropic", () => {
  const config = { aiProvider: "anthropic" as const, anthropicApiKey: "sk-ant-x", groqApiKey: "gsk_x" }
  assert.ok(createTextCompleter(config) instanceof ClaudeClient)
})

test("no silent fallback: a chosen provider without its key leaves the helpers inert instead of using the other one", () => {
  const groqWithoutKey = { aiProvider: "groq" as const, anthropicApiKey: "sk-ant-x", groqApiKey: "" }
  assert.equal(aiProviderReady(groqWithoutKey), false)
  assert.equal(createTextCompleter(groqWithoutKey), undefined)

  const anthropicWithoutKey = { aiProvider: "anthropic" as const, groqApiKey: "gsk_x" }
  assert.equal(aiProviderReady(anthropicWithoutKey), false)
  assert.equal(createTextCompleter(anthropicWithoutKey), undefined)
})
