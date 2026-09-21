import { test } from "node:test"
import assert from "node:assert/strict"
import { TranscriptAssembler } from "./transcript-assembler"

test("TranscriptAssembler: joins a short final reference split across chunks", () => {
  const assembler = new TranscriptAssembler()
  assert.equal(assembler.push({ text: "Ésaïe 4, le verset", timestamp: 1000 }), null)
  assert.equal(assembler.push({ text: "8", timestamp: 1800 }), "Ésaïe 4, le verset 8")
})

test("TranscriptAssembler: expires unrelated old fragments", () => {
  const assembler = new TranscriptAssembler({ windowMs: 1000 })
  assembler.push({ text: "Jean 3", timestamp: 1000 })
  assert.equal(assembler.push({ text: "verset 16", timestamp: 2501 }), null)
})
