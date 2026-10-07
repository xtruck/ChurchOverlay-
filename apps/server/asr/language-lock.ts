/**
 * Sticky French/English language lock for the LOCAL engines in bilingual
 * (auto) mode (ARCHITECTURE.md section 118).
 *
 * Whisper's unconstrained auto-detection misfired on English speech
 * (section 113) and may pick a third language (Spanish, Portuguese) for a
 * short Latin-script clip. A preacher here speaks French and English only, so
 * the choice is restricted to those two, using the engine's own language
 * probabilities. Detection costs an extra encoder pass, so the result is kept:
 * later clips are sent with the explicit language, and detection runs again
 * only when it is likely stale. Explicit fr/en modes never touch this class.
 *
 * Pure and deterministic (no I/O, no clock).
 */

export type LockedLanguage = "fr" | "en"

/** Detect again after this many clips decoded under the same lock (the preacher may have switched). */
export const LANGUAGE_REDETECT_EVERY_CLIPS = 2
/** A clip shorter than this is too little speech to detect from: it reuses the lock. */
export const LANGUAGE_MIN_DETECT_MS = 2000
/** A clip decoded under the lock with a mean avg_logprob below this suggests the wrong language: detect again next clip. */
export const LANGUAGE_LOW_LOGPROB = -0.8
/** A detection whose winner holds less than this share of fr+en probability is not trusted: detect again next clip. */
export const LANGUAGE_MIN_MARGIN = 0.7

/** Engines report either a code ("fr", sidecar) or the full name ("french", whisper.cpp). Anything else is not ours. */
export function normalizeLanguage(value: unknown): LockedLanguage | null {
  if (typeof value !== "string") return null
  const v = value.trim().toLowerCase()
  if (v === "fr" || v === "french" || v === "français" || v === "francais") return "fr"
  if (v === "en" || v === "english") return "en"
  return null
}

function probability(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The better of French and English from an engine's `language_probabilities`
 * object (code -> probability). `margin` is the winner's share of fr+en.
 * Null when neither language is present: the caller keeps the engine's own choice.
 */
export function pickFrEn(probabilities: unknown): { readonly language: LockedLanguage; readonly margin: number } | null {
  if (typeof probabilities !== "object" || probabilities === null) return null
  const raw = probabilities as Record<string, unknown>
  const fr = probability(raw.fr)
  const en = probability(raw.en)
  if (fr + en <= 0) return null
  return { language: fr >= en ? "fr" : "en", margin: Math.max(fr, en) / (fr + en) }
}

/** Mean of the finite avg_logprob values, or null when there are none. */
export function meanLogprob(values: readonly (number | undefined)[]): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  return finite.length === 0 ? null : finite.reduce((a, b) => a + b, 0) / finite.length
}

export class LanguageLock {
  private current: LockedLanguage | null = null
  private clipsSinceDetection = 0
  private uncertain = false

  get language(): LockedLanguage | null {
    return this.current
  }

  reset(): void {
    this.current = null
    this.clipsSinceDetection = 0
    this.uncertain = false
  }

  /** Should this clip (of `audioMs`) be sent with language "auto" and probabilities requested? */
  needsDetection(audioMs: number): boolean {
    if (this.current === null) return true
    if (audioMs < LANGUAGE_MIN_DETECT_MS) return false
    return this.uncertain || this.clipsSinceDetection >= LANGUAGE_REDETECT_EVERY_CLIPS
  }

  /** Record a detection result. */
  settle(language: LockedLanguage, margin: number): void {
    this.current = language
    this.clipsSinceDetection = 0
    this.uncertain = margin < LANGUAGE_MIN_MARGIN
  }

  /** Record a decoded clip: its mean avg_logprob (null when unknown), and whether it was the detection clip itself. */
  noteClip(meanAvgLogprob: number | null, wasDetection: boolean): void {
    if (!wasDetection) this.clipsSinceDetection += 1
    // Only a new detection (settle) clears the doubt.
    if (meanAvgLogprob !== null && meanAvgLogprob < LANGUAGE_LOW_LOGPROB) this.uncertain = true
  }
}
