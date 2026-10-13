import { strict as assert } from "node:assert"
import { test } from "node:test"
import { SessionRecorder } from "./session-recorder"
import type { Verse } from "../../../packages/contracts"

test("SessionRecorder: exportMarkdown produces valid Markdown", () => {
  const recorder = new SessionRecorder()

  // Empty session
  assert.match(recorder.exportMarkdown(), /No verses were shown/)
  assert.match(recorder.exportMarkdown(), /# Service Transcript/)

  // With entries
  const verse1: Verse = {
    reference: { book: "John", chapter: 3, verse: 16 },
    text: "For God so loved the world",
    translation: "kjv",
    source: "test",
  }
  const verse2: Verse = {
    reference: { book: "Romans", chapter: 8, verse: 28 },
    text: "And we know that all things work together for good",
    translation: "kjv",
    source: "test",
  }

  recorder.record(verse1, 1700000000000)
  recorder.record(verse2, 1700000030000)

  const markdown = recorder.exportMarkdown()
  assert.match(markdown, /# Service Transcript/)
  assert.match(markdown, /Total verses shown: 2/)
  assert.match(markdown, /John 3:16/)
  assert.match(markdown, /Romans 8:28/)
  assert.match(markdown, /For God so loved the world/)
  assert.match(markdown, /And we know that all things work together for good/)
})
