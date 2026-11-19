/**
 * Warnings that make a deaf app visibly different from a quiet room.
 *
 *  - "no-transcripts": audio has been sent to the ASR for a long time and the
 *    provider has produced nothing at all (not even a transcript that a guard
 *    later dropped). The engine, key, network or language setup is deaf.
 *  - "gate-closed-loud": the input has been loud for a long time while the gate
 *    keeps rejecting it. Either it is music or crowd noise (fine), or the
 *    gate is shutting out the speaker (not fine): the operator must be able to tell.
 *  - "language-guard-bypassed": a provider's language guard dropped so many
 *    transcripts in a row that it stopped dropping.
 *
 * Time is measured in AUDIO milliseconds (frames processed), so it is
 * deterministic in tests and silent when nothing flows. No I/O, no timers.
 */
export type MicWarning = "no-transcripts" | "gate-closed-loud" | "language-guard-bypassed"

/** Forwarded audio with no transcript at all, after which "no-transcripts" is raised (~30 s). */
export const NO_TRANSCRIPT_WARN_MS = 30_000
/** Loud input rejected by the gate for this long raises "gate-closed-loud". */
export const GATE_CLOSED_LOUD_WARN_MS = 20_000

export class MicDiagnostics {
  private forwardedMsSinceTranscript = 0

  /** A frame was forwarded to the ASR. */
  observeForwarded(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.forwardedMsSinceTranscript += ms
  }

  /** The provider produced a transcript (partial or final, before any guard drops it). */
  observeTranscript(): void {
    this.forwardedMsSinceTranscript = 0
  }

  /** New session. */
  reset(): void {
    this.forwardedMsSinceTranscript = 0
  }

  evaluate(input: { readonly loudClosedMs: number; readonly openValves: readonly string[] }): MicWarning[] {
    const warnings: MicWarning[] = []
    if (this.forwardedMsSinceTranscript >= NO_TRANSCRIPT_WARN_MS) warnings.push("no-transcripts")
    if (input.loudClosedMs >= GATE_CLOSED_LOUD_WARN_MS) warnings.push("gate-closed-loud")
    if (input.openValves.length > 0) warnings.push("language-guard-bypassed")
    return warnings
  }
}
