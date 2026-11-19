import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"

type ContextAwareProvider = AsrProvider & {
  setCurrentVerseRef?(reference: string | null): void
  setPlannedBooks?(bookIds: readonly string[]): void
  setLanguage?(language: string | undefined): void
  onError?(callback: (error: Error) => void): void
  onRateLimitedSustained?(callback: () => void): void
  /** A refused API key (401/403) will not heal by retrying: fail over at once (SF-05). */
  onKeyRefused?(callback: () => void): void
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

/**
 * Backoff between failed attempts to open the secondary (TS-02). Without it
 * every audio frame retried the whole activation (secondary.start, primary.stop,
 * an error broadcast) 50 times a second.
 */
export const DEFAULT_ACTIVATION_RETRY_INITIAL_MS = 2_000
export const DEFAULT_ACTIVATION_RETRY_MAX_MS = 60_000

export type SecondaryUnavailableState = {
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly lastError: string
  readonly framesDropped: number
}

export type FailoverAsrProviderOptions = {
  readonly primary: ContextAwareProvider
  readonly secondary: ContextAwareProvider
  readonly trigger?: FailoverTrigger
  /** Human-readable name of the secondary, surfaced in the failover status (e.g. "Deepgram", "Groq"). */
  readonly secondaryLabel?: string
  /** Only honored with trigger "primary-error". Absent = manual return only. */
  readonly autoReturn?: AutoReturnOptions
  /** Backoff for re-opening a secondary that failed to start. Clock injectable for tests. */
  readonly activationRetry?: { readonly initialDelayMs?: number; readonly maxDelayMs?: number; readonly now?: () => number }
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
  private primaryLive = false
  private secondaryLive = false
  private secondaryDown: { attempts: number; nextAttemptAt: number; lastError: string; framesDropped: number; reported: boolean; primaryRestarted?: boolean } | null = null
  private unavailableCallback: ((state: SecondaryUnavailableState) => void) | null = null
  private readonly retryInitialMs: number
  private readonly retryMaxMs: number
  private readonly clock: () => number

  constructor(options: FailoverAsrProviderOptions) {
    this.retryInitialMs = options.activationRetry?.initialDelayMs ?? DEFAULT_ACTIVATION_RETRY_INITIAL_MS
    this.retryMaxMs = options.activationRetry?.maxDelayMs ?? DEFAULT_ACTIVATION_RETRY_MAX_MS
    this.clock = options.activationRetry?.now ?? Date.now
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
      // SF-07/SF-11: activateFailover rethrows when the secondary cannot start;
      // a floating rejection here would be an unhandled rejection in main.
      if (this.trigger === "sustained-rate-limit") this.failOverQuietly()
    })
    this.primary.onKeyRefused?.(() => {
      if (this.trigger === "sustained-rate-limit") this.failOverQuietly()
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

  /**
   * Fired ONCE per outage when the secondary could not be opened after the
   * primary failed: nothing is transcribing until a retry succeeds.
   */
  onSecondaryUnavailable(callback: (state: SecondaryUnavailableState) => void): void {
    this.unavailableCallback = callback
  }

  /** Non-null while a failover could not open the secondary and retries are backing off. */
  secondaryUnavailable(): SecondaryUnavailableState | null {
    const d = this.secondaryDown
    return d ? { attempts: d.attempts, nextAttemptAt: d.nextAttemptAt, lastError: d.lastError, framesDropped: d.framesDropped } : null
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
    // SF-21: a start() while the secondary is on air (the dashboard re-sends
    // mic:start on a WS reconnect) used to flip activeProvider back to the
    // primary without stopping the secondary, leaking its socket.
    if (this.activationPromise) await this.activationPromise.catch(() => {})
    if (this.returning) await this.returning.catch(() => {})
    if (this.secondaryLive) {
      this.secondaryLive = false
      await this.secondary.stop().catch(() => {})
    }
    this.activeProvider = this.primary
    this.switching = false
    this.running = true
    this.lastReturnAt = null
    this.secondaryDown = null
    this.primaryLive = true
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
    // A failed activation is already reported (once) by openSecondary; the
    // frames waiting behind it must not each rethrow it.
    if (this.activationPromise) await this.activationPromise.catch(() => {})
    // A return is mid-flight: the secondary is stopped and the primary not
    // yet live. Wait (bounded by the primary's connect timeout) rather than
    // throw into a stopped provider.
    if (this.returning) await this.returning.catch(() => {})
    if (this.trigger === "primary-error" && this.secondaryDown && !this.secondaryDown.primaryRestarted && this.running) {
      // Nothing is live. Frames are dropped (counted) while the retry backs
      // off; at most one activation attempt is in flight (TS-02).
      if (this.clock() < this.secondaryDown.nextAttemptAt) {
        this.secondaryDown.framesDropped += 1
        return
      }
      await this.retryAfterOutage()
      if (this.secondaryDown && !this.secondaryDown.primaryRestarted) {
        this.secondaryDown.framesDropped += 1
        return
      }
    }
    const provider = this.activeProvider
    try {
      await provider.sendAudio(audio)
      if (this.secondaryDown?.primaryRestarted && provider === this.primary) this.secondaryDown = null
    } catch (error) {
      if (this.trigger !== "primary-error" || provider !== this.primary || !this.running) throw error
      try {
        await this.activateFailover()
      } catch {
        // Reported once by openSecondary; the backoff state now governs retries.
        if (this.secondaryDown) this.secondaryDown.framesDropped += 1
        return
      }
      await this.activeProvider.sendAudio(audio)
    }
  }

  /**
   * Backoff elapsed with nothing live: try the secondary again and, failing
   * that, give the primary (which may have recovered) one restart.
   */
  private async retryAfterOutage(): Promise<void> {
    try {
      await this.activateFailover()
      return
    } catch {
      // still down; fall through to the primary
    }
    if (!this.running || !this.secondaryDown) return
    try {
      this.primaryLive = true
      await this.primary.start()
      this.primary.setCurrentVerseRef?.(this.currentVerseRef)
      this.activeProvider = this.primary
      // Not cleared yet: a primary that "starts" but cannot carry audio must
      // keep its backoff and its single report. A successful send clears it.
      this.secondaryDown.primaryRestarted = true
    } catch {
      this.primaryLive = false
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
    // A failover still opening the secondary would finish starting it AFTER this
    // stop and leave it live (a Deepgram secondary would leak its socket). Wait for
    // it; openSecondary() already reports the secondary's own failure.
    if (this.activationPromise) await this.activationPromise.catch(() => {})
    // Let an in-flight return settle first so it cannot leave the primary started after stop().
    if (this.returning) await this.returning.catch(() => {})
    this.switching = false
    this.secondaryDown = null
    this.secondaryLive = false
    this.primaryLive = false
    try {
      await this.secondary.stop()
    } finally {
      // A throwing secondary must not leave the primary running.
      await this.primary.stop()
    }
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
    this.secondaryLive = false
    try {
      this.primaryLive = true
      await this.primary.start()
    } catch (error) {
      // The primary is still unreachable. Without this rollback the secondary
      // stays stopped while activeProvider still points at it, so every later
      // sendAudio() throws "called before start()" and transcription is dead
      // until the operator cycles the mic. Put the secondary back on air and
      // surface the primary's failure to the caller.
      this.primaryLive = false
      try {
        await this.secondary.start()
        this.secondaryLive = true
        this.secondary.setCurrentVerseRef?.(this.currentVerseRef)
        this.activeProvider = this.secondary
      } catch (restartError) {
        // SF-21: both sides are down. Pointing activeProvider at the stopped
        // secondary made every frame throw; use the outage state instead
        // (reported once, bounded retries, frames counted as dropped).
        this.activeProvider = this.primary
        this.markSecondaryDown(restartError instanceof Error ? restartError : new Error(String(restartError)))
      }
      this.switching = false
      throw error
    }
    this.primary.setCurrentVerseRef?.(this.currentVerseRef)
    this.activeProvider = this.primary
    this.switching = false
  }

  /** Records a failed secondary start: exponential backoff, reported to the operator once per outage. */
  private markSecondaryDown(error: Error): void {
    const prev = this.secondaryDown
    const attempts = (prev?.attempts ?? 0) + 1
    const delay = Math.min(this.retryInitialMs * 2 ** Math.min(attempts - 1, 30), this.retryMaxMs)
    const reported = prev?.reported ?? false
    this.secondaryDown = {
      attempts,
      nextAttemptAt: this.clock() + delay,
      lastError: error.message,
      framesDropped: prev?.framesDropped ?? 0,
      reported: true,
    }
    if (!reported) {
      this.errorCallback?.(error)
      const state = this.secondaryUnavailable()
      if (state) this.unavailableCallback?.(state)
    }
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
    const down = this.secondaryDown
    if (down && this.clock() < down.nextAttemptAt) {
      throw new Error(`Backup transcription unavailable (${down.lastError}); next attempt in ${Math.ceil((down.nextAttemptAt - this.clock()) / 1000)}s`)
    }
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
    if (this.trigger === "primary-error" && this.primaryLive) {
      // The primary is broken, not merely throttled: release it so a later
      // manual returnToPrimary() starts it from a clean state. Once only per
      // outage: a retry must not stop it again.
      this.primaryLive = false
      await this.primary.stop().catch(() => {})
    }
    try {
      this.secondaryLive = true
      await this.secondary.start()
      this.secondary.setCurrentVerseRef?.(this.currentVerseRef)
      this.activeProvider = this.secondary
      this.secondaryDown = null
      this.scheduleAutoReturn()
      this.failoverCallback?.(this.secondaryLabel)
    } catch (error) {
      this.activeProvider = this.primary
      this.switching = false
      // A half-opened secondary (Deepgram socket) must not leak.
      await this.secondary.stop().catch(() => {})
      this.secondaryLive = false
      this.markSecondaryDown(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    this.switching = false
  }
}
