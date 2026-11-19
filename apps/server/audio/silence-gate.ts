import type { AudioFrame } from "../../../packages/contracts"
import type { NoiseMode } from "../asr/noise-mode"

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
 * A production audit (real microphone, real room) found the original
 * placeholder value here (500) was set before any real hardware had been
 * exercised, and measured too aggressively: ambient room noise alone
 * (an idle Windows machine, no one speaking) produced an average RMS
 * of ~1100 with roughly half of individual frames still dipping below
 * 500 — meaning normal speech in a quieter room, from a quieter mic, or
 * spoken further from the microphone could plausibly fall under the old
 * threshold and be silently discarded before ever reaching Groq, which
 * is indistinguishable from "the mic doesn't work" to an operator. Lowered
 * to bias toward forwarding borderline audio (a wasted Groq call on real
 * silence is cheap and harmless — resolveTranscriptVerses only proceeds
 * on genuine verse-shaped text) rather than risk discarding real speech.
 * Still not a scientifically final value — see the mic-visual level meter
 * (apps/desktop/renderer/dashboard.js) for making this gate's actual
 * per-frame decision observable rather than guessing at a number.
 */
const DEFAULT_RMS_THRESHOLD = 150

// ARCHITECTURE.md section 76 ("innovating ideas" follow-up to the section
// 68.2 fix): 150 is one global constant tuned from one room's measurement.
// Real venues vary — a quiet chapel and a hall with HVAC noise need
// different thresholds, and no single hardcoded number serves both without
// being wrong for one of them. startCalibration() lets a fresh threshold be
// derived from THIS room, right before THIS session, instead.
//
// 1.5s balances two costs: too short risks calibrating against a single
// unrepresentative quiet/loud moment (a door closing, someone clearing
// their throat); too long delays the operator actually being heard after
// pressing "start" for no proportional accuracy gain.
const DEFAULT_CALIBRATION_DURATION_MS = 1500
// The calibrated threshold sits above the measured ambient average, not
// AT it — half of ambient frames are already below their own average by
// definition, so a threshold equal to the average would still reject a
// coin-flip's worth of pure silence while accepting almost any real
// speech (which is reliably louder than ambient noise). 1.5x is a
// deliberately modest margin: biased toward forwarding borderline audio,
// the same asymmetric-cost reasoning section 68.2's lowered default used
// (a wasted ASR call on residual noise is cheap; discarding real speech
// is not).
const CALIBRATION_MULTIPLIER = 1.5
// Floors and ceilings guard against a pathological calibration window —
// a silent room (near-zero ambient RMS) must not calibrate to a
// near-zero threshold that forwards electrical noise/hum as "speech";
// a room with a loud transient during the exact calibration window
// (a door slam, a mic bump) must not calibrate to a threshold so high it
// then rejects normal speech for the rest of the session.
const MIN_CALIBRATED_THRESHOLD = 80
const MAX_CALIBRATED_THRESHOLD = 2000

// ARCHITECTURE.md section 81: a real, reported bug — operators had to
// speak unnaturally loudly and repeat themselves before the app "caught"
// what they said. Root cause: per-frame gating with no hysteresis. Real
// speech has natural volume dips (unvoiced consonants, breaths, a word
// trailing off) that briefly fall under any single fixed threshold, and
// GroqProvider's 2-second buffer only accumulates samples from frames
// that ACTUALLY REACH sendAudio() — a frame this gate rejects never gets
// there at all. So a normal sentence, rejected frame by frame at each
// quiet dip, took far longer in real time to accumulate 2 buffered
// seconds than the sentence itself took to speak, and the audio that did
// arrive had silent gaps spliced out of it, fragmenting words. A one-shot
// louder utterance with fewer dips could clear the bar fast enough to
// feel like "you have to shout." A hangover window fixes this the
// standard VAD way: once the gate opens (any frame at/above threshold),
// it stays open through brief dips for hangoverMs before actually
// closing, so one continuous utterance is forwarded as one continuous
// stream instead of being chopped into whichever frames individually
// cleared the bar.
const DEFAULT_HANGOVER_MS = 600

// Robust mode (ARCHITECTURE.md, noise and tongues defence). A fixed threshold
// tuned in a quiet room fails in a loud service: a band, a crowd or HVAC
// raises the level above it for minutes, so every frame is "speech" and the
// paid cloud ASR receives a continuous flood of music and room noise.
//
// Two additions, both opt-in (`robust: true`, enabled by the desktop host) so
// every pre-existing caller and test keeps the exact fixed-threshold behaviour:
//  1. Speech-band level. The gate judges 300-3400 Hz energy (three Butterworth
//     biquads: 4th-order high-pass, 2nd-order low-pass, no allocation) instead of full-band RMS, so bass, kick drum,
//     rumble, hum and hiss no longer open it on their own. The raw RMS is
//     still reported (metrics, gain, mic health keep their scale).
//  2. Adaptive noise floor. A fast-fall, slow-rise tracker of the band level:
//     it drops to the pauses between words within a fraction of a second but
//     needs ~10 s of sustained level to climb, so a preacher's pauses keep it
//     low while continuous music or crowd noise lifts it and, with it, the
//     effective threshold (floor x ratio, never below the calibrated base,
//     never above MAX_EFFECTIVE_THRESHOLD so the gate can never be locked shut).
const BAND_LOW_HZ = 300
const BAND_HIGH_HZ = 3400
const FLOOR_FALL_MS = 400
const FLOOR_RISE_MS = 12000
// Steadiness: the floor may only CLIMB while the level is steady. Speech (even a long prayer or a reading with no
// pause) dips between syllables, so a short-memory minimum of the level stays well under its mean; steady music,
// crowd or hall noise does not dip. Without this, 5-10 s of continuous speech pulled the floor up toward the speech
// level and closed the gate mid-sentence.
const SHORT_FALL_MS = 150
const SHORT_RISE_MS = 1500
const MEAN_MS = 1000
/** shortMinimum / mean at or above this = steady (measured on synthetic signals: white noise 0.97, syllabic speech-like 0.53; real speech is expected lower, real crowd/music higher). */
const STEADY_RATIO = 0.7
/**
 * The calibrated base (up to 2000, from the first 1.5 s, possibly loud pre-service music) may relax down to this many
 * times the tracked floor, so a quiet speaker is not gated all session by a loud calibration. 3 x floor equals the
 * normal 1.5 x ambient base in a room that was quiet at calibration, so quiet rooms behave as before.
 */
const BASE_FLOOR_FACTOR = 3
/** Frames this loud (full-band RMS, ~ -27 dBFS) that the gate keeps rejecting count as "loud but ignored". */
const LOUD_CLOSED_RMS = 1500
/** A cap so a pathological level can never silence the preacher for the rest of the session (~ -18 dBFS). */
const MAX_EFFECTIVE_THRESHOLD = 4000
/** How far above the tracked floor a frame must be to count as speech, by operator mode. */
const FLOOR_RATIO: Readonly<Record<NoiseMode, number>> = { normal: 2.0, noisy: 2.6, tongues: 3.0 }

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number }

function butterworth(kind: "high" | "low", cutoffHz: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const b = kind === "high" ? (1 + cos) / 2 : (1 - cos) / 2
  return {
    b0: b / a0,
    b1: (kind === "high" ? -(1 + cos) : 1 - cos) / a0,
    b2: b / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  }
}

export type SilenceGateResult = {
  readonly forwarded: boolean
  /** True when this frame itself is speech-level (above the effective threshold), not merely carried by the hangover. */
  readonly speech: boolean
  /** Full-band RMS of the frame (PCM16 scale). */
  readonly rms: number
  /**
   * True on the specific frame where an active hangover countdown reaches 0
   * (i.e., speech was detected, then enough silence followed that the hangover expired).
   * This signals the end of an utterance — the ASR provider should flush its buffer.
   */
  readonly utteranceEnded: boolean
}

export type SilenceGateMetrics = {
  readonly framesReceived: number
  readonly framesRejected: number
  readonly framesForwarded: number
  readonly averageRms: number
  readonly maxRms: number
}

export type SilenceGateOptions = {
  readonly threshold?: number
  readonly calibrationDurationMs?: number
  readonly hangoverMs?: number
  /** Speech-band level + adaptive noise floor (see the comment above BAND_LOW_HZ). Default false. */
  readonly robust?: boolean
}

export class SilenceGate {
  private threshold: number
  private readonly calibrationDurationMs: number
  private readonly hangoverMs: number
  private hangoverRemainingMs = 0
  private framesReceived = 0
  private framesRejected = 0
  private framesForwarded = 0
  private rmsSum = 0
  private maxRms = 0

  private readonly robust: boolean
  private noiseMode: NoiseMode = "normal"
  private floor = 0
  private floorSeeded = false
  private shortFloor = 0
  private meanLevel = 0
  private loudClosedMs = 0
  private bandRate = 0
  private hp: Biquad = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
  private lp: Biquad = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
  private hpZ1 = 0
  private hpZ2 = 0
  private hqZ1 = 0
  private hqZ2 = 0
  private lpZ1 = 0
  private lpZ2 = 0

  private calibrating = false
  private calibrationSampleCount = 0
  private calibrationTargetSamples = 0
  private calibrationRmsSum = 0
  private calibrationFrameCount = 0

  constructor(thresholdOrOptions: number | SilenceGateOptions = {}) {
    // Accepts a bare number too — every existing call site (tests, prior
    // production code) already constructs SilenceGate(150)-style, and
    // there is no reason to force a churn of every one of them into
    // { threshold: 150 } just to add an unrelated new option.
    const options: SilenceGateOptions =
      typeof thresholdOrOptions === "number" ? { threshold: thresholdOrOptions } : thresholdOrOptions
    this.threshold = options.threshold ?? DEFAULT_RMS_THRESHOLD
    this.calibrationDurationMs = options.calibrationDurationMs ?? DEFAULT_CALIBRATION_DURATION_MS
    this.hangoverMs = options.hangoverMs ?? DEFAULT_HANGOVER_MS
    this.robust = options.robust ?? false
  }

  /** Operator noise/tongues mode: widens the margin above the tracked noise floor (robust mode only). */
  setNoiseMode(mode: NoiseMode): void {
    this.noiseMode = mode
  }

  /** The level a frame must reach to count as speech right now: the calibrated base, raised by the tracked floor in robust mode. */
  getEffectiveThreshold(): number {
    if (!this.robust) return this.threshold
    // The base relaxes with the floor (see BASE_FLOOR_FACTOR) but never below the silent-room minimum.
    const base = Math.max(MIN_CALIBRATED_THRESHOLD, Math.min(this.threshold, this.floor * BASE_FLOOR_FACTOR))
    return Math.min(MAX_EFFECTIVE_THRESHOLD, Math.max(base, this.floor * FLOOR_RATIO[this.noiseMode]))
  }

  /** Milliseconds, in a row, of loud input (full-band RMS >= 1500) that the gate keeps rejecting: "loud but ignored". */
  getLoudClosedMs(): number {
    return this.loudClosedMs
  }

  /** The tracked noise floor (speech-band RMS), 0 outside robust mode. */
  getNoiseFloor(): number {
    return this.robust ? this.floor : 0
  }

  /**
   * Begins a fresh ambient-noise calibration window: the next
   * ~calibrationDurationMs of audio is measured, never forwarded (section
   * 9's own gate still applies during calibration — nothing should reach
   * ASR before the gate even knows what "quiet" sounds like here), and
   * used to derive a new threshold once enough audio has accumulated.
   * Safe to call again before a prior calibration finishes (a fresh
   * mic:start restarts it), and safe to call on a gate that's never
   * calibrated at all — it just keeps its constructor/default threshold
   * until the first calibration completes.
   */
  /**
   * Zeroes the diagnostic counters so one session's totals (and its RMS peak)
   * do not leak into the next. Deliberately separate from startCalibration():
   * calibration frames still count as received audio within a session.
   */
  resetMetrics(): void {
    this.framesReceived = 0
    this.framesRejected = 0
    this.framesForwarded = 0
    this.rmsSum = 0
    this.maxRms = 0
  }

  startCalibration(): void {
    this.calibrating = true
    this.calibrationSampleCount = 0
    this.calibrationRmsSum = 0
    this.calibrationFrameCount = 0
    this.calibrationTargetSamples = 0 // recomputed from the first frame's own sampleRate
    this.hangoverRemainingMs = 0
    this.floor = 0
    this.floorSeeded = false
    this.loudClosedMs = 0
  }

  process(rawFrame: AudioFrame): SilenceGateResult {
    // A frame with a bad sample rate (0, NaN) must not poison the floor or stall calibration: assume the canonical 16 kHz.
    const frame: AudioFrame =
      Number.isFinite(rawFrame.sampleRate) && rawFrame.sampleRate > 0 ? rawFrame : { ...rawFrame, sampleRate: 16000 }
    const rms = computeRms(frame.samples)
    // The level the gate judges: full-band RMS (default) or speech-band RMS (robust).
    const level = this.robust ? this.bandRms(frame.samples, frame.sampleRate) : rms
    const frameMs = (frame.samples.length / frame.sampleRate) * 1000

    if (this.calibrating) {
      if (this.calibrationTargetSamples === 0) {
        this.calibrationTargetSamples = Math.round((frame.sampleRate * this.calibrationDurationMs) / 1000)
      }
      this.calibrationRmsSum += level
      this.calibrationFrameCount += 1
      this.calibrationSampleCount += frame.samples.length

      // Calibration frames are real, received audio too — counted in the
      // running metrics like any other frame, just never forwarded.
      this.framesReceived += 1
      this.rmsSum += rms
      if (rms > this.maxRms) this.maxRms = rms
      this.framesRejected += 1

      if (this.calibrationSampleCount >= this.calibrationTargetSamples) {
        this.finishCalibration()
      }
      return { forwarded: false, speech: false, rms, utteranceEnded: false }
    }

    if (this.robust) this.trackFloor(level, frameMs)

    this.framesReceived += 1
    this.rmsSum += rms
    if (rms > this.maxRms) this.maxRms = rms

    // Hangover (see the class-level comment above DEFAULT_HANGOVER_MS):
    // a frame at/above threshold always forwards and refills the
    // hangover budget; a frame below threshold still forwards as long as
    // hangover budget remains from a recent above-threshold frame, and
    // only that remaining budget is spent, not refilled.
    const aboveThreshold = level >= this.getEffectiveThreshold()
    const wasHangoverActive = this.hangoverRemainingMs > 0
    const forwarded = aboveThreshold || this.hangoverRemainingMs > 0
    if (aboveThreshold) {
      this.hangoverRemainingMs = this.hangoverMs
    } else if (this.hangoverRemainingMs > 0) {
      this.hangoverRemainingMs = Math.max(0, this.hangoverRemainingMs - frameMs)
    }

    // utteranceEnded is true when hangover was active and just expired on this frame
    const utteranceEnded = wasHangoverActive && this.hangoverRemainingMs === 0

    // "Loud but ignored" episodes: surfaced by AppCore so a gate that shuts out a real speaker is visible.
    if (!forwarded && rms >= LOUD_CLOSED_RMS) this.loudClosedMs += frameMs
    else if (forwarded || rms < LOUD_CLOSED_RMS / 2) this.loudClosedMs = 0

    if (forwarded) {
      this.framesForwarded += 1
    } else {
      this.framesRejected += 1
    }

    return { forwarded, speech: aboveThreshold, rms, utteranceEnded }
  }

  /** Fast fall, slow rise: follows the pauses down at once, climbs only on sustained level (see FLOOR_*_MS). */
  private trackFloor(level: number, frameMs: number): void {
    // Never let a bad number into the state: NaN would latch the threshold (and the gate) for the whole session.
    if (!Number.isFinite(level) || !Number.isFinite(frameMs) || frameMs <= 0) return
    if (!Number.isFinite(this.floor) || !Number.isFinite(this.shortFloor) || !Number.isFinite(this.meanLevel)) {
      this.floorSeeded = false
    }
    if (!this.floorSeeded) {
      this.floor = this.shortFloor = this.meanLevel = level
      this.floorSeeded = true
      return
    }
    this.meanLevel += (level - this.meanLevel) * (1 - Math.exp(-frameMs / MEAN_MS))
    this.shortFloor += (level - this.shortFloor) * (1 - Math.exp(-frameMs / (level < this.shortFloor ? SHORT_FALL_MS : SHORT_RISE_MS)))
    if (level < this.floor) {
      this.floor += (level - this.floor) * (1 - Math.exp(-frameMs / FLOOR_FALL_MS))
    } else if (this.meanLevel > 0 && this.shortFloor / this.meanLevel >= STEADY_RATIO) {
      this.floor += (level - this.floor) * (1 - Math.exp(-frameMs / FLOOR_RISE_MS))
    }
  }

  /** RMS of the 300-3400 Hz band, through two biquads whose state carries across frames. No allocation. */
  private bandRms(samples: Int16Array, sampleRate: number): number {
    if (samples.length === 0) return 0
    if (sampleRate !== this.bandRate) {
      this.bandRate = sampleRate
      this.hp = butterworth("high", BAND_LOW_HZ, sampleRate)
      this.lp = butterworth("low", Math.min(BAND_HIGH_HZ, sampleRate * 0.45), sampleRate)
      this.hpZ1 = this.hpZ2 = this.hqZ1 = this.hqZ2 = this.lpZ1 = this.lpZ2 = 0
    }
    const { hp, lp } = this
    let hz1 = this.hpZ1
    let hz2 = this.hpZ2
    let qz1 = this.hqZ1
    let qz2 = this.hqZ2
    let lz1 = this.lpZ1
    let lz2 = this.lpZ2
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] as number
      // High-pass at 300 Hz: two identical biquads (4th order, -24 dB/octave) so a loud 70 Hz bass note is ~50 dB down.
      const y0 = hp.b0 * x + hz1
      hz1 = hp.b1 * x - hp.a1 * y0 + hz2
      hz2 = hp.b2 * x - hp.a2 * y0
      const y = hp.b0 * y0 + qz1
      qz1 = hp.b1 * y0 - hp.a1 * y + qz2
      qz2 = hp.b2 * y0 - hp.a2 * y
      const w = lp.b0 * y + lz1
      lz1 = lp.b1 * y - lp.a1 * w + lz2
      lz2 = lp.b2 * y - lp.a2 * w
      sum += w * w
    }
    this.hpZ1 = hz1
    this.hpZ2 = hz2
    this.hqZ1 = qz1
    this.hqZ2 = qz2
    this.lpZ1 = lz1
    this.lpZ2 = lz2
    return Math.sqrt(sum / samples.length)
  }

  /** True while a calibration window is still accumulating — lets a caller (AppCore) know not to report "mic started" as fully live just yet. */
  isCalibrating(): boolean {
    return this.calibrating
  }

  /** The threshold currently in effect — the constructor default/override until the first calibration completes, the calibrated value after. */
  getThreshold(): number {
    return this.threshold
  }

  private finishCalibration(): void {
    const ambientAverage = this.calibrationFrameCount === 0 ? 0 : this.calibrationRmsSum / this.calibrationFrameCount
    const calibrated = ambientAverage * CALIBRATION_MULTIPLIER
    this.threshold = Math.min(MAX_CALIBRATED_THRESHOLD, Math.max(MIN_CALIBRATED_THRESHOLD, calibrated))
    this.calibrating = false
    this.floor = this.shortFloor = this.meanLevel = ambientAverage
    this.floorSeeded = true
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
