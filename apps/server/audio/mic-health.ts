import type { AudioFrame } from "../../../packages/contracts"

/**
 * Live microphone diagnosis for the operator. Turns raw frame statistics
 * into one of a handful of plain states the dashboard can act on, instead
 * of expecting an operator to interpret RMS numbers mid-service.
 *
 * Pure bookkeeping: no I/O, no timers. AppCore feeds it every frame and
 * reads snapshot() at its own cadence.
 */
export type MicHealthState =
  /** Mic on but calibration still running or not enough audio yet. */
  | "warming-up"
  /** Speech at a healthy level. */
  | "ok"
  /** Signal present but no one has spoken above the gate recently — normal between phrases. */
  | "listening"
  /** Speech detected but well under a usable level. */
  | "too-quiet"
  /** Samples hitting full scale — distortion that ASR cannot undo. */
  | "clipping"
  /** Speech barely above the background noise. */
  | "noisy"
  /** Essentially digital silence for several seconds: muted mic, wrong device, unplugged cable. */
  | "no-signal"

export type MicHealthSnapshot = {
  readonly state: MicHealthState
  /** Typical speech level (dBFS), null until speech has been heard in the window. */
  readonly speechDbfs: number | null
  /** Background noise level (dBFS). */
  readonly noiseDbfs: number | null
  /** speech - noise, dB. */
  readonly snrDb: number | null
  /** Loudest frame in the window (dBFS). */
  readonly peakDbfs: number | null
  /** Fraction of samples at/near full scale over the window, 0..1. */
  readonly clippingRatio: number
  /** Gain currently applied to audio sent to ASR, in dB. */
  readonly gainDb: number
}

type FrameStat = { readonly rms: number; readonly durationMs: number; readonly speech: boolean; readonly clipped: number; readonly samples: number }

const WINDOW_MS = 4000
const MIN_OBSERVED_MS = 1000
const CLIP_LEVEL = 32000
/** Speech quieter than this (≈ RMS 330) measurably hurts cloud ASR. */
const TOO_QUIET_DBFS = -40
const NOISY_SNR_DB = 10
const CLIPPING_RATIO = 0.002
/** RMS ≈ 1 on the PCM16 scale — a live mic, even in a silent room, sits well above this. */
const NO_SIGNAL_DBFS = -85
const NO_SIGNAL_MS = 3000

export function toDbfs(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-3) / 32768)
}

export class MicHealthMonitor {
  private stats: FrameStat[] = []
  private windowDurationMs = 0
  private gainDb = 0

  reset(): void {
    this.stats = []
    this.windowDurationMs = 0
    this.gainDb = 0
  }

  setGain(linearGain: number): void {
    this.gainDb = linearGain > 0 ? 20 * Math.log10(linearGain) : 0
  }

  observe(frame: AudioFrame, rms: number, isSpeech: boolean): void {
    const durationMs = (frame.samples.length / frame.sampleRate) * 1000
    let clipped = 0
    for (let i = 0; i < frame.samples.length; i++) {
      if (Math.abs(frame.samples[i] as number) >= CLIP_LEVEL) clipped += 1
    }
    this.stats.push({ rms, durationMs, speech: isSpeech, clipped, samples: frame.samples.length })
    this.windowDurationMs += durationMs
    while (this.stats.length > 1 && this.windowDurationMs - (this.stats[0] as FrameStat).durationMs >= WINDOW_MS) {
      this.windowDurationMs -= (this.stats.shift() as FrameStat).durationMs
    }
  }

  /** @param calibrating true while SilenceGate is still measuring the room */
  snapshot(calibrating = false): MicHealthSnapshot {
    const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10)
    const base = { gainDb: Math.round(this.gainDb * 10) / 10 }
    if (this.stats.length === 0) {
      return { state: "warming-up", speechDbfs: null, noiseDbfs: null, snrDb: null, peakDbfs: null, clippingRatio: 0, ...base }
    }
    const rmsValues = this.stats.map((s) => s.rms)
    const speechRms = this.stats.filter((s) => s.speech).map((s) => s.rms)
    const peak = Math.max(...rmsValues)
    const noise = percentile(rmsValues, 0.2)
    const speech = speechRms.length > 0 ? percentile(speechRms, 0.7) : null
    const totalSamples = this.stats.reduce((sum, s) => sum + s.samples, 0)
    const clippedSamples = this.stats.reduce((sum, s) => sum + s.clipped, 0)
    const clippingRatio = totalSamples === 0 ? 0 : clippedSamples / totalSamples

    const speechDbfs = speech === null ? null : toDbfs(speech)
    const noiseDbfs = toDbfs(noise)
    const snrDb = speechDbfs === null ? null : speechDbfs - noiseDbfs
    const peakDbfs = toDbfs(peak)

    let state: MicHealthState
    if (calibrating || this.windowDurationMs < MIN_OBSERVED_MS) state = "warming-up"
    else if (peakDbfs < NO_SIGNAL_DBFS && this.windowDurationMs >= NO_SIGNAL_MS) state = "no-signal"
    else if (clippingRatio >= CLIPPING_RATIO) state = "clipping"
    else if (speechDbfs === null) state = "listening"
    else if (speechDbfs < TOO_QUIET_DBFS) state = "too-quiet"
    else if (snrDb !== null && snrDb < NOISY_SNR_DB) state = "noisy"
    else state = "ok"

    return {
      state,
      speechDbfs: round(speechDbfs),
      noiseDbfs: round(noiseDbfs),
      snrDb: round(snrDb),
      peakDbfs: round(peakDbfs),
      clippingRatio: Math.round(clippingRatio * 10000) / 10000,
      ...base,
    }
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
  return sorted[index] as number
}
