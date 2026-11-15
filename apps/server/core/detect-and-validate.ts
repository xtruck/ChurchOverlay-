import type { VerseDetector, VerseIndex, VerseReference } from "../../../packages/contracts"
import type { DetectedVerseRange, VerseRangeDetectorLike } from "../detector/verse-range-detector"

/**
 * Enforces ARCHITECTURE.md's hallucination-guard invariant (section 14,
 * section 47 Invariant 5): a detector match is a *candidate*, never a
 * trusted reference. This is the only sanctioned way to go from raw
 * transcript text to references anything downstream may act on.
 *
 * Forbidden (ARCHITECTURE.md section 14):
 *   detector.detect(text) -> overlay.show(reference)
 *
 * Correct path, implemented here:
 *   detector -> candidate references -> known-valid index -> validated references
 *
 * This function does not call a Bible API and does not send WebSocket
 * messages — it only narrows candidate references down to ones the known-
 * valid index confirms exist. Fetching verse text (VerseSource) and
 * presenting it are separate, later stages not implemented yet.
 */
export function detectValidatedReferences(
  detector: VerseDetector,
  index: VerseIndex,
  text: string
): VerseReference[] {
  return detector.detect(text).filter((reference) => index.exists(reference))
}

/**
 * Innovation pass (ARCHITECTURE.md section 145): the range twin of
 * detectValidatedReferences, with the same hallucination-guard invariant —
 * a detected range is a candidate, never a trusted reference.
 *
 * A validated range is CONTIGUOUS: the spoken end verse is clamped down to
 * the last verse the index confirms, so a preacher saying "verses 16 to 20"
 * in a 16-verse chapter is shown 16-16's truth ("16 to 16" = the single
 * verse 16) instead of three verses the source would confirm one by one
 * anyway. Ranges are additionally capped at MAX_RANGE_VERSES so one
 * utterance ("verset 1 à 176" over Psalm 119) can neither flood the overlay
 * with a wall of text nor turn one detection into an unbounded sequence of
 * source reads. A range whose START verse does not exist is dropped
 * entirely; a reversed span never reaches this function (the range detector
 * refuses it).
 */
export const MAX_RANGE_VERSES = 12

export function detectValidatedRanges(
  rangeDetector: VerseRangeDetectorLike,
  index: VerseIndex,
  text: string
): DetectedVerseRange[] {
  const seen = new Set<string>()
  const validated: DetectedVerseRange[] = []
  for (const range of rangeDetector.detectRanges(text)) {
    const start: VerseReference = { book: range.book, chapter: range.chapter, verse: range.startVerse }
    if (!index.exists(start)) continue

    const cappedEnd = Math.min(range.endVerse, range.startVerse + MAX_RANGE_VERSES - 1)
    let end = cappedEnd
    while (end > range.startVerse && !index.exists({ book: range.book, chapter: range.chapter, verse: end })) {
      end--
    }
    // end >= start holds here: exists(start) passed, so the loop stops at
    // start at the latest.

    const key = `${range.book}:${range.chapter}:${range.startVerse}-${end}`
    if (seen.has(key)) continue
    seen.add(key)
    validated.push({ book: range.book, chapter: range.chapter, startVerse: range.startVerse, endVerse: end })
  }
  return validated
}

/**
 * The set of single-reference keys ("book:chapter:verse") covered by any of
 * the given validated ranges. resolveTranscriptVerses uses it so one
 * utterance can never show a verse twice (once truncated as a leftover
 * single, once inside its range) even when a range and a single survive
 * from DIFFERENT sentences merged into one transcript.
 */
export function rangeCoveredKeys(ranges: readonly DetectedVerseRange[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const range of ranges) {
    for (let verse = range.startVerse; verse <= range.endVerse; verse++) {
      keys.add(`${range.book}:${range.chapter}:${verse}`)
    }
  }
  return keys
}
