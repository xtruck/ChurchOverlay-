export type TranscriptFragment = {
  readonly text: string
  readonly timestamp: number
}

export type TranscriptAssemblerOptions = {
  readonly windowMs?: number
  readonly maxFragments?: number
}

/**
 * Keeps only a tiny, final-transcript window for references split by batch ASR.
 * It never authorizes a verse; callers still run the assembled text through
 * the normal detector, index, and Bible-source validation path.
 */
export class TranscriptAssembler {
  private readonly windowMs: number
  private readonly maxFragments: number
  private fragments: TranscriptFragment[] = []

  constructor(options: TranscriptAssemblerOptions = {}) {
    this.windowMs = options.windowMs ?? 4000
    this.maxFragments = options.maxFragments ?? 3
  }

  push(fragment: TranscriptFragment): string | null {
    const text = fragment.text.trim()
    if (!text) return null
    this.fragments = this.fragments.filter((item) => fragment.timestamp - item.timestamp <= this.windowMs)
    this.fragments.push({ text, timestamp: fragment.timestamp })
    if (this.fragments.length > this.maxFragments) this.fragments.shift()

    if (this.fragments.length < 2) return null
    const combined = this.fragments.map((item) => item.text).join(" ")
    if (!/\d/.test(combined)) return null
    if (!/(chapitre|chapter|verset|verse|:)/i.test(combined)) return null
    return combined
  }

  reset(): void {
    this.fragments = []
  }
}
