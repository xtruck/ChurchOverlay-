import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"

type ContextAwareProvider = AsrProvider & {
  setCurrentVerseRef?(reference: string | null): void
  setLanguage?(language: string | undefined): void
  onError?(callback: (error: Error) => void): void
  onRateLimitedSustained?(callback: () => void): void
  discardBufferedAudio?(): void
}

export type FailoverAsrProviderOptions = {
  readonly primary: ContextAwareProvider
  readonly secondary: ContextAwareProvider
}

/**
 * Keeps Groq as the normal provider and opens Deepgram only after sustained
 * Groq 429s. The primary's in-flight/buffered batch is deliberately abandoned
 * at failover rather than converted into a streaming frame sequence.
 */
export class FailoverAsrProvider implements AsrProvider {
  private readonly primary: ContextAwareProvider
  private readonly secondary: ContextAwareProvider
  private activeProvider: ContextAwareProvider
  private currentVerseRef: string | null = null
  private switching = false
  private activationPromise: Promise<void> | null = null
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null
  private failoverCallback: (() => void) | null = null

  constructor(options: FailoverAsrProviderOptions) {
    this.primary = options.primary
    this.secondary = options.secondary
    this.activeProvider = this.primary

    this.primary.onTranscript((result) => {
      if (this.activeProvider === this.primary) this.transcriptCallback?.(result)
    })
    this.secondary.onTranscript((result) => {
      if (this.activeProvider === this.secondary) this.transcriptCallback?.(result)
    })
    this.primary.onError?.((error) => {
      if (this.activeProvider === this.primary) this.errorCallback?.(error)
    })
    this.secondary.onError?.((error) => {
      if (this.activeProvider === this.secondary) this.errorCallback?.(error)
    })
    this.primary.onRateLimitedSustained?.(() => {
      void this.activateFailover()
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

  onFailoverActivated(callback: () => void): void {
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
    await this.primary.start()
    this.primary.setCurrentVerseRef?.(this.currentVerseRef)
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    if (this.activationPromise) await this.activationPromise
    await this.activeProvider.sendAudio(audio)
  }

  async stop(): Promise<void> {
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
    try {
      await this.secondary.start()
      this.secondary.setCurrentVerseRef?.(this.currentVerseRef)
      this.activeProvider = this.secondary
      this.failoverCallback?.()
    } catch (error) {
      this.switching = false
      this.errorCallback?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    this.switching = false
  }
}
