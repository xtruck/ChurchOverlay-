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

export type SilenceGateResult = {
  readonly forwarded: boolean
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
  startCalibration(): void {
    this.calibrating = true
    this.calibrationSampleCount = 0
    this.calibrationRmsSum = 0
    this.calibrationFrameCount = 0
    this.calibrationTargetSamples = 0 // recomputed from the first frame's own sampleRate
    this.hangoverRemainingMs = 0
  }

  process(frame: AudioFrame): SilenceGateResult {
    const rms = computeRms(frame.samples)

    if (this.calibrating) {
      if (this.calibrationTargetSamples === 0) {
        this.calibrationTargetSamples = Math.round((frame.sampleRate * this.calibrationDurationMs) / 1000)
      }
      this.calibrationRmsSum += rms
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
      return { forwarded: false, rms, utteranceEnded: false }
    }

    this.framesReceived += 1
    this.rmsSum += rms
    if (rms > this.maxRms) this.maxRms = rms

    // Hangover (see the class-level comment above DEFAULT_HANGOVER_MS):
    // a frame at/above threshold always forwards and refills the
    // hangover budget; a frame below threshold still forwards as long as
    // hangover budget remains from a recent above-threshold frame, and
    // only that remaining budget is spent, not refilled.
    const aboveThreshold = rms >= this.threshold
    const wasHangoverActive = this.hangoverRemainingMs > 0
    const forwarded = aboveThreshold || this.hangoverRemainingMs > 0
    if (aboveThreshold) {
      this.hangoverRemainingMs = this.hangoverMs
    } else if (this.hangoverRemainingMs > 0) {
      const frameDurationMs = (frame.samples.length / frame.sampleRate) * 1000
      this.hangoverRemainingMs = Math.max(0, this.hangoverRemainingMs - frameDurationMs)
    }

    // utteranceEnded is true when hangover was active and just expired on this frame
    const utteranceEnded = wasHangoverActive && this.hangoverRemainingMs === 0

    if (forwarded) {
      this.framesForwarded += 1
    } else {
      this.framesRejected += 1
    }

    return { forwarded, rms, utteranceEnded }
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
