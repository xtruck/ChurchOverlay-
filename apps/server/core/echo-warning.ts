/**
 * ARCHITECTURE.md section 132: a non-blocking warning for the operator when the
 * laptop seems to be hearing its own output (a video or song played through the
 * room speakers and picked up again by the microphone).
 *
 * It only ever OBSERVES. It never mutes, drops or changes a transcript: every
 * transcript is still delivered exactly as before. The result is one optional
 * field on the existing status:update event, shown on the dashboard.
 *
 * Two independent signals:
 *   - "media-loud": a video/audio cue is playing while the mic stays at speech
 *     level for MEDIA_LOUD_MS in a row.
 *   - "repeated-sentence": the same sentence is transcribed twice within
 *     REPEAT_WINDOW_MS.
 *
 * Pure bookkeeping, no timers and no I/O: AppCore feeds it observations and
 * reads current() at its own cadence. The thresholds are reasoned, not
 * measured against a real mixer, and will need tuning after a real service.
 */
export type EchoReason = "media-loud" | "repeated-sentence"

export type EchoWarning = {
  readonly reason: EchoReason
  /** Wall-clock ms when this warning episode started. */
  readonly since: number
}

/** The mic must stay at speech level this long, while media plays, before warning. */
export const MEDIA_LOUD_MS = 5000
/** The same sentence twice inside this window counts as an echo. */
export const REPEAT_WINDOW_MS = 1500
/** A warning stays up this long after the last trigger, so it does not flicker. */
export const HOLD_MS = 8000
/** Shorter sentences ("amen", "oui oui") repeat naturally and are never evidence. */
export const MIN_REPEAT_WORDS = 4
/** Bound on remembered sentences (AGENTS.md section 36). */
const MAX_RECENT = 8

export function normalizeSentence(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export class EchoWatch {
  private loudSince: number | null = null
  private recent: { readonly text: string; readonly at: number }[] = []
  private active: EchoWarning | null = null
  private lastTriggerAt = 0
  private episodes = 0

  /**
   * One reading of the mic (about once a second while the mic is on).
   * `speechAtLevel` is true when speech is currently detected at a usable
   * level; `mediaPlaying` is true while a video/audio cue is playing.
   */
  observeMic(now: number, speechAtLevel: boolean, mediaPlaying: boolean): void {
    if (mediaPlaying && speechAtLevel) {
      if (this.loudSince === null) this.loudSince = now
      if (now - this.loudSince >= MEDIA_LOUD_MS) this.trigger("media-loud", now)
    } else {
      this.loudSince = null
    }
  }

  /** A final transcript arrived. Returns nothing: the transcript is never altered. */
  observeFinalTranscript(now: number, text: string): void {
    const normalized = normalizeSentence(text)
    if (normalized.split(" ").length < MIN_REPEAT_WORDS) return
    this.recent = this.recent.filter((entry) => now - entry.at <= REPEAT_WINDOW_MS)
    if (this.recent.some((entry) => entry.text === normalized)) this.trigger("repeated-sentence", now)
    this.recent.push({ text: normalized, at: now })
    if (this.recent.length > MAX_RECENT) this.recent.shift()
  }

  /** The warning to show right now, or null. Expires HOLD_MS after the last trigger. */
  current(now: number): EchoWarning | null {
    if (this.active !== null && now - this.lastTriggerAt > HOLD_MS) this.active = null
    return this.active
  }

  /** The mic stopped: nothing is being heard any more. */
  reset(): void {
    this.loudSince = null
    this.recent = []
    this.active = null
  }

  /** Distinct warning episodes since the app started (for the service report). */
  episodeCount(): number {
    return this.episodes
  }

  private trigger(reason: EchoReason, now: number): void {
    // A new episode starts only when none is still showing; a continuing one just stays up.
    const showing = this.current(now)
    this.lastTriggerAt = now
    if (showing === null) {
      this.active = { reason, since: now }
      this.episodes += 1
    }
  }
}
