/** Canonical ASR-boundary audio format, per ARCHITECTURE.md §8.1. */
export type AudioFrame = {
  samples: Int16Array
  sampleRate: 16000
  sequence: number
}
