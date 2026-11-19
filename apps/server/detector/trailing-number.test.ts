import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector } from "./regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { joinSplitNumber, leadingNumberContinuation, trailingVerseCouldGrow } from "./trailing-number"

const detector = new RegexDetector()
const index = new KnownValidVerseIndex()
const grow = (text: string) => trailingVerseCouldGrow(text, detector.detect(text).filter((r) => index.exists(r)), index)

test("trailingVerseCouldGrow: a short verse that can become 10-19 waits", () => {
  assert.equal(grow("John 11 verse 1"), true)
  assert.equal(grow("Jean 11 verset 1."), true)
  assert.equal(grow("John 11:1"), true)
  assert.equal(grow("Psalm 119 verse 1"), true)
})

test("trailingVerseCouldGrow: a verse that cannot grow is final", () => {
  assert.equal(grow("John 3 verse 16"), false)
  assert.equal(grow("John 11 verse 12"), false)
  assert.equal(grow("Romans 8:28"), false)
})

test("trailingVerseCouldGrow: only when the number is the LAST token", () => {
  assert.equal(grow("John 11 verse 1 is a great verse"), false)
  assert.equal(grow("John 11 verse 1 and then we pray"), false)
})

test("leadingNumberContinuation: bare numbers continue, numbered books and new references do not", () => {
  assert.equal(leadingNumberContinuation("2"), "2")
  assert.equal(leadingNumberContinuation("2."), "2")
  assert.equal(leadingNumberContinuation("2,"), "2")
  assert.equal(leadingNumberContinuation("2 Jesus wept"), null)
  assert.equal(leadingNumberContinuation("3 things I want to say"), null)
  assert.equal(leadingNumberContinuation("2 choses a retenir"), null)
  assert.equal(leadingNumberContinuation("1 minute"), null)
  assert.equal(leadingNumberContinuation("2 Corinthians 5:17"), null)
  assert.equal(leadingNumberContinuation("2 Corinthiens 5"), null)
  assert.equal(leadingNumberContinuation("3:16"), null)
  assert.equal(leadingNumberContinuation("2 3"), null)
  assert.equal(leadingNumberContinuation("Jesus wept"), null)
})

test("joinSplitNumber glues only a bare number onto the trailing number", () => {
  assert.equal(joinSplitNumber("Turn to John 11 verse 1", "2"), "Turn to John 11 verse 12")
  assert.equal(joinSplitNumber("Jean 11 verset 1.", "2."), "Jean 11 verset 12")
  assert.equal(joinSplitNumber("Jean 11 verset 1.", "2. Jésus pleura"), null)
  assert.equal(joinSplitNumber("In Genesis 1 verse 1", "3 things I want to say"), null)
  assert.equal(joinSplitNumber("Jean 3 verset 1.", "2 choses à retenir"), null)
  assert.equal(joinSplitNumber("Jean 11 verset un", "2"), null)
  assert.equal(joinSplitNumber("John 11 verse 1", "Amen"), null)
})
