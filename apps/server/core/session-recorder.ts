import type { Verse } from "../../../packages/contracts"

export type SessionEntry = {
  readonly reference: Verse["reference"]
  readonly text: string
  readonly translation: string
  readonly timestamp: number
}

/**
 * ARCHITECTURE.md section 65.8: appends an entry every time a verse is
 * actually shown, reusing already-verified data the pipeline already
 * produced — generates nothing new and carries no hallucination risk of
 * its own. Owned by AppCore, alongside RundownController; recorded from
 * showVerse() (the one function every trigger — detected, override,
 * navigation, or rundown — ultimately calls), not just the
 * detection-specific broadcastVerse() the architecture note describes,
 * since a complete post-service record should include every verse that
 * was actually visible, regardless of how it got there.
 *
 * In-memory only, per session (matching the rest of AppCore's runtime
 * state) — a fresh recording starts each time the app starts services,
 * exported on demand via the Electron main process, never persisted here.
 */
/** A service never shows anywhere near this many verses; the cap only keeps the buffer bounded (AGENTS.md section 36). */
export const MAX_SESSION_ENTRIES = 5000

export class SessionRecorder {
  private readonly entries: SessionEntry[] = []

  record(verse: Verse, timestamp: number): void {
    if (this.entries.length >= MAX_SESSION_ENTRIES) this.entries.shift()
    this.entries.push({
      reference: verse.reference,
      text: verse.text,
      translation: verse.translation,
      timestamp,
    })
  }

  /** A fresh copy each call — a caller (e.g. an in-progress export) is never
   *  affected by a verse recorded after it already read the list. */
  getEntries(): readonly SessionEntry[] {
    return [...this.entries]
  }

  /**
   * Export the session transcript as Markdown format.
   * Includes timestamps, verse references, and verse text.
   * Useful for post-service review and documentation.
   */
  exportMarkdown(): string {
    if (this.entries.length === 0) {
      return "# Service Transcript\n\nNo verses were shown during this session.\n"
    }

    const lines = ["# Service Transcript\n"]
    lines.push(`Generated: ${new Date().toISOString()}\n`)
    lines.push(`Total verses shown: ${this.entries.length}\n\n`)
    lines.push("---\n\n")

    for (const entry of this.entries) {
      const time = new Date(entry.timestamp).toLocaleTimeString()
      const ref = `${entry.reference.book} ${entry.reference.chapter}:${entry.reference.verse}`
      lines.push(`## [${time}] ${ref} (${entry.translation})\n\n`)
      lines.push(`${entry.text}\n\n`)
    }

    return lines.join("")
  }
}

