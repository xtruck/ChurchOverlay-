import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { Verse } from "../../../packages/contracts"
import { isNotFoundError } from "../../../packages/shared/type-guards"

export type SessionHistoryEntry = {
  readonly reference: Verse["reference"]
  readonly text: string
  readonly translation: string
  readonly timestamp: number
}

// AGENTS.md section 36: every cache/store must be bounded. A church
// showing ~20 verses/service, 3 services/week, has ~3000 entries/year —
// 5000 comfortably covers well over a year of real usage in one file
// before the oldest entries start rolling off, while still being a
// small, fast-to-load JSON file rather than an unbounded, ever-growing
// log.
const MAX_ENTRIES = 5000

/**
 * ARCHITECTURE.md section 79: a persistent, cross-restart record of every
 * verse ever shown — deliberately separate from SessionRecorder (in-
 * memory, cleared every restart, backing the existing "export THIS
 * session" feature). Answers a different question: not "what did I show
 * today," but "what have I shown across every service, ever" — the data
 * a "most-used verses" or "past services" view needs, which SessionRecorder
 * structurally cannot provide since it never survives a restart.
 *
 * Same atomic-write discipline ConfigStore/MediaLibrary already
 * established: write to a uniquely-named temp file, fsync, rename over
 * the real path. A missing or corrupt file is not a startup failure —
 * starts as empty history, the same recoverable-over-blocking philosophy
 * those two already use.
 */
export type SessionHistoryLoadReport = {
  readonly loaded: number
  readonly skipped: number
  /** Where an unparseable history file was moved, so the next record() cannot overwrite it. */
  readonly quarantinedPath: string | null
}

export class SessionHistoryStore {
  private readonly filePath: string
  private entries: SessionHistoryEntry[] = []
  // Writes run one at a time (ARCHITECTURE.md section 112). Two verses
  // shown in the same millisecond used to share one temp-file name and
  // race each other's rename.
  private writeChain: Promise<unknown> = Promise.resolve()
  private tempCounter = 0

  constructor(options: { readonly historyDir: string }) {
    this.filePath = join(options.historyDir, "session-history.json")
  }

  /**
   * A missing file is a first run. An unparseable one is moved aside to
   * `session-history.json.corrupt-<time>` instead of being treated as empty:
   * otherwise the next verse shown would overwrite years of history with
   * one entry (AGENTS.md section 29).
   */
  async load(): Promise<SessionHistoryLoadReport> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (err) {
      if (isNotFoundError(err)) return { loaded: 0, skipped: 0, quarantinedPath: null }
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (!Array.isArray(parsed)) {
      const quarantinedPath = `${this.filePath}.corrupt-${Date.now()}`
      await rename(this.filePath, quarantinedPath)
      return { loaded: 0, skipped: 0, quarantinedPath }
    }
    this.entries = parsed.filter(isSessionHistoryEntry).slice(-MAX_ENTRIES)
    return { loaded: this.entries.length, skipped: parsed.length - parsed.filter(isSessionHistoryEntry).length, quarantinedPath: null }
  }

  record(verse: Verse, timestamp: number): Promise<void> {
    this.entries.push({
      reference: verse.reference,
      text: verse.text,
      translation: verse.translation,
      timestamp,
    })
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES)
    }
    // Each write snapshots the entries at the moment it runs, so a later
    // write always carries everything recorded before it. A failed write
    // rejects this call only; the entry stays in memory and the next
    // successful write persists it.
    const run = this.writeChain.then(
      () => this.persist(),
      () => this.persist()
    )
    this.writeChain = run.catch(() => undefined)
    return run
  }

  /** A fresh copy each call — same "caller unaffected by a later record()" guarantee SessionRecorder's own getEntries() gives. */
  getEntries(): readonly SessionHistoryEntry[] {
    return [...this.entries]
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true })
    this.tempCounter += 1
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.tempCounter}.tmp`
    try {
      const handle = await open(tempPath, "w")
      try {
        await handle.writeFile(JSON.stringify(this.entries))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempPath, this.filePath)
    } catch (err) {
      await unlink(tempPath).catch(() => undefined)
      throw err
    }
  }
}

function isSessionHistoryEntry(value: unknown): value is SessionHistoryEntry {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  const reference = candidate.reference as Record<string, unknown> | undefined
  return (
    typeof reference === "object" &&
    reference !== null &&
    typeof reference.book === "string" &&
    Number.isFinite(reference.chapter) &&
    Number.isFinite(reference.verse) &&
    typeof candidate.text === "string" &&
    typeof candidate.translation === "string" &&
    Number.isFinite(candidate.timestamp)
  )
}
