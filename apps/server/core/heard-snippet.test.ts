import { test } from "node:test"
import assert from "node:assert/strict"
import { heardSnippet, HEARD_SNIPPET_MAX_CHARS } from "./heard-snippet"

test("heardSnippet: collapses whitespace and trims", () => {
  assert.equal(heardSnippet("  turn   to\nJohn 3:16 \n"), "turn to John 3:16")
})

test("heardSnippet: keeps short text unchanged", () => {
  assert.equal(heardSnippet("Jean 3:16"), "Jean 3:16")
})

test("heardSnippet: bounds a long utterance, keeping its end where the reference is", () => {
  const long = "word ".repeat(100) + "turn to John 3:16"
  const snippet = heardSnippet(long)
  assert.ok(snippet.length <= HEARD_SNIPPET_MAX_CHARS)
  assert.ok(snippet.startsWith("…"))
  assert.ok(snippet.endsWith("turn to John 3:16"))
})
