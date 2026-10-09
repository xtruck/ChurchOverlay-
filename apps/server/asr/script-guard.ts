/**
 * French/English-only guard on transcript text.
 *
 * The preacher speaks French and English. When the audio is noisy or quiet an
 * engine can hallucinate fluent text in another language, typically in another
 * script (Devanagari, Arabic/Urdu, Bengali, Thai, CJK...). Neither French nor
 * English uses any letter outside the Latin script, so a transcript holding
 * one is never real speech from this church and is dropped, whichever engine
 * produced it.
 *
 * Pure and deterministic.
 */

/** True when the text contains at least one letter that is not Latin script (so not French or English). */
export function hasForeignScript(text: string): boolean {
  return /\p{L}/u.test(text.replace(/\p{Script=Latin}/gu, ""))
}

/**
 * Words that are Spanish or Portuguese and neither French nor English. Words
 * French or English also use ("que", "de", "es", "con", "mais") are
 * deliberately absent.
 */
const THIRD_LANGUAGE_WORDS: ReadonlySet<string> = new Set([
  "não", "nao", "você", "voce", "vocês", "obrigado", "obrigada", "gracias", "señor", "senhor", "está", "estão",
  "pero", "porque", "porquê", "também", "tambem", "uma", "isso", "muito", "como", "dios", "deus", "nuestro",
  "nosso", "para", "una", "hermanos", "irmãos", "amor", "bendición", "bênção",
])
/** Letters and marks French and English never use: one is enough, given enough words around it. */
const THIRD_LANGUAGE_HARD_MARKS = /[ñãõ¿¡]/u
/** A hard mark alone is only trusted in a clip of at least this many words. */
const HARD_MARK_MIN_WORDS = 3
/** Distinct marker words that, together, make a clip Spanish or Portuguese. */
const MIN_DISTINCT_MARKER_WORDS = 2

/**
 * True when Latin-script text looks like Spanish or Portuguese. Whisper in
 * auto-detect mode can drift into either on a quiet clip; they share the
 * Latin alphabet, so `hasForeignScript` cannot see them. Conservative on
 * purpose: single common words never match. The caller must still keep text
 * that is clearly French or English (a French sermon may quote "Señor").
 */
export function isLikelyThirdLatinLanguage(text: string): boolean {
  const words = text.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean)
  if (words.length === 0) return false
  const distinct = new Set(words.filter((word) => THIRD_LANGUAGE_WORDS.has(word)))
  if (distinct.size >= MIN_DISTINCT_MARKER_WORDS) return true
  return words.length >= HARD_MARK_MIN_WORDS && THIRD_LANGUAGE_HARD_MARKS.test(text.toLowerCase())
}
