import type { AudioFrame } from "../../../packages/contracts"

/**
 * Silence Gate (ARCHITECTURE.md section 9, AGENTS.md section 11).
 *
 * An optimization, not a speech-recognition authority: its only job is to
 * reject *obvious* silence before a frame reaches the ASR provider, to
 * reduce unnecessary ASR requests. It must never silently discard speech
 * without producing diagnostic information (section 9) — every decision
 * this gate makes is observable both through process()'s return value and
 * through the running metrics, never a silent internal drop.
 *
 * RMS is computed directly on the PCM16 sample scale (no normalization
 * invented) — a frame is forwarded when its RMS is at or above `threshold`.
 *
 * The default threshold below is a conservative v1 placeholder, not a
 * scientifically tuned value: ARCHITECTURE.md section 34 requires
 * measuring before optimizing, and no real microphone/hardware has been
 * exercised yet in this codebase. It is expected to be revisited once
 * real audio capture exists (AGENTS.md section 61: documented, least-
 * surprising default for a small implementation detail, not invented
 * "final" behavior).
 */
const DEFAULT_RMS_THRESHOLD = 500

export type SilenceGateResult = {
  readonly forwarded: boolean
  readonly rms: number
}

export type SilenceGateMetrics = {
  readonly framesReceived: number
  readonly framesRejected: number
  readonly framesForwarded: number
  readonly averageRms: number
  readonly maxRms: number
}

export class SilenceGate {
  private readonly threshold: number
  private framesReceived = 0
  private framesRejected = 0
  private framesForwarded = 0
  private rmsSum = 0
  private maxRms = 0

  constructor(threshold: number = DEFAULT_RMS_THRESHOLD) {
    this.threshold = threshold
  }

  process(frame: AudioFrame): SilenceGateResult {
    const rms = computeRms(frame.samples)

    this.framesReceived += 1
    this.rmsSum += rms
    if (rms > this.maxRms) this.maxRms = rms

    const forwarded = rms >= this.threshold
    if (forwarded) {
      this.framesForwarded += 1
    } else {
      this.framesRejected += 1
    }

    return { forwarded, rms }
  }

  getMetrics(): SilenceGateMetrics {
    return {
      framesReceived: this.framesReceived,
      framesRejected: this.framesRejected,
      framesForwarded: this.framesForwarded,
      averageRms: this.framesReceived === 0 ? 0 : this.rmsSum / this.framesReceived,
      maxRms: this.maxRms,
    }
  }
}

function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sumOfSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as number
    sumOfSquares += sample * sample
  }
  return Math.sqrt(sumOfSquares / samples.length)
}
