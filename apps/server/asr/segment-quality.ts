/**
 * Per-segment hallucination filter for the local Whisper engines
 * (ARCHITECTURE.md section 117).
 *
 * With `response_format=verbose_json`, whisper.cpp's server (v1.8.0) returns
 * per-segment `avg_logprob` and `no_speech_prob` (it has no
 * `compression_ratio`), and the faster-whisper sidecar returns all three.
 * A segment Whisper itself thinks is probably not speech AND decoded with
 * low confidence is the classic "Merci d'avoir regardé" invented over
 * silence; an extreme compression ratio is a looping repetition.
 *
 * Pure and deterministic. A response without usable segment fields makes
 * the filter a no-op, never an error: a missing field disables only the
 * rule that needs it.
 */

export type ScoredSegment = {
  readonly text: string
  readonly noSpeechProb?: number
  readonly avgLogprob?: number
  readonly compressionRatio?: number
}

export type SegmentThresholds = {
  /** Drop when no_speech_prob is at least this... */
  readonly noSpeechProbMin: number
  /** ...AND avg_logprob is at most this. */
  readonly avgLogprobMax: number
  /** Drop when compression_ratio is above this, on its own. */
  readonly compressionRatioMax: number
}

/**
 * Conservative on purpose: Whisper's own no-speech rule is 0.6 / -1.0 and its
 * repetition fallback is 2.4. This filter only removes what is far past those,
 * because dropping a real "Jean 3 16" costs more than letting noise reach the
 * detector, which still validates every reference.
 */
export const DEFAULT_SEGMENT_THRESHOLDS: SegmentThresholds = Object.freeze({
  noSpeechProbMin: 0.8,
  avgLogprobMax: -1.0,
  compressionRatioMax: 3.0,
})

export type DroppedSegment = {
  readonly reason: "no-speech" | "compression-ratio"
  readonly noSpeechProb?: number
  readonly avgLogprob?: number
  readonly compressionRatio?: number
  readonly words: number
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Reads `segments` from an /inference response body. Returns null (filter
 * disabled) unless it is an array whose every entry is an object with a
 * string `text`. Score fields are kept only when they are finite numbers.
 */
export function parseScoredSegments(body: unknown): ScoredSegment[] | null {
  if (typeof body !== "object" || body === null) return null
  const segments = (body as { segments?: unknown }).segments
  if (!Array.isArray(segments) || segments.length === 0) return null
  const parsed: ScoredSegment[] = []
  for (const entry of segments) {
    if (typeof entry !== "object" || entry === null) return null
    const raw = entry as Record<string, unknown>
    if (typeof raw.text !== "string") return null
    parsed.push({
      text: raw.text,
      noSpeechProb: finite(raw.no_speech_prob),
      avgLogprob: finite(raw.avg_logprob),
      compressionRatio: finite(raw.compression_ratio),
    })
  }
  return parsed
}

function dropReason(segment: ScoredSegment, t: SegmentThresholds): DroppedSegment["reason"] | null {
  if (segment.compressionRatio !== undefined && segment.compressionRatio > t.compressionRatioMax) return "compression-ratio"
  if (
    segment.noSpeechProb !== undefined &&
    segment.avgLogprob !== undefined &&
    segment.noSpeechProb >= t.noSpeechProbMin &&
    segment.avgLogprob <= t.avgLogprobMax
  ) {
    return "no-speech"
  }
  return null
}

export function filterSegments(
  segments: readonly ScoredSegment[],
  thresholds: SegmentThresholds = DEFAULT_SEGMENT_THRESHOLDS,
): { readonly kept: ScoredSegment[]; readonly dropped: DroppedSegment[] } {
  const kept: ScoredSegment[] = []
  const dropped: DroppedSegment[] = []
  for (const segment of segments) {
    const reason = dropReason(segment, thresholds)
    if (reason === null) {
      kept.push(segment)
      continue
    }
    dropped.push({
      reason,
      noSpeechProb: segment.noSpeechProb,
      avgLogprob: segment.avgLogprob,
      compressionRatio: segment.compressionRatio,
      words: segment.text.trim().split(/\s+/).filter(Boolean).length,
    })
  }
  return { kept, dropped }
}
