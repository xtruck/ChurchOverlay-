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

/** Extension seam — cloud providers and the failover wrapper implement this surface. */
export interface AsrProvider {
  start(): Promise<void>
  sendAudio(audio: AudioFrame): Promise<void>
  stop(): Promise<void>
  onTranscript(callback: (result: TranscriptResult) => void): void
  /**
   * ARCHITECTURE.md section 104: canonical book ids from a loaded Service
   * Rundown's verse scenes — a lexical-bias hint only, exactly like
   * setCurrentVerseRef. Optional: not every provider implements it, and no
   * caller may assume it changes what gets detected or displayed.
   */
  setPlannedBooks?(bookIds: readonly string[]): void
}
