import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { GroqProvider } from "./groq-provider"
import { DryRunAsrProvider } from "./dry-run-provider"

export type HybridAsrProviderOptions = {
  /** Absent/empty is a valid starting state — see setApiKey(). */
  readonly apiKey?: string
  readonly logger?: Logger
  // Passed straight through to the real GroqProvider whenever one is
  // (re)constructed, so tests can inject a fake fetchImpl/clock the same
  // way groq-provider.test.ts already does for GroqProvider directly —
  // HybridAsrProvider itself makes no network calls, GroqProvider does.
  readonly fetchImpl?: typeof fetch
  readonly model?: string
  readonly chunkDurationMs?: number
  readonly now?: () => number
  /** ARCHITECTURE.md section 81 — passed straight through to GroqProvider; see its own doc comment. */
  readonly language?: string
}

/**
 * ARCHITECTURE.md section 80: the web-server deployment's ASR provider —
 * "hybrid" in that it always offers DryRunAsrProvider's synthetic-text
 * injection (section 44 — deterministic testing without a microphone),
 * *and*, once a Groq API key is configured, real audio transcription via
 * GroqProvider, through the exact same AsrProvider surface AppCore
 * already knows how to drive. Neither capability replaces the other:
 * emitText() works identically whether or not a real key is set, exactly
 * like DryRunAsrProvider on its own does — this class adds real
 * transcription alongside it, not instead of it.
 *
 * Exists because the desktop app's own setup flow constructs a fresh
 * AppCore only once a Groq key is already known (ConfigStore's
 * completeSetup), but the web server (server.ts) starts AppCore
 * immediately at boot, before any key may have been entered yet — this
 * provider has to tolerate "no key configured" as a normal starting
 * state and let one arrive later via setApiKey(), without AppCore itself
 * needing to know that distinction.
 */
export class HybridAsrProvider implements AsrProvider {
  private readonly logger?: Logger
  private readonly fetchImpl?: typeof fetch
  private readonly model?: string
  private readonly chunkDurationMs?: number
  private readonly now?: () => number
  private language?: string

  private readonly dryRun: DryRunAsrProvider
  private real: GroqProvider | null = null
  private active = false

  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null

  constructor(options: HybridAsrProviderOptions = {}) {
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl
    this.model = options.model
    this.chunkDurationMs = options.chunkDurationMs
    this.now = options.now
    this.language = options.language

    // Always available, regardless of whether a real key is ever set —
    // dry-run testing must not depend on Groq configuration.
    this.dryRun = new DryRunAsrProvider(options.now ? { now: options.now } : {})
    this.dryRun.onTranscript((result) => this.transcriptCallback?.(result))

    if (options.apiKey) this.setApiKey(options.apiKey)
  }

  /**
   * (Re)configures the real Groq-backed half. An empty/whitespace-only
   * key clears it — hasRealProvider() becomes false, sendAudio() becomes
   * a no-op again, matching the "no key configured" starting state
   * exactly rather than leaving a stale provider behind. If the mic is
   * currently active when the key changes, the new provider is started
   * immediately so an operator doesn't have to stop/start the mic again
   * just because they entered a key mid-session.
   */
  setApiKey(apiKey: string): void {
    const trimmed = apiKey.trim()
    if (this.real && this.active) {
      this.real.stop().catch(() => {})
    }
    if (!trimmed) {
      this.real = null
      return
    }

    this.real = new GroqProvider({
      apiKey: trimmed,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      model: this.model,
      chunkDurationMs: this.chunkDurationMs,
      now: this.now,
      language: this.language,
    })
    this.real.onTranscript((result) => this.transcriptCallback?.(result))
    this.real.onError((err) => this.errorCallback?.(err))

    if (this.active) {
      this.real.start().catch((err) => {
        this.errorCallback?.(err instanceof Error ? err : new Error(String(err)))
      })
    }
  }

  /** Whether real (Groq) transcription is currently configured — the web server's /api/status exposes this as hasGroqKey. */
  hasRealProvider(): boolean {
    return this.real !== null
  }

  /** ARCHITECTURE.md section 81 — retargets the real provider immediately if one exists, and is remembered for the next setApiKey() if not. */
  setLanguage(language: string | undefined): void {
    this.language = language
    this.real?.setLanguage(language)
  }

  async start(): Promise<void> {
    this.active = true
    if (this.real) await this.real.start()
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    if (this.real) await this.real.sendAudio(audio)
  }

  async stop(): Promise<void> {
    this.active = false
    if (this.real) await this.real.stop()
  }

  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }

  /** Beyond the AsrProvider interface, same duck-typed pattern GroqProvider's own onError already establishes. */
  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback
  }

  /** The dry-run half (section 44) — injects synthetic speech regardless of whether a real provider is configured. */
  emitText(text: string): void {
    this.dryRun.emitText(text)
  }
}
