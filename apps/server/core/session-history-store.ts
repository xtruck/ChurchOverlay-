import { mkdir, open, readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { Verse } from "../../../packages/contracts"

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
export class SessionHistoryStore {
  private readonly filePath: string
  private entries: SessionHistoryEntry[] = []

  constructor(options: { readonly historyDir: string }) {
    this.filePath = join(options.historyDir, "session-history.json")
  }

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (err) {
      if (isNotFoundError(err)) return
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(parsed)) return
    this.entries = parsed.filter(isSessionHistoryEntry)
  }

  async record(verse: Verse, timestamp: number): Promise<void> {
    this.entries.push({
      reference: verse.reference,
      text: verse.text,
      translation: verse.translation,
      timestamp,
    })
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES)
    }
    await this.persist()
  }

  /** A fresh copy each call — same "caller unaffected by a later record()" guarantee SessionRecorder's own getEntries() gives. */
  getEntries(): readonly SessionHistoryEntry[] {
    return [...this.entries]
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(tempPath, "w")
    try {
      await handle.writeFile(JSON.stringify(this.entries))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, this.filePath)
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT"
  )
}

function isSessionHistoryEntry(value: unknown): value is SessionHistoryEntry {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  const reference = candidate.reference as Record<string, unknown> | undefined
  return (
    typeof reference === "object" &&
    reference !== null &&
    typeof reference.book === "string" &&
    typeof reference.chapter === "number" &&
    typeof reference.verse === "number" &&
    typeof candidate.text === "string" &&
    typeof candidate.translation === "string" &&
    typeof candidate.timestamp === "number"
  )
}
