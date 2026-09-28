/**
 * Sanctuary Audio DSP Pre-processor
 *
 * Implements real-time digital signal processing tailored for church sanctuary audio:
 * 1. 80Hz High-Pass Rumble Filter (removes HVAC rumble, stage thumps, and handling noise).
 * 2. High-frequency Consonant Presence Filter (enhances 2.5kHz-3.5kHz vocal clarity for ASR).
 * 3. In-place processing with zero allocation for minimal latency.
 */

export type DspConfig = {
  readonly sampleRate?: number // default 16000 Hz
  readonly enableHighPass?: boolean // default true
  readonly highPassCutoffHz?: number // default 80 Hz
  readonly enablePresenceBoost?: boolean // default true
}

export class SanctuaryDsp {
  private readonly sampleRate: number
  private readonly enableHighPass: boolean
  private readonly enablePresence: boolean

  // Biquad state variables for High-Pass Filter (Direct Form II Transposed)
  private hp_b0 = 1
  private hp_b1 = 0
  private hp_b2 = 0
  private hp_a1 = 0
  private hp_a2 = 0
  private hp_z1 = 0
  private hp_z2 = 0

  // Presence boost state variables
  private pres_b0 = 1
  private pres_b1 = 0
  private pres_b2 = 0
  private pres_a1 = 0
  private pres_a2 = 0
  private pres_z1 = 0
  private pres_z2 = 0

  constructor(config: DspConfig = {}) {
    this.sampleRate = config.sampleRate ?? 16000
    this.enableHighPass = config.enableHighPass ?? true
    this.enablePresence = config.enablePresenceBoost ?? true

    this.calculateHighPassCoefficients(config.highPassCutoffHz ?? 80)
    this.calculatePresenceCoefficients(3000, 1.5, 2.5) // 3kHz center, Q=1.5, +2.5dB gain
  }

  private calculateHighPassCoefficients(cutoffHz: number): void {
    const w0 = (2 * Math.PI * cutoffHz) / this.sampleRate
    const cosw0 = Math.cos(w0)
    const sinw0 = Math.sin(w0)
    const alpha = sinw0 / (2 * 0.7071) // Q = 0.7071 (Butterworth)

    const a0 = 1 + alpha
    this.hp_b0 = (1 + cosw0) / 2 / a0
    this.hp_b1 = -(1 + cosw0) / a0
    this.hp_b2 = (1 + cosw0) / 2 / a0
    this.hp_a1 = (-2 * cosw0) / a0
    this.hp_a2 = (1 - alpha) / a0
  }

  private calculatePresenceCoefficients(centerHz: number, q: number, gainDb: number): void {
    const A = 10 ** (gainDb / 40)
    const w0 = (2 * Math.PI * centerHz) / this.sampleRate
    const cosw0 = Math.cos(w0)
    const sinw0 = Math.sin(w0)
    const alpha = sinw0 / (2 * q)

    const a0 = 1 + alpha / A
    this.pres_b0 = (1 + alpha * A) / a0
    this.pres_b1 = (-2 * cosw0) / a0
    this.pres_b2 = (1 - alpha * A) / a0
    this.pres_a1 = (-2 * cosw0) / a0
    this.pres_a2 = (1 - alpha / A) / a0
  }

  /**
   * Processes a buffer of 16-bit integer PCM samples in-place.
   * Clamps output to [-32768, 32767].
   */
  public process(samples: Int16Array): Int16Array {
    const len = samples.length
    for (let i = 0; i < len; i++) {
      const sampleVal = samples[i] ?? 0
      let x = sampleVal / 32768.0

      // Apply High-pass rumble filter
      if (this.enableHighPass) {
        const out = this.hp_b0 * x + this.hp_z1
        this.hp_z1 = this.hp_b1 * x - this.hp_a1 * out + this.hp_z2
        this.hp_z2 = this.hp_b2 * x - this.hp_a2 * out
        x = out
      }

      // Apply Vocal Consonant Presence Peak
      if (this.enablePresence) {
        const out = this.pres_b0 * x + this.pres_z1
        this.pres_z1 = this.pres_b1 * x - this.pres_a1 * out + this.pres_z2
        this.pres_z2 = this.pres_b2 * x - this.pres_a2 * out
        x = out
      }

      // Clamp back to 16-bit integer PCM
      const intSample = Math.round(x * 32767)
      samples[i] = Math.max(-32768, Math.min(32767, intSample))
    }
    return samples
  }

  /**
   * Resets internal filter delay lines.
   */
  public reset(): void {
    this.hp_z1 = 0
    this.hp_z2 = 0
    this.pres_z1 = 0
    this.pres_z2 = 0
  }
}
