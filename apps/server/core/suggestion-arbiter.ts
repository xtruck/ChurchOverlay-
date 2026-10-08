import type { VerseReference } from "../../../packages/contracts"

/**
 * The small piece of state every verse SUGGESTION path shares (quotation matching,
 * near-miss repair, AI transcript cleanup, AI semantic proposals):
 *
 *  - a per-verse cooldown, so a verse is not suggested twice, by two helpers or by
 *    one helper twice in a row;
 *  - the "a DETECTED verse is waiting for approval" hold, so an AI guess that
 *    arrives a moment later does not replace what the operator was about to confirm.
 *
 * Pure and clock-injectable: it only decides. AppCore stays the single place that
 * offers a suggestion (same shape as InterpreterEchoGuard, ARCHITECTURE.md section 120).
 *
 * The cooldown starts in markOffered(), which the caller invokes only once the
 * suggestion is really about to be offered: a failed verse lookup must not hide
 * the verse for the whole cooldown.
 */

export const SUGGESTION_COOLDOWN_MS = 60_000
export const DETECTED_HOLD_MS = 20_000
export const MAX_COOLDOWN_ENTRIES = 200

export type SuggestionArbiterOptions = {
  readonly now?: () => number
  readonly cooldownMs?: number
  readonly detectedHoldMs?: number
  readonly maxEntries?: number
}

export function suggestionKey(reference: VerseReference): string {
  return `${reference.book} ${reference.chapter}:${reference.verse}`
}

export class SuggestionArbiter {
  private readonly offered = new Map<string, number>()
  private detectedWaitingSince = 0
  private readonly now: () => number
  private readonly cooldownMs: number
  private readonly detectedHoldMs: number
  private readonly maxEntries: number

  constructor(options: SuggestionArbiterOptions = {}) {
    this.now = options.now ?? Date.now
    this.cooldownMs = options.cooldownMs ?? SUGGESTION_COOLDOWN_MS
    this.detectedHoldMs = options.detectedHoldMs ?? DETECTED_HOLD_MS
    this.maxEntries = options.maxEntries ?? MAX_COOLDOWN_ENTRIES
  }

  /** Not on screen right now, and not offered within the cooldown. */
  canOffer(reference: VerseReference, onScreen: VerseReference | null): boolean {
    if (onScreen !== null && suggestionKey(onScreen) === suggestionKey(reference)) return false
    return this.now() - (this.offered.get(suggestionKey(reference)) ?? 0) >= this.cooldownMs
  }

  /** Starts the cooldown. Prunes expired entries first so the map stays bounded (AGENTS.md section 36). */
  markOffered(reference: VerseReference): void {
    const now = this.now()
    if (this.offered.size > this.maxEntries) {
      for (const [key, at] of this.offered) {
        if (now - at >= this.cooldownMs) this.offered.delete(key)
      }
    }
    this.offered.set(suggestionKey(reference), now)
  }

  /** A detected verse started waiting for the operator's approval. */
  noteDetectedWaiting(): void {
    this.detectedWaitingSince = this.now()
  }

  /** Nothing detected is waiting any more (a verse was shown, or another suggestion took the slot). */
  clearDetectedWaiting(): void {
    this.detectedWaitingSince = 0
  }

  /** False while a detected verse has been waiting for less than the hold. */
  aiMayReplacePending(): boolean {
    return this.now() - this.detectedWaitingSince > this.detectedHoldMs
  }

  /** Number of remembered verses (diagnostics and tests). */
  get size(): number {
    return this.offered.size
  }
}
