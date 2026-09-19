type CacheEntry<T> = {
  readonly value: T
  readonly expiresAt: number
}

/**
 * Generic bounded LRU cache with a per-entry TTL (AGENTS.md section 36:
 * caches must be bounded; ARCHITECTURE.md section 19: v1 uses an
 * in-memory LRU cache). Not Bible-specific — VerseCache builds on this.
 *
 * `now` is injectable so expiry can be tested deterministically without
 * real timers or sleeps (AGENTS.md section 32).
 */
export class LruTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(maxEntries: number, now: () => number = Date.now) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer")
    }
    this.maxEntries = maxEntries
    this.now = now
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }

    // Move to the most-recently-used position (Map preserves insertion order).
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  /**
   * ARCHITECTURE.md production audit (section 74): the diagnosable half
   * of a negative-cache suppression — how much longer this key will stay
   * suppressed, using this cache's own injected clock (not the caller's),
   * so it stays correct under an injected test clock too. Deliberately
   * does not call get() internally: a diagnostic read must never mutate
   * LRU recency ordering as a side effect of merely inspecting the cache.
   */
  getRemainingTtlMs(key: string): number | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    const remaining = entry.expiresAt - this.now()
    return remaining > 0 ? remaining : undefined
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
