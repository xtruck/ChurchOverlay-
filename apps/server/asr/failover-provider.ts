import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"

type ContextAwareProvider = AsrProvider & {
  setCurrentVerseRef?(reference: string | null): void
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

export type FailoverAsrProviderOptions = {
  readonly primary: ContextAwareProvider
  readonly secondary: ContextAwareProvider
  readonly trigger?: FailoverTrigger
  /** Human-readable name of the secondary, surfaced in the failover status (e.g. "Deepgram", "Groq"). */
  readonly secondaryLabel?: string
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
  private switching = false
  private running = false
  private activationPromise: Promise<void> | null = null
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null
  private failoverCallback: ((label: string) => void) | null = null

  constructor(options: FailoverAsrProviderOptions) {
    this.primary = options.primary
    this.secondary = options.secondary
    this.trigger = options.trigger ?? "sustained-rate-limit"
    this.secondaryLabel = options.secondaryLabel ?? "Deepgram"
    this.activeProvider = this.primary

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

  setCurrentVerseRef(reference: string | null): void {
    this.currentVerseRef = reference
    this.activeProvider.setCurrentVerseRef?.(reference)
  }

  setLanguage(language: string | undefined): void {
    this.primary.setLanguage?.(language)
    this.secondary.setLanguage?.(language)
  }

  async start(): Promise<void> {
    this.activeProvider = this.primary
    this.switching = false
    this.running = true
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
    await this.activeProvider.onUtteranceEnd?.()
  }

  async stop(): Promise<void> {
    this.running = false
    this.switching = false
    await this.secondary.stop()
    await this.primary.stop()
  }

  async returnToPrimary(): Promise<void> {
    if (this.activeProvider === this.primary && !this.switching) return
    this.switching = true
    await this.secondary.stop()
    await this.primary.start()
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
      this.failoverCallback?.(this.secondaryLabel)
    } catch (error) {
      this.switching = false
      this.errorCallback?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    this.switching = false
  }
}
