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
import { processTranscript } from "./process-transcript"
import { resolveVerseDetailed, translationIdFor, type VerseLookupFailure } from "../verse/resolve-verse"

/**
 * Completes the Application Core pipeline from ARCHITECTURE.md section 23,
 * all the way through to verified verse text:
 *
 *   TranscriptResult
 *         v
 *   processTranscript()     (Transcript Gate -> RegexDetector -> KnownValidVerseIndex)
 *         v
 *   VerseReference[]         (validated, but still just references)
 *         v
 *   resolveVerse() per reference   (cache -> circuit breaker -> VerseSource)
 *         v
 *   Verse[]                  (verified — safe to reach a "verse:show" event)
 *
 * What comes after this (building the actual WsMessage envelope and
 * sending it) is deliberately not this function's job — that belongs to
 * whatever owns the real WebSocket connection, not the Application Core.
 *
 * References are resolved sequentially (not concurrently): a spoken
 * sentence containing multiple references is a rare case, and resolving
 * them one at a time keeps cache/circuit-breaker state changes easy to
 * reason about without introducing a batching policy nothing has asked
 * for (AGENTS.md section 39: scope discipline).
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
  onLookup?: (reference: VerseReference, failure: VerseLookupFailure | null) => void
): Promise<Verse[]> {
  const references = processTranscript(transcript, detector, index)

  const verses: Verse[] = []
  for (const reference of references) {
    const { verse, failure } = await resolveVerseDetailed(reference, source, cache, circuitBreaker, translationIdFor(source), logger)
    onLookup?.(reference, failure)
    if (verse) verses.push(verse)
  }
  return verses
}
