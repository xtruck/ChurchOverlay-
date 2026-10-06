import { test } from "node:test"
import assert from "node:assert/strict"
import { isPromptEcho } from "./prompt-echo"

const PROMPT = "Lecture biblique : Jean chapitre 3 verset 16, Psaume 23, Romains 8, Deutéronome, Philippiens."

test("isPromptEcho: the prompt read back (accents, case, punctuation aside) is an echo", () => {
  assert.equal(isPromptEcho("Lecture biblique, Jean chapitre 3 verset 16, psaume 23, Romains 8.", PROMPT), true)
  assert.equal(isPromptEcho("lecture biblique jean chapitre 3 verset 16 psaume 23 romains 8 deuteronome philippiens", PROMPT), true)
})

test("isPromptEcho: a short reference that also appears in the prompt is real speech, not an echo", () => {
  assert.equal(isPromptEcho("Jean chapitre 3 verset 16", PROMPT), false)
  assert.equal(isPromptEcho("Psaume 23", PROMPT), false)
})

test("isPromptEcho: a sentence that merely shares a few prompt words is not an echo", () => {
  assert.equal(isPromptEcho("Ouvrons nos Bibles dans Jean chapitre 3 verset 16 ce matin", PROMPT), false)
  assert.equal(isPromptEcho("Le Seigneur est mon berger, je ne manquerai de rien", PROMPT), false)
})

test("isPromptEcho: an empty prompt or transcript is never an echo", () => {
  assert.equal(isPromptEcho("", PROMPT), false)
  assert.equal(isPromptEcho("Lecture biblique Jean chapitre 3 verset 16", ""), false)
})
