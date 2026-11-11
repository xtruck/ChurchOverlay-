/**
 * Operator-selectable strictness for what the transcript pipeline accepts
 * when the room is loud or people speak in tongues (ARCHITECTURE.md, noise
 * and tongues defence).
 *
 *  - "normal": the behaviour before this option existed, plus only rules that
 *    cannot touch real French/English speech.
 *  - "noisy": a loud room (band, crowd): tighter segment-quality and
 *    plausibility thresholds.
 *  - "tongues": worship/prayer with glossolalia: tightest. Prefers a missed
 *    sentence over a gibberish sentence reaching verse detection.
 *
 * Only the TRANSCRIPT side reads this (what is dropped after ASR); the audio
 * gate has its own adaptive floor. A shared mutable holder, not a global, so
 * tests construct their own and the desktop host passes one instance to the
 * providers and to AppCore.
 */
import { DropLedger } from "./drop-ledger"

export type NoiseMode = "normal" | "noisy" | "tongues"

export const NOISE_MODES: readonly NoiseMode[] = ["normal", "noisy", "tongues"]

export function isNoiseMode(value: unknown): value is NoiseMode {
  return value === "normal" || value === "noisy" || value === "tongues"
}

export class TranscriptionPolicy {
  private current: NoiseMode
  /** Everything dropped by any layer, shared so the operator can see it (drop-ledger.ts). */
  readonly ledger = new DropLedger()

  constructor(mode: NoiseMode = "normal") {
    this.current = mode
  }

  get mode(): NoiseMode {
    return this.current
  }

  set(mode: NoiseMode): void {
    this.current = mode
  }
}
