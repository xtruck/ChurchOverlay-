/**
 * The last few seconds of FINAL speech as one run of words.
 *
 * Streaming ASR cuts a continuous sermon into short finals at every breath, so
 * a verse the preacher reads aloud (or any phrase that spans a cut) is never
 * inside one transcript. QuoteMatcher needs ~8 consecutive verbatim words; fed
 * one final at a time it misses a reading that crosses a boundary. This keeps a
 * bounded window (time AND word count) so the matcher sees the reading whole.
 *
 * Detection only: it never authorizes a verse. The matcher's output is still a
 * pending suggestion that goes through the index and the Bible source.
 */
export type RollingTranscriptWindowOptions = {
  readonly maxAgeMs?: number
  readonly maxWords?: number
}

type Entry = { readonly words: string[]; readonly timestamp: number }

export class RollingTranscriptWindow {
  private readonly maxAgeMs: number
  private readonly maxWords: number
  private entries: Entry[] = []

  constructor(options: RollingTranscriptWindowOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 30_000
    this.maxWords = options.maxWords ?? 80
  }

  /** Adds a final transcript and returns the whole window, oldest first. */
  push(text: string, timestamp: number): string {
    const words = text.trim().split(/\s+/).filter(Boolean)
    this.entries = this.entries.filter((entry) => timestamp - entry.timestamp <= this.maxAgeMs)
    const last = this.entries[this.entries.length - 1]
    // An ASR that re-sends the same final must not double the words.
    if (words.length > 0 && !(last && last.words.join(" ") === words.join(" "))) {
      this.entries.push({ words, timestamp })
    }
    // Keep the LAST maxWords words: trim the oldest entry from its front.
    let total = this.entries.reduce((sum, entry) => sum + entry.words.length, 0)
    while (total > this.maxWords && this.entries.length > 0) {
      const oldest = this.entries[0] as Entry
      const excess = Math.min(total - this.maxWords, oldest.words.length)
      oldest.words.splice(0, excess)
      total -= excess
      if (oldest.words.length === 0) this.entries.shift()
    }
    return this.entries.flatMap((entry) => entry.words).join(" ")
  }

  reset(): void {
    this.entries = []
  }
}
