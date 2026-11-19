import type { VerseIndex, VerseReference } from "../../../packages/contracts"
import { normalizeSpokenReferences } from "./spoken-reference-normalizer"
import { isCatalogBookWord } from "./regex-detector"

/**
 * Settle-window support for references whose LAST token is a number that the
 * ASR may still be in the middle of saying (or may have cut in two: "verse 1"
 * | "2" for "verse 12"). Pure functions; no timers, no I/O. The caller
 * (app-core) owns the timer and the display decision.
 */

const TRAILING_PUNCTUATION = /[\s.,;:!?…"'»)\]]+$/u

function normalized(text: string): string {
  return normalizeSpokenReferences(text, isCatalogBookWord).replace(TRAILING_PUNCTUATION, "")
}

/**
 * True when the text ends on the verse number of one of `references` AND that
 * number could still grow into another valid verse of the same chapter
 * (verse 1 -> 10..19, verse 11 -> 110..119 only if the chapter has them).
 * "John 3 verse 16" can never become 160+, so it is final immediately;
 * "John 11 verse 1" can become 11:10-11:19, so it must wait.
 */
export function trailingVerseCouldGrow(text: string, references: readonly VerseReference[], index: VerseIndex): boolean {
  const tail = /(?<![\p{L}\d])(\d{1,3})$/u.exec(normalized(text))
  if (!tail) return false
  const lastNumber = Number.parseInt(tail[1] as string, 10)
  for (const reference of references) {
    if (reference.verse !== lastNumber) continue
    for (let digit = 0; digit <= 9; digit++) {
      if (index.exists({ ...reference, verse: reference.verse * 10 + digit })) return true
    }
  }
  return false
}

/** The text ends on exactly this number (after normalizing spoken numbers and trailing punctuation). */
export function trailingNumberEquals(text: string, value: number): boolean {
  const tail = /(?<![\p{L}\d])(\d{1,3})$/u.exec(normalized(text))
  return tail !== null && Number.parseInt(tail[1] as string, 10) === value
}

/**
 * A fragment that is ONLY a number ("2", "2.", "2,"): digits with optional
 * surrounding punctuation and nothing else. Any following word ("2 choses a
 * retenir", "3 things", "2 Corinthians 5:17") is a new sentence, never the end
 * of "verse 1", so it is not a continuation. Returns the digits, or null.
 */
export function leadingNumberContinuation(text: string): string | null {
  const match = /^[\s"'«(]*(\d{1,3})[\s.,;!?…"'»)]*$/u.exec(text)
  return match ? (match[1] as string) : null
}

/**
 * "Turn to John 11 verse 1" + "2. Jesus wept" -> "Turn to John 11 verse 12. Jesus wept".
 * Glues the continuation digits onto the held text's trailing number.
 */
export function joinSplitNumber(heldText: string, nextText: string): string | null {
  const digits = leadingNumberContinuation(nextText)
  if (digits === null) return null
  const held = heldText.replace(TRAILING_PUNCTUATION, "")
  if (!/\d$/.test(held)) return null
  return `${held}${digits}`
}
