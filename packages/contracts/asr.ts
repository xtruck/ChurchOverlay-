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

/**
 * Provider-neutral recognition context (architecture note
 * `architecture-notes/keyterms-follow-sermon.md`): which Bible books the
 * service is about right now. Canonical book ids only (BOOK_CATALOG); how a
 * book is spoken (French/English names, keyterms, a Whisper prompt) is the
 * provider adapter's business, never the core's.
 *
 * A lexical-bias hint only, exactly like setPlannedBooks: it never
 * influences detection, validation or what gets displayed.
 */
export type AsrContextHints = {
  /**
   * Books the operator is in right now (the displayed verse's book, a book
   * just announced in a final transcript), MOST relevant first. Short.
   */
  readonly focusBooks: readonly string[]
  /** The service plan: rundown books then sermon-prep books, deduplicated, without the focus books. */
  readonly plannedBooks: readonly string[]
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
  /**
   * The current AsrContextHints, pushed by the core whenever they change.
   * Optional: a provider without it simply does not adapt (the core logs
   * that once, `asr.context-hints-unsupported`). A provider that has it may
   * apply the hints mid-stream or at its next connect; it must stay bounded
   * and must never fail the transcription because a hint could not apply.
   */
  setContextHints?(hints: AsrContextHints): void
}
