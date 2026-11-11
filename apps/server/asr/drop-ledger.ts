/**
 * Shared record of everything the transcript pipeline dropped, so a deaf app
 * is distinguishable from a quiet room: per-category counts over the last
 * minute (shown to the operator in mic:health), running totals per reason,
 * rate-limited log decisions (a flood cannot fill the log), and "valve" flags
 * raised by a provider whose language guard has been dropping too much in a
 * row and has stopped dropping.
 *
 * Pure bookkeeping with an injectable clock. Bounded: at most MAX_STAMPS
 * timestamps per category.
 */
export type DropCategory = "screen" | "segment" | "language" | "off-language"

export const DROP_CATEGORIES: readonly DropCategory[] = ["screen", "segment", "language", "off-language"]

const WINDOW_MS = 60_000
const MAX_STAMPS = 300
/** At most one log line per category and reason per this long; the rest are counted as suppressed. */
const LOG_INTERVAL_MS = 5_000

export type DropNote = {
  /** Should the caller write a log line for this drop (rate limit)? */
  readonly log: boolean
  /** Drops with this category and reason since the last logged one (including this one when log is true). */
  readonly suppressed: number
  /** Running total for this category and reason. */
  readonly total: number
}

export class DropLedger {
  private readonly stamps: Record<DropCategory, number[]> = { screen: [], segment: [], language: [], "off-language": [] }
  private readonly totals = new Map<string, number>()
  private readonly lastLog = new Map<string, number>()
  private readonly pending = new Map<string, number>()
  private readonly valves = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  record(category: DropCategory, reason: string): DropNote {
    const at = this.now()
    const list = this.stamps[category]
    list.push(at)
    if (list.length > MAX_STAMPS) list.shift()
    const key = `${category}:${reason}`
    const total = (this.totals.get(key) ?? 0) + 1
    this.totals.set(key, total)
    const pending = (this.pending.get(key) ?? 0) + 1
    const last = this.lastLog.get(key)
    if (last === undefined || at - last >= LOG_INTERVAL_MS) {
      this.lastLog.set(key, at)
      this.pending.set(key, 0)
      return { log: true, suppressed: pending, total }
    }
    this.pending.set(key, pending)
    return { log: false, suppressed: pending, total }
  }

  /** Drops in the last 60 s, by category. */
  perMinute(): Record<DropCategory, number> {
    const cutoff = this.now() - WINDOW_MS
    const out = { screen: 0, segment: 0, language: 0, "off-language": 0 }
    for (const category of DROP_CATEGORIES) out[category] = this.stamps[category].filter((at) => at >= cutoff).length
    return out
  }

  /** Running totals keyed "category:reason". */
  snapshotTotals(): Record<string, number> {
    return Object.fromEntries(this.totals)
  }

  /** A provider's language guard opened (true) or closed (false) its safety valve. */
  setValve(source: string, open: boolean): void {
    if (open) this.valves.add(source)
    else this.valves.delete(source)
  }

  /** Sources whose guard is currently bypassed because it dropped too many transcripts in a row. */
  openValves(): string[] {
    return [...this.valves]
  }
}
