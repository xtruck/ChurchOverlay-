import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { generateUlid } from "../../../packages/shared/ulid"

export type DryRunAsrProviderOptions = {
  readonly now?: () => number
}

/**
 * ARCHITECTURE.md section 44's "Dry-Run Mode" as a real, shipped AsrProvider
 * — not a test double (AGENTS.md section 45 is about naming FakeX/StubX in
 * *tests*; this is a legitimate second implementation of the one extension
 * seam AsrProvider already is, per section 50, used to satisfy a documented
 * v1 requirement: "The application must support deterministic testing
 * without microphone or external ASR").
 *
 * start()/stop()/sendAudio() are no-ops: dry-run mode has no microphone and
 * sends no audio anywhere. emitText() is the substitute for real speech —
 * it goes straight from typed/piped text to a "final" TranscriptResult,
 * exactly matching section 44's diagram (Dry Run -> Synthetic Transcript ->
 * Detector -> Validation -> Verse Source -> Overlay). Every other stage of
 * the pipeline (RegexDetector, KnownValidVerseIndex, the real VerseSource,
 * WS broadcast) runs unmodified — only ASR itself is bypassed.
 */
export class DryRunAsrProvider implements AsrProvider {
  private readonly now: () => number
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private sequence = 0

  constructor(options: DryRunAsrProviderOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {}

  async sendAudio(_audio: AudioFrame): Promise<void> {}

  async stop(): Promise<void> {}

  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }

  /** Injects synthetic speech as if ASR had just finished transcribing it. */
  emitText(text: string): void {
    this.sequence += 1
    this.transcriptCallback?.({
      id: generateUlid(),
      correlationId: generateUlid(),
      sequence: this.sequence,
      text,
      state: "final",
      timestamp: this.now(),
    })
  }
}
