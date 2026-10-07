import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"

type ContextAwareProvider = AsrProvider & {
  setCurrentVerseRef?(reference: string | null): void
  setPlannedBooks?(bookIds: readonly string[]): void
  setLanguage?(language: string | undefined): void
  onError?(callback: (error: Error) => void): void
  onRateLimitedSustained?(callback: () => void): void
  discardBufferedAudio?(): void
  onUtteranceEnd?(): Promise<void>
  onFailoverActivated?(callback: (label: string) => void): void
}

/**
 * What makes the wrapper leave its primary provider:
 * - "sustained-rate-limit": batch-first (Groq primary). Only sustained 429s
 *   switch; ordinary errors are reported and Groq keeps being used.
 * - "primary-error": streaming-first (Deepgram primary). A dropped socket,
 *   a failed connect or a failed send switches to the batch secondary, so
 *   a network hiccup mid-sermon degrades to slower transcription instead
 *   of no transcription.
 */
export type FailoverTrigger = "sustained-rate-limit" | "primary-error"

/**
 * Automatic return to the primary after a "primary-error" failover
 * (ARCHITECTURE.md section 115). Attempts are made only at an utterance
 * boundary, back off exponentially, and are ignored for the
 * "sustained-rate-limit" trigger (section 86: the operator decides there).
 */
export type AutoReturnOptions = {
  /** First wait after a failover. Default 30 s. */
  readonly initialDelayMs?: number
  /** Backoff ceiling, also the stability window. Default 300 s. */
  readonly maxDelayMs?: number
  /** Injectable clock for tests. Default Date.now. */
  readonly now?: () => number
  /** Observability hook: one call per attempt (failures are otherwise silent by design). */
  readonly onAttempt?: (result: { readonly ok: boolean; readonly nextDelayMs?: number; readonly error?: Error }) => void
}

export const DEFAULT_AUTO_RETURN_INITIAL_MS = 30_000
export const DEFAULT_AUTO_RETURN_MAX_MS = 300_000

export type FailoverAsrProviderOptions = {
  readonly primary: ContextAwareProvider
  readonly secondary: ContextAwareProvider
  readonly trigger?: FailoverTrigger
  /** Human-readable name of the secondary, surfaced in the failover status (e.g. "Deepgram", "Groq"). */
  readonly secondaryLabel?: string
  /** Only honored with trigger "primary-error". Absent = manual return only. */
  readonly autoReturn?: AutoReturnOptions
}

/**
 * Keeps one provider as the normal path and opens the other only on
 * demand. The primary's in-flight/buffered audio is deliberately abandoned
 * at failover rather than replayed into the secondary.
 */
export class FailoverAsrProvider implements AsrProvider {
  private readonly primary: ContextAwareProvider
  private readonly secondary: ContextAwareProvider
  private readonly trigger: FailoverTrigger
  readonly secondaryLabel: string
  private activeProvider: ContextAwareProvider
  private currentVerseRef: string | null = null
  private plannedBookIds: readonly string[] = []
  private switching = false
  private running = false
  private activationPromise: Promise<void> | null = null
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null
  private failoverCallback: ((label: string) => void) | null = null
  private autoReturnedCallback: (() => void) | null = null
  private returning: Promise<void> | null = null
  private readonly autoReturn: Required<Omit<AutoReturnOptions, "onAttempt">> & Pick<AutoReturnOptions, "onAttempt"> | null
  private returnDelayMs = 0
  private nextReturnAt = 0
  private lastReturnAt: number | null = null

  constructor(options: FailoverAsrProviderOptions) {
    this.primary = options.primary
    this.secondary = options.secondary
    this.trigger = options.trigger ?? "sustained-rate-limit"
    this.secondaryLabel = options.secondaryLabel ?? "Deepgram"
    this.activeProvider = this.primary
    this.autoReturn =
      options.autoReturn && this.trigger === "primary-error"
        ? {
            initialDelayMs: options.autoReturn.initialDelayMs ?? DEFAULT_AUTO_RETURN_INITIAL_MS,
            maxDelayMs: options.autoReturn.maxDelayMs ?? DEFAULT_AUTO_RETURN_MAX_MS,
            now: options.autoReturn.now ?? Date.now,
            onAttempt: options.autoReturn.onAttempt,
          }
        : null

    this.primary.onTranscript((result) => {
      if (this.activeProvider === this.primary) this.transcriptCallback?.(result)
    })
    this.secondary.onTranscript((result) => {
      if (this.activeProvider === this.secondary) this.transcriptCallback?.(result)
    })
    this.primary.onError?.((error) => {
      if (this.activeProvider !== this.primary) return
      if (this.trigger === "primary-error" && this.running) {
        this.failOverQuietly()
        return
      }
      this.errorCallback?.(error)
    })
    this.secondary.onError?.((error) => {
      if (this.activeProvider === this.secondary) this.errorCallback?.(error)
    })
    this.primary.onRateLimitedSustained?.(() => {
      if (this.trigger === "sustained-rate-limit") void this.activateFailover()
    })
    // Chains nest (Deepgram → [Groq → local]): a switch deeper in the chain
    // must still reach the operator's status line.
    this.secondary.onFailoverActivated?.((label) => {
      if (this.activeProvider === this.secondary) this.failoverCallback?.(label)
    })
    this.primary.onFailoverActivated?.((label) => {
      if (this.activeProvider === this.primary) this.failoverCallback?.(label)
    })
  }

  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback
  }

  onRateLimitedSustained(callback: () => void): void {
    // The wrapper exposes successful failover separately. A raw 429 is not
    // surfaced as a critical state when the secondary provider is available.
    void callback
  }

  onFailoverActivated(callback: (label: string) => void): void {
    this.failoverCallback = callback
  }

  /** Fired after an AUTOMATIC return to the primary succeeds, so the dashboard can drop its failover state. */
  onAutoReturned(callback: () => void): void {
    this.autoReturnedCallback = callback
  }

  setCurrentVerseRef(reference: string | null): void {
    this.currentVerseRef = reference
    this.activeProvider.setCurrentVerseRef?.(reference)
  }

  /** Stored and forwarded to both sides (matching setLanguage below) — whichever provider is active when a connection is next opened applies it. */
  setPlannedBooks(bookIds: readonly string[]): void {
    this.plannedBookIds = bookIds
    this.primary.setPlannedBooks?.(bookIds)
    this.secondary.setPlannedBooks?.(bookIds)
  }

  setLanguage(language: string | undefined): void {
    this.primary.setLanguage?.(language)
    this.secondary.setLanguage?.(language)
  }

  async start(): Promise<void> {
    this.activeProvider = this.primary
    this.switching = false
    this.running = true
    this.lastReturnAt = null
    try {
      await this.primary.start()
    } catch (error) {
      if (this.trigger !== "primary-error") throw error
      // Streaming-first: an unreachable Deepgram at mic start must not
      // leave the operator with a dead mic — start on the secondary.
      await this.activateFailover()
      return
    }
    this.primary.setCurrentVerseRef?.(this.currentVerseRef)
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    if (this.activationPromise) await this.activationPromise
    // A return is mid-flight: the secondary is stopped and the primary not
    // yet live. Wait (bounded by the primary's connect timeout) rather than
    // throw into a stopped provider.
    if (this.returning) await this.returning.catch(() => {})
    const provider = this.activeProvider
    try {
      await provider.sendAudio(audio)
    } catch (error) {
      if (this.trigger !== "primary-error" || provider !== this.primary || !this.running) throw error
      await this.activateFailover()
      await this.activeProvider.sendAudio(audio)
    }
  }

  /**
   * Forwarded to whichever provider is live: GroqProvider flushes its batch
   * buffer, DeepgramProvider sends Finalize. Before this existed, wrapping
   * Groq in a failover silently lost utterance-aligned flushing (Groq fell
   * back to fixed chunk boundaries that cut words mid-reference).
   */
  async onUtteranceEnd(): Promise<void> {
    if (this.activationPromise) await this.activationPromise
    if (this.returning) await this.returning.catch(() => {})
    await this.activeProvider.onUtteranceEnd?.()
    await this.maybeAutoReturn()
  }

  async stop(): Promise<void> {
    this.running = false
    // Let an in-flight return settle first so it cannot leave the primary started after stop().
    if (this.returning) await this.returning.catch(() => {})
    this.switching = false
    await this.secondary.stop()
    await this.primary.stop()
  }

  async returnToPrimary(): Promise<void> {
    if (this.returning) return this.returning
    if (this.activeProvider === this.primary && !this.switching) return
    const attempt = this.doReturnToPrimary()
    this.returning = attempt
    try {
      await attempt
    } finally {
      if (this.returning === attempt) this.returning = null
    }
  }

  /**
   * Utterance boundary reached and the live provider has just flushed it, so
   * no speech is cut. A failure leaves the secondary on air (rollback in
   * doReturnToPrimary) and is deliberately not an operator error: the
   * secondary is working, and the outcome is reported through onAttempt.
   */
  private async maybeAutoReturn(): Promise<void> {
    const auto = this.autoReturn
    if (!auto || !this.running) return
    if (this.activeProvider !== this.secondary || this.switching || this.returning || this.activationPromise) return
    if (auto.now() < this.nextReturnAt) return
    try {
      await this.returnToPrimary()
    } catch (error) {
      this.returnDelayMs = Math.min(this.returnDelayMs * 2, auto.maxDelayMs)
      this.nextReturnAt = auto.now() + this.returnDelayMs
      auto.onAttempt?.({ ok: false, nextDelayMs: this.returnDelayMs, error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    this.lastReturnAt = auto.now()
    auto.onAttempt?.({ ok: true })
    if (this.running) this.autoReturnedCallback?.()
  }

  /** Called when the secondary has just taken over: pick the wait before the next return attempt. */
  private scheduleAutoReturn(): void {
    const auto = this.autoReturn
    if (!auto) return
    const now = auto.now()
    // A primary that dies again soon after a return keeps doubling instead of flapping every 30 s.
    const flapping = this.lastReturnAt !== null && now - this.lastReturnAt < auto.maxDelayMs
    this.returnDelayMs = flapping ? Math.min(this.returnDelayMs * 2, auto.maxDelayMs) : auto.initialDelayMs
    this.nextReturnAt = now + this.returnDelayMs
  }

  private async doReturnToPrimary(): Promise<void> {
    this.switching = true
    // A throwing stop() must not leave `switching` stuck (auto-return runs
    // unattended): the secondary is restarted below if the primary fails.
    await this.secondary.stop().catch(() => {})
    try {
      await this.primary.start()
    } catch (error) {
      // The primary is still unreachable. Without this rollback the secondary
      // stays stopped while activeProvider still points at it, so every later
      // sendAudio() throws "called before start()" and transcription is dead
      // until the operator cycles the mic. Put the secondary back on air and
      // surface the primary's failure to the caller.
      try {
        await this.secondary.start()
        this.secondary.setCurrentVerseRef?.(this.currentVerseRef)
      } catch (restartError) {
        this.errorCallback?.(restartError instanceof Error ? restartError : new Error(String(restartError)))
      }
      this.activeProvider = this.secondary
      this.switching = false
      throw error
    }
    this.primary.setCurrentVerseRef?.(this.currentVerseRef)
    this.activeProvider = this.primary
    this.switching = false
  }

  isFailedOver(): boolean {
    return this.activeProvider === this.secondary || this.switching
  }

  /** "primary" or "secondary" — which side is carrying audio right now (dashboard diagnostics). */
  activeSide(): "primary" | "secondary" {
    return this.activeProvider === this.secondary ? "secondary" : "primary"
  }

  private failOverQuietly(): void {
    this.activateFailover().catch(() => {
      // openSecondary() already reported the secondary's own failure.
    })
  }

  private async activateFailover(): Promise<void> {
    if (this.activeProvider === this.secondary) return
    if (this.activationPromise) return this.activationPromise
    this.activationPromise = this.openSecondary()
    try {
      await this.activationPromise
    } finally {
      this.activationPromise = null
    }
  }

  private async openSecondary(): Promise<void> {
    if (this.activeProvider === this.secondary) return
    this.switching = true
    this.primary.discardBufferedAudio?.()
    if (this.trigger === "primary-error") {
      // The primary is broken, not merely throttled: release it so a later
      // manual returnToPrimary() starts it from a clean state.
      await this.primary.stop().catch(() => {})
    }
    try {
      await this.secondary.start()
      this.secondary.setCurrentVerseRef?.(this.currentVerseRef)
      this.activeProvider = this.secondary
      this.scheduleAutoReturn()
      this.failoverCallback?.(this.secondaryLabel)
    } catch (error) {
      this.activeProvider = this.primary
      this.switching = false
      this.errorCallback?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    this.switching = false
  }
}
