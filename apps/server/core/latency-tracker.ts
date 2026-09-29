/**
 * Bounded record of how long the pipeline took from a final transcript
 * arriving to its verse being handed to viewers (verse:show) or to the
 * operator (verse:pending). Covers correction, detection, validation and
 * the Bible lookup — not the ASR provider's own delay, which the provider
 * does not report comparably. Only the most recent `capacity` samples are
 * kept (AGENTS.md section 36: nothing unbounded).
 */
export type LatencySnapshot = {
  readonly count: number
  readonly lastMs: number | null
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly maxMs: number | null
}

const DEFAULT_CAPACITY = 100

export class LatencyTracker {
  private readonly capacity: number
  private readonly samples: number[] = []
  private last: number | null = null

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("LatencyTracker: capacity must be a positive integer")
    this.capacity = capacity
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    this.samples.push(durationMs)
    if (this.samples.length > this.capacity) this.samples.shift()
    this.last = durationMs
  }

  snapshot(): LatencySnapshot {
    if (this.samples.length === 0) return { count: 0, lastMs: null, p50Ms: null, p95Ms: null, maxMs: null }
    const sorted = [...this.samples].sort((a, b) => a - b)
    return {
      count: sorted.length,
      lastMs: this.last,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted[sorted.length - 1] as number,
    }
  }
}

/** Nearest-rank percentile over an ascending, non-empty array. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[rank - 1] as number
}
