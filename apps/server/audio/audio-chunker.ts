import type { AudioFrame } from "../../../packages/contracts"

export type AudioChunkerOptions = {
  readonly maxDurationMs?: number
  readonly maxFrames?: number
}

/**
 * Bounded PCM frame accumulator. It drops the oldest complete frame when its
 * duration or frame count cap is reached; it never grows without a limit.
 */
export class AudioChunker {
  private readonly maxDurationMs: number
  private readonly maxFrames: number
  private frames: AudioFrame[] = []
  private durationMs = 0

  constructor(options: AudioChunkerOptions = {}) {
    this.maxDurationMs = options.maxDurationMs ?? 8000
    this.maxFrames = options.maxFrames ?? 120
    if (!Number.isFinite(this.maxDurationMs) || this.maxDurationMs <= 0) {
      throw new Error("AudioChunker maxDurationMs must be positive")
    }
    if (!Number.isInteger(this.maxFrames) || this.maxFrames <= 0) {
      throw new Error("AudioChunker maxFrames must be a positive integer")
    }
  }

  push(frame: AudioFrame): void {
    this.frames.push(frame)
    this.durationMs += frame.samples.length / frame.sampleRate * 1000
    while (this.frames.length > this.maxFrames || this.durationMs > this.maxDurationMs) {
      const removed = this.frames.shift()
      if (!removed) break
      this.durationMs -= removed.samples.length / removed.sampleRate * 1000
    }
  }

  drain(): AudioFrame[] {
    const result = this.frames
    this.frames = []
    this.durationMs = 0
    return result
  }

  get size(): number { return this.frames.length }
  get bufferedDurationMs(): number { return this.durationMs }
}
