import type { AudioFrame } from "./audio"

export type TranscriptState = "partial" | "final"

export type TranscriptResult = {
  id: string
  correlationId: string
  sequence: number
  text: string
  state: TranscriptState
  /** Optional: not every provider exposes a comparable confidence value. Never fabricate this. */
  providerConfidence?: number
  timestamp: number
}

/** Extension seam — v1 ships one implementation (GroqProvider). See ARCHITECTURE.md §50. */
export interface AsrProvider {
  start(): Promise<void>
  sendAudio(audio: AudioFrame): Promise<void>
  stop(): Promise<void>
  onTranscript(callback: (result: TranscriptResult) => void): void
}
