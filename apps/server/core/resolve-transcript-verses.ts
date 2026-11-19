import type {
  TranscriptResult,
  Verse,
  VerseDetector,
  VerseIndex,
  VerseReference,
  VerseSource,
} from "../../../packages/contracts"
import type { VerseCache } from "../verse/verse-cache"
import type { CircuitBreaker } from "../verse/circuit-breaker"
import type { Logger } from "../../../packages/shared/logger"
import type { DetectedVerseRange, VerseRangeDetectorLike } from "../detector/verse-range-detector"
import { passesTranscriptGate } from "./transcript-gate"
import { detectValidatedReferences, detectValidatedRanges, rangeCoveredKeys } from "./detect-and-validate"
import { resolveVerseDetailed, translationIdFor, type VerseLookupFailure } from "../verse/resolve-verse"
import { resolveVerseRange } from "../verse/resolve-verse-range"

/**
 * Completes the Application Core pipeline from ARCHITECTURE.md section 23,
 * all the way through to verified verse text:
 *
 *   TranscriptResult
 *         v
 *   processTranscript()     (Transcript Gate -> RegexDetector -> KnownValidVerseIndex)
 *         v
 *   VerseReference[] + DetectedVerseRange[]   (validated, but still just references)
 *         v
 *   resolveVerse() / resolveVerseRange()   (cache -> circuit breaker -> VerseSource)
 *         v
 *   Verse[]                  (verified — safe to reach a "verse:show" event)
 *
 * What comes after this (building the actual WsMessage envelope and
 * sending it) is deliberately not this function's job — that belongs to
 * whatever owns the real WebSocket connection, not the Application Core.
 *
 * RESOLUTION CONCURRENCY (innovation pass, ARCHITECTURE.md section 145 —
 * superseding this file's original "sequential on purpose" note): detected
 * references resolve CONCURRENTLY. The original sequential note predated
 * both the sources' single-flight coalescing (section 144.4), which makes
 * concurrent identical requests share one download, and the verse-cache
 * warming (section 144.3), which makes same-chapter references resolve
 * from one chapter read. What concurrency buys is the one case left: a
 * sentence citing references in DIFFERENT chapters ("Jean 3:16 et Psaume
 * 23:1") now pays one round-trip instead of two. Order is fully
 * preserved: results are mapped back to input order before onLookup runs
 * or verses are returned, so callers see exactly the sequence the
 * sequential version produced, only sooner. The transcript gate is checked
 * once, up front, for both the single and the range path.
 */
export async function resolveTranscriptVerses(
  transcript: TranscriptResult,
  detector: VerseDetector,
  index: VerseIndex,
  source: VerseSource,
  cache: VerseCache,
  circuitBreaker: CircuitBreaker,
  logger?: Logger,
  /** SF-03: called once per looked-up reference, with the failure reason or null on success. */
  onLookup?: (reference: VerseReference, failure: VerseLookupFailure | null) => void,
  /** Innovation pass (section 145): optional range capability, e.g. the same RegexDetector instance. */
  rangeDetector?: VerseRangeDetectorLike
): Promise<Verse[]> {
  if (!passesTranscriptGate(transcript)) return []

  const references = detectValidatedReferences(detector, index, transcript.text)
  const ranges: readonly DetectedVerseRange[] = rangeDetector
    ? detectValidatedRanges(rangeDetector, index, transcript.text)
    : []

  // A single inside a validated range is redundant: the range already shows
  // that verse with its bracketed number. (Same text, same transcript — e.g.
  // a merged transcript whose sentences cite overlapping references.)
  const covered = rangeCoveredKeys(ranges)
  const standalone = references.filter(
    (reference) => !covered.has(`${reference.book}:${reference.chapter}:${reference.verse}`)
  )

  const translation = translationIdFor(source)
  const singlesSettled = await Promise.all(
    standalone.map((reference) =>
      resolveVerseDetailed(reference, source, cache, circuitBreaker, translation, logger)
    )
  )
  singlesSettled.forEach((result, i) => onLookup?.(standalone[i]!, result.failure))

  const verses: Verse[] = singlesSettled
    .map((result) => result.verse)
    .filter((verse): verse is Verse => verse !== null)

  for (const range of ranges) {
    const verse = await resolveVerseRange(range, source, cache, circuitBreaker, translation, logger, onLookup)
    if (verse) verses.push(verse)
  }
  return verses
}
