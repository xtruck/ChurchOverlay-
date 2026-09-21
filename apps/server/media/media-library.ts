import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { extname, join } from "node:path"
import type { MediaCue, MediaCueKind } from "../../../packages/contracts"
import { generateUlid } from "../../../packages/shared/ulid"

const ALLOWED_EXTENSIONS: Readonly<Record<MediaCueKind, readonly string[]>> = {
  image: [".jpg", ".jpeg", ".png", ".webp"],
  video: [".mp4", ".webm"],
  audio: [".mp3", ".wav", ".m4a"],
}

export type MediaLibraryOptions = {
  /** The app-owned directory imported files are copied into (ARCHITECTURE.md section 60.4). */
  readonly mediaDir: string
}

type StoredMediaCue = {
  readonly id: string
  readonly kind: MediaCueKind
  readonly title: string
  readonly storedFilename: string
  readonly autoClearMs?: number | null
}

/**
 * ARCHITECTURE.md section 60.4: the only component that turns a `MediaCue`
 * id back into a real file, and the only place import-time validation
 * happens. `resolve()` returns null for an unknown id — never throws,
 * never leaks a path — exactly like `VerseIndex.exists()` returns false
 * for an unknown reference.
 *
 * Deliberately holds only metadata + the copied file's own location, never
 * the operator's original source path (section 60.4 point 2: "The original
 * path the operator picked is never retained or sent anywhere past this
 * step").
 *
 * Persists imported cues' metadata to a JSON file alongside the copied
 * media files (found necessary post-launch: this class was originally
 * in-memory only, so every imported cue was silently lost on every app
 * restart even though the copied file itself remained on disk — a real
 * production bug, not a theoretical gap). `load()` must be called once at
 * startup, mirroring `ConfigStore`'s own explicit load step, before any
 * `resolve()`/`list()` call is expected to reflect prior imports.
 */
export class MediaLibrary {
  private readonly mediaDir: string
  private readonly metadataFilePath: string
  private readonly cues = new Map<string, MediaCue>()
  private readonly storedFilenames = new Map<string, string>()

  constructor(options: MediaLibraryOptions) {
    this.mediaDir = options.mediaDir
    this.metadataFilePath = join(this.mediaDir, "media-cues.json")
  }

  /**
   * Loads previously-imported cues back into memory. A missing metadata
   * file (first run, or an install predating this fix) is not an error —
   * starts as an empty library, exactly like before. A present-but-
   * corrupt file also does not prevent startup: the operator can always
   * re-import, and refusing to launch over recoverable media metadata
   * would be a worse failure mode than losing that history.
   */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.metadataFilePath, "utf8")
    } catch (err) {
      if (isNotFoundError(err)) return
      throw err
    }

    let stored: unknown
    try {
      stored = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(stored)) return

    for (const entry of stored) {
      if (!isStoredMediaCue(entry)) continue
      this.cues.set(entry.id, {
        kind: entry.kind,
        id: entry.id,
        title: entry.title,
        ...(entry.autoClearMs === undefined ? {} : { autoClearMs: entry.autoClearMs }),
      })
      this.storedFilenames.set(entry.id, entry.storedFilename)
    }
  }

  /**
   * Copies `sourcePath` into the app-owned media directory under a fresh
   * ULID-based filename and records it. Throws on a disallowed extension
   * or a duplicate title (ARCHITECTURE.md section 60.3: titles must be
   * unique so voice-triggered matching never has to choose between two
   * equally-valid cues) — these are operator mistakes to surface
   * immediately, not failures to swallow.
   */
  async import(sourcePath: string, title: string, kind: MediaCueKind): Promise<MediaCue> {
    const extension = extname(sourcePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS[kind].includes(extension)) {
      throw new Error(
        `MediaLibrary: "${extension}" is not an allowed extension for kind "${kind}"`
      )
    }
    // An empty/whitespace-only title normalizes to "", and "".includes("")
    // (MediaCueDetector's substring check) is always true — that cue would
    // fire on every single transcript for the rest of the service. Reject
    // it here, the same operator-mistake-to-surface-immediately treatment
    // duplicate-title already gets below, since a blank title is just as
    // unusable for voice-triggered matching.
    if (normalizeTitle(title).length === 0) {
      throw new Error("MediaLibrary: title must not be empty")
    }
    if (this.findByTitle(title)) {
      throw new Error(`MediaLibrary: a cue titled "${title}" already exists`)
    }

    const id = generateUlid()
    const storedFilename = id + extension

    await mkdir(this.mediaDir, { recursive: true })
    await copyFile(sourcePath, join(this.mediaDir, storedFilename))

    const cue: MediaCue = { kind, id, title }
    this.cues.set(id, cue)
    this.storedFilenames.set(id, storedFilename)
    await this.persist()
    return cue
  }

  /**
   * ARCHITECTURE.md production audit follow-up: an operator who imported
   * the wrong file (or picked a title with a typo) previously had no way
   * to fix it short of restarting the app and hoping the stale metadata
   * file didn't still list it — remove/rename let a mistake be corrected
   * directly, not just prevented at import time.
   *
   * Same duplicate-title/empty-title checks as import() — a rename is
   * really "the same cue with a different title," so it must satisfy the
   * same section 60.3 uniqueness invariant, not a weaker one. The cue's
   * own current title is excluded from the collision check: renaming
   * "X" to "X" (a no-op edit) must not spuriously reject as a duplicate
   * of itself.
   */
  async rename(id: string, newTitle: string): Promise<MediaCue> {
    const existing = this.cues.get(id)
    if (!existing) {
      throw new Error(`MediaLibrary: no cue with id "${id}"`)
    }

    if (normalizeTitle(newTitle).length === 0) {
      throw new Error("MediaLibrary: title must not be empty")
    }
    const collision = this.findByTitle(newTitle)
    if (collision && collision.id !== id) {
      throw new Error(`MediaLibrary: a cue titled "${newTitle}" already exists`)
    }

    const renamed: MediaCue = { ...existing, title: newTitle }
    this.cues.set(id, renamed)
    await this.persist()
    return renamed
  }

  async setAutoClearDuration(id: string, durationMs: number | null): Promise<MediaCue> {
    const existing = this.cues.get(id)
    if (!existing) throw new Error(`MediaLibrary: no cue with id "${id}"`)
    if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) {
      throw new Error("MediaLibrary: auto-clear duration must be null or a positive finite number")
    }
    const updated: MediaCue = { ...existing, autoClearMs: durationMs }
    this.cues.set(id, updated)
    await this.persist()
    return updated
  }

  /**
   * Removes a cue's metadata and deletes its copied file from disk.
   * Unknown id is a no-op (returns false), not an error — matches
   * resolve()'s own "never throws for an unknown id" convention, since
   * the operator-facing action ("remove this tile") has nothing left to
   * do if it's already gone.
   */
  async remove(id: string): Promise<boolean> {
    const storedFilename = this.storedFilenames.get(id)
    if (!storedFilename) return false

    try {
      await unlink(join(this.mediaDir, storedFilename))
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }

    this.cues.delete(id)
    this.storedFilenames.delete(id)
    await this.persist()
    return true
  }

  resolve(id: string): MediaCue | null {
    return this.cues.get(id) ?? null
  }

  /** The real, on-disk path for a known id — used only by StaticServer's `/media/<id>` route. */
  resolveFilePath(id: string): string | null {
    const storedFilename = this.storedFilenames.get(id)
    return storedFilename ? join(this.mediaDir, storedFilename) : null
  }

  /** Case-insensitive exact match on title — the voice-trigger lookup (section 60.3). */
  findByTitle(title: string): MediaCue | null {
    const normalized = normalizeTitle(title)
    for (const cue of this.cues.values()) {
      if (normalizeTitle(cue.title) === normalized) return cue
    }
    return null
  }

  list(): readonly MediaCue[] {
    return Array.from(this.cues.values())
  }

  /**
   * Atomic write, the exact same durability discipline `ConfigStore`
   * already established (ARCHITECTURE.md section 37): write to a
   * uniquely-named temp file in the same directory, fsync it, close it,
   * then rename over the real path — a crash mid-write can never leave a
   * corrupted or partial metadata file behind.
   */
  private async persist(): Promise<void> {
    const stored: StoredMediaCue[] = Array.from(this.cues.values()).map((cue) => ({
      id: cue.id,
      kind: cue.kind,
      title: cue.title,
      storedFilename: this.storedFilenames.get(cue.id) as string,
      ...(cue.autoClearMs === undefined ? {} : { autoClearMs: cue.autoClearMs }),
    }))

    await mkdir(this.mediaDir, { recursive: true })
    const tempPath = `${this.metadataFilePath}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(tempPath, "w")
    try {
      await handle.writeFile(JSON.stringify(stored, null, 2))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, this.metadataFilePath)
  }
}

/** Shared with MediaCueDetector — both must agree on what "the same title" means. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase()
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  )
}

function isStoredMediaCue(value: unknown): value is StoredMediaCue {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "image" || candidate.kind === "video" || candidate.kind === "audio") &&
    typeof candidate.title === "string" &&
    typeof candidate.storedFilename === "string"
    && (candidate.autoClearMs === undefined ||
      candidate.autoClearMs === null ||
      (typeof candidate.autoClearMs === "number" && Number.isFinite(candidate.autoClearMs) && candidate.autoClearMs > 0))
  )
}
