import type { AudioFrame } from "../../../packages/contracts"

/**
 * Adaptive digital gain for the audio sent to the ASR provider.
 *
 * Why: real service recordings peaked between 0.0008 and 0.013 of full
 * scale — speech arriving 40-60 dB under a normal level. Browser AGC
 * (getUserMedia autoGainControl) is already on and clearly not enough for
 * a distant or low-output church mic. Cloud ASR accuracy drops sharply on
 * signals that quiet, and that — not the detector — was the dominant
 * real-world accuracy problem.
 *
 * Design choices:
 * - Applied AFTER SilenceGate decides, only to frames actually forwarded.
 *   The gate keeps judging the raw signal against the threshold it
 *   calibrated on this room's raw ambient noise; amplifying before it
 *   would make that calibration meaningless whenever the gain moved.
 * - The level estimate learns only from frames the gate classed as speech,
 *   so a long silence (a song, a prayer) never ramps the gain up on noise.
 * - Never attenuates (min gain 1): a hot signal is reported as clipping by
 *   MicHealthMonitor instead — digital attenuation cannot undo clipping
 *   that already happened in the mic preamp.
 * - Smoothed in time and followed by a soft limiter, so it can't pump or
 *   produce new digital clipping.
 */
export type AdaptiveGainOptions = {
  /** Target speech RMS on the PCM16 scale. 3277 ≈ -20 dBFS, a typical broadcast speech level. */
  readonly targetRms?: number
  /** Ceiling on amplification. 12x ≈ +21.6 dB. */
  readonly maxGain?: number
  /** Time for the gain to move ~63% of the way to its new target. */
  readonly smoothingMs?: number
  readonly enabled?: boolean
}

const DEFAULT_TARGET_RMS = 3277
const DEFAULT_MAX_GAIN = 12
const DEFAULT_SMOOTHING_MS = 800
/** Level estimate follows louder speech faster than quieter speech (standard AGC asymmetry). */
const LEVEL_ATTACK_MS = 150
const LEVEL_RELEASE_MS = 2500
/** Soft-limiter knee: samples above this are compressed smoothly toward full scale. */
const LIMIT_KNEE = 24000
const FULL_SCALE = 32767

export class AdaptiveGain {
  private readonly targetRms: number
  private readonly maxGain: number
  private readonly smoothingMs: number
  private enabled: boolean
  private speechLevel = 0
  private gain = 1

  constructor(options: AdaptiveGainOptions = {}) {
    this.targetRms = options.targetRms ?? DEFAULT_TARGET_RMS
    this.maxGain = options.maxGain ?? DEFAULT_MAX_GAIN
    this.smoothingMs = options.smoothingMs ?? DEFAULT_SMOOTHING_MS
    this.enabled = options.enabled ?? true
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.gain = 1
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Current linear gain (1 = unchanged). */
  currentGain(): number {
    return this.enabled ? this.gain : 1
  }

  /** Fresh session (mic:start): forget the previous room's level. */
  reset(): void {
    this.speechLevel = 0
    this.gain = 1
  }

  /**
   * @param rms the frame's RMS as already computed by SilenceGate (raw signal)
   * @param isSpeech whether SilenceGate judged this frame above its threshold
   */
  process(frame: AudioFrame, rms: number, isSpeech: boolean): AudioFrame {
    if (!this.enabled) return frame
    const frameMs = (frame.samples.length / frame.sampleRate) * 1000
    if (isSpeech && rms > 0) {
      if (this.speechLevel === 0) {
        this.speechLevel = rms
      } else {
        const tau = rms > this.speechLevel ? LEVEL_ATTACK_MS : LEVEL_RELEASE_MS
        this.speechLevel += (rms - this.speechLevel) * smoothingFactor(frameMs, tau)
      }
      const desired = clamp(this.targetRms / this.speechLevel, 1, this.maxGain)
      this.gain += (desired - this.gain) * smoothingFactor(frameMs, this.smoothingMs)
    }
    if (this.gain <= 1.0001) return frame
    const out = new Int16Array(frame.samples.length)
    for (let i = 0; i < frame.samples.length; i++) {
      out[i] = softLimit((frame.samples[i] as number) * this.gain)
    }
    return { ...frame, samples: out }
  }
}

function smoothingFactor(stepMs: number, tauMs: number): number {
  return 1 - Math.exp(-stepMs / tauMs)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Linear below the knee, then an exponential approach to full scale — never exceeds it, never hard-clips. */
export function softLimit(value: number): number {
  const magnitude = Math.abs(value)
  if (magnitude <= LIMIT_KNEE) return Math.round(value)
  const headroom = FULL_SCALE - LIMIT_KNEE
  const over = magnitude - LIMIT_KNEE
  const limited = LIMIT_KNEE + headroom * (1 - Math.exp(-over / headroom))
  return Math.round(Math.sign(value) * Math.min(FULL_SCALE, limited))
}
