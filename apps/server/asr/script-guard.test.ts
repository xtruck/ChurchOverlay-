import test from "node:test"
import assert from "node:assert/strict"
import { hasForeignScript, isLikelyThirdLatinLanguage } from "./script-guard"

test("Spanish and Portuguese are recognised as a third language", () => {
  assert.equal(isLikelyThirdLatinLanguage("Gracias hermanos, porque Dios es amor"), true)
  assert.equal(isLikelyThirdLatinLanguage("Obrigado, você não está sozinho"), true)
  assert.equal(isLikelyThirdLatinLanguage("El señor está aquí hoy"), true) // hard mark + marker word
  assert.equal(isLikelyThirdLatinLanguage("a pregação de hoje não"), true) // hard mark (ã) in 4 words
})

test("French and English are never flagged as a third language", () => {
  assert.equal(isLikelyThirdLatinLanguage("Le Seigneur est notre berger, nous le louons pour toujours"), false)
  assert.equal(isLikelyThirdLatinLanguage("Jean 3:16 Car Dieu a tant aimé le monde"), false)
  assert.equal(isLikelyThirdLatinLanguage("Let us read John chapter 3 verse 16"), false)
  assert.equal(isLikelyThirdLatinLanguage("Que la paix de Dieu soit avec vous, mais aussi avec nous"), false)
  assert.equal(isLikelyThirdLatinLanguage("pero"), false) // one marker word alone is not enough
  assert.equal(isLikelyThirdLatinLanguage("señor"), false) // a hard mark alone, too short
  assert.equal(isLikelyThirdLatinLanguage(""), false)
})

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
