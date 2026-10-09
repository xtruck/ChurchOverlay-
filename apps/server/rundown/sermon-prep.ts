import type { VerseIndex, VerseReference } from "../../../packages/contracts"
import { RegexDetector } from "../detector/regex-detector"
import { resolveQuickBook } from "../detector/quick-book"

/**
 * ARCHITECTURE.md section 130: sermon-prep import. Turns the pastor's pasted
 * notes or outline (plain text, French or English) into the ordered list of
 * Bible references it names.
 *
 * Pure and deterministic: no network, no AI, no filesystem, no clock. It only
 * reuses the existing RegexDetector and resolveQuickBook, and keeps a
 * reference only when the known-valid index says it exists. Showing one of
 * the results still goes through the ordinary verse:override path (AGENTS.md
 * section 50), so this parser can never put text on screen by itself.
 */

/** Pasted notes larger than this are refused, not silently truncated. */
export const MAX_SERMON_PREP_CHARS = 20_000

/** At most this many references are kept (same cap as the rundown prefetch). */
export const MAX_SERMON_PREP_REFERENCES = 50

export type SermonPrepResult = {
  /** Validated references in the order the notes name them, duplicates removed. */
  readonly references: readonly VerseReference[]
  /** Distinct catalog book ids of `references`, in first-seen order. */
  readonly bookIds: readonly string[]
  /** Candidates the known-valid index rejected (unknown book, chapter or verse). */
  readonly rejectedCount: number
  /** True when more than MAX_SERMON_PREP_REFERENCES valid references were found. */
  readonly truncated: boolean
}

export type SermonPrepParseOutcome =
  | { readonly ok: true; readonly result: SermonPrepResult }
  | { readonly ok: false; readonly reason: "not-text" | "too-long" }

const detector = new RegexDetector()

/**
 * Lines and semicolons separate items in an outline ("Jean 3:16; Romains 8:28"),
 * so each segment is detected on its own and the list keeps the notes' order.
 * Within one segment the detector's own order applies.
 */
function segments(text: string): string[] {
  return text.split(/[\r\n;]+/).map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/**
 * The detector already maps full English and French names to catalog ids.
 * Notes are written, so they also use abbreviations ("Jn", "1 Co", "Rm"):
 * those go through the same resolver the dashboard's quick entry uses.
 */
function withCatalogBook(reference: VerseReference): VerseReference {
  const book = resolveQuickBook(reference.book) ?? reference.book
  return book === reference.book ? reference : { ...reference, book }
}

export function parseSermonPrep(input: unknown, index: VerseIndex): SermonPrepParseOutcome {
  if (typeof input !== "string") return { ok: false, reason: "not-text" }
  if (input.length > MAX_SERMON_PREP_CHARS) return { ok: false, reason: "too-long" }

  const references: VerseReference[] = []
  const seen = new Set<string>()
  let rejectedCount = 0
  let truncated = false

  for (const segment of segments(input)) {
    for (const candidate of detector.detect(segment)) {
      const reference = withCatalogBook(candidate)
      if (!index.exists(reference)) {
        rejectedCount++
        continue
      }
      const key = `${reference.book}:${reference.chapter}:${reference.verse}`
      if (seen.has(key)) continue
      if (references.length >= MAX_SERMON_PREP_REFERENCES) {
        truncated = true
        continue
      }
      seen.add(key)
      references.push(reference)
    }
  }

  const bookIds = [...new Set(references.map((reference) => reference.book))]
  return { ok: true, result: { references, bookIds, rejectedCount, truncated } }
}
