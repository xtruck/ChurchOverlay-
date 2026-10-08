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
