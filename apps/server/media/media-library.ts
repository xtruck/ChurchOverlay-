import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises"
import { extname, join } from "node:path"
import type { MediaCue, MediaCueKind } from "../../../packages/contracts"
import { generateUlid, isValidUlid } from "../../../packages/shared/ulid"
import { isNotFoundError } from "../../../packages/shared/type-guards"
import { MAX_MEDIA_BYTES, SIGNATURE_PROBE_BYTES, matchesSignature } from "./media-signature"

const ALLOWED_EXTENSIONS: Readonly<Record<MediaCueKind, readonly string[]>> = {
  image: [".jpg", ".jpeg", ".png", ".webp"],
  video: [".mp4", ".webm"],
  audio: [".mp3", ".wav", ".m4a"],
}

/** Titles are spoken triggers; anything this long is a paste accident, not a phrase. */
export const MAX_TITLE_LENGTH = 120

export type MediaImportErrorCode =
  | "unsupported-type"
  | "not-a-file"
  | "empty-file"
  | "too-large"
  | "content-mismatch"
  | "empty-title"
  | "title-too-long"
  | "duplicate-title"
  | "unknown-cue"

/**
 * An operator mistake (wrong file, bad title), as opposed to an I/O fault.
 * Callers map it to a user-facing message or an HTTP 4xx; anything else
 * thrown by MediaLibrary is a real failure (disk full, permissions).
 */
export class MediaImportError extends Error {
  readonly code: MediaImportErrorCode
  constructor(code: MediaImportErrorCode, message: string) {
    super(message)
    this.name = "MediaImportError"
    this.code = code
  }
}

/** Errors the operator fixes by editing the title, not by picking another file. */
export function isTitleErrorCode(code: MediaImportErrorCode): boolean {
  return code === "empty-title" || code === "title-too-long" || code === "duplicate-title"
}

export type MediaLibraryOptions = {
  /** The app-owned directory imported files are copied into (ARCHITECTURE.md section 60.4). */
  readonly mediaDir: string
}

/** What load() found, so the caller can log it (MediaLibrary has no logger of its own). */
export type MediaLibraryLoadReport = {
  readonly loaded: number
  /** Entries dropped because they were malformed or pointed outside the media directory. */
  readonly skipped: number
  /** Where an unparseable metadata file was moved, so it is kept rather than overwritten. */
  readonly quarantinedPath: string | null
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
 * media files. `load()` must be called once at startup, mirroring
 * `ConfigStore`'s own explicit load step, before any `resolve()`/`list()`
 * call is expected to reflect prior imports.
 *
 * Hardening (ARCHITECTURE.md section 112): every mutation runs one at a
 * time, so two imports racing on the same title cannot both pass the
 * uniqueness check; a failed import leaves no copied file and no cue
 * behind; file content must match its extension; and a stored filename
 * read back from disk can never point outside the media directory.
 */
export class MediaLibrary {
  private readonly mediaDir: string
  private readonly metadataFilePath: string
  private readonly cues = new Map<string, MediaCue>()
  private readonly storedFilenames = new Map<string, string>()
  private mutationChain: Promise<unknown> = Promise.resolve()
  private tempCounter = 0

  constructor(options: MediaLibraryOptions) {
    this.mediaDir = options.mediaDir
    this.metadataFilePath = join(this.mediaDir, "media-cues.json")
  }

  /**
   * Loads previously-imported cues back into memory. A missing metadata
   * file (first run) is not an error. A present-but-corrupt file does not
   * prevent startup either, but it is moved aside to
   * `media-cues.json.corrupt-<time>` before anything else happens: the next
   * import would otherwise overwrite it and lose every entry in it for good
   * (AGENTS.md section 29, preserve recoverable state).
   */
  async load(): Promise<MediaLibraryLoadReport> {
    let raw: string
    try {
      raw = await readFile(this.metadataFilePath, "utf8")
    } catch (err) {
      if (isNotFoundError(err)) return { loaded: 0, skipped: 0, quarantinedPath: null }
      throw err
    }

    let stored: unknown
    try {
      stored = JSON.parse(raw)
    } catch {
      stored = undefined
    }
    if (!Array.isArray(stored)) {
      const quarantinedPath = `${this.metadataFilePath}.corrupt-${Date.now()}`
      await rename(this.metadataFilePath, quarantinedPath)
      return { loaded: 0, skipped: 0, quarantinedPath }
    }

    let loaded = 0
    let skipped = 0
    for (const entry of stored) {
      if (!isStoredMediaCue(entry) || !isSafeStoredFilename(entry) || this.cues.has(entry.id)) {
        skipped += 1
        continue
      }
      this.cues.set(entry.id, {
        kind: entry.kind,
        id: entry.id,
        title: entry.title,
        ...(entry.autoClearMs === undefined ? {} : { autoClearMs: entry.autoClearMs }),
      })
      this.storedFilenames.set(entry.id, entry.storedFilename)
      loaded += 1
    }
    return { loaded, skipped, quarantinedPath: null }
  }

  /**
   * Copies `sourcePath` into the app-owned media directory under a fresh
   * ULID-based filename and records it. Rejects with a MediaImportError for
   * an operator mistake: disallowed extension, not a regular file, empty or
   * oversized file, content that does not match the extension, or an empty,
   * overlong or duplicate title (section 60.3: titles must be unique so
   * voice-triggered matching never has to choose between two cues).
   */
  import(sourcePath: string, title: string, kind: MediaCueKind): Promise<MediaCue> {
    return this.serialize(async () => {
      const extension = extname(sourcePath).toLowerCase()
      if (!ALLOWED_EXTENSIONS[kind]?.includes(extension)) {
        throw new MediaImportError(
          "unsupported-type",
          `"${extension}" is not an allowed extension for kind "${kind}"`
        )
      }
      // An empty title normalizes to "", and "".includes("") (the
      // detector's substring check) is always true: that cue would fire on
      // every transcript for the rest of the service.
      this.assertUsableTitle(title, null)
      await this.assertImportableFile(sourcePath, extension, kind)

      const id = generateUlid()
      const storedFilename = id + extension
      const storedPath = join(this.mediaDir, storedFilename)

      await mkdir(this.mediaDir, { recursive: true })
      await copyFile(sourcePath, storedPath)

      const cue: MediaCue = { kind, id, title: title.trim() }
      this.cues.set(id, cue)
      this.storedFilenames.set(id, storedFilename)
      try {
        await this.persist()
      } catch (err) {
        // Roll back: a cue that exists in memory but not on disk would
        // vanish on restart, and the copied file would be an orphan.
        this.cues.delete(id)
        this.storedFilenames.delete(id)
        await unlink(storedPath).catch(() => undefined)
        throw err
      }
      return cue
    })
  }

  /**
   * Same title rules as import() — a rename is "the same cue with a
   * different title." The cue's own current title is excluded from the
   * collision check, so renaming "X" to "x" is allowed.
   */
  rename(id: string, newTitle: string): Promise<MediaCue> {
    return this.serialize(async () => {
      const existing = this.cues.get(id)
      if (!existing) throw new MediaImportError("unknown-cue", `No cue with id "${id}"`)
      this.assertUsableTitle(newTitle, id)

      const renamed: MediaCue = { ...existing, title: newTitle.trim() }
      this.cues.set(id, renamed)
      try {
        await this.persist()
      } catch (err) {
        this.cues.set(id, existing)
        throw err
      }
      return renamed
    })
  }

  setAutoClearDuration(id: string, durationMs: number | null): Promise<MediaCue> {
    return this.serialize(async () => {
      const existing = this.cues.get(id)
      if (!existing) throw new MediaImportError("unknown-cue", `No cue with id "${id}"`)
      if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) {
        throw new Error("MediaLibrary: auto-clear duration must be null or a positive finite number")
      }
      const updated: MediaCue = { ...existing, autoClearMs: durationMs }
      this.cues.set(id, updated)
      try {
        await this.persist()
      } catch (err) {
        this.cues.set(id, existing)
        throw err
      }
      return updated
    })
  }

  /**
   * Removes a cue's metadata and deletes its copied file. Unknown id is a
   * no-op (returns false). The metadata is persisted before the file is
   * deleted: if the write fails the cue is still fully usable, instead of
   * listed but pointing at a deleted file.
   */
  remove(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const storedFilename = this.storedFilenames.get(id)
      const existing = this.cues.get(id)
      if (!storedFilename || !existing) return false

      this.cues.delete(id)
      this.storedFilenames.delete(id)
      try {
        await this.persist()
      } catch (err) {
        this.cues.set(id, existing)
        this.storedFilenames.set(id, storedFilename)
        throw err
      }

      try {
        await unlink(join(this.mediaDir, storedFilename))
      } catch (err) {
        if (!isNotFoundError(err)) throw err
      }
      return true
    })
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

  /** Runs mutations strictly one after another; a failure does not block the next one. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(task, task)
    this.mutationChain = run.catch(() => undefined)
    return run
  }

  private assertUsableTitle(title: string, ownId: string | null): void {
    if (typeof title !== "string" || normalizeTitle(title).length === 0) {
      throw new MediaImportError("empty-title", "Title must not be empty")
    }
    if (title.trim().length > MAX_TITLE_LENGTH) {
      throw new MediaImportError("title-too-long", `Title must be at most ${MAX_TITLE_LENGTH} characters`)
    }
    const collision = this.findByTitle(title)
    if (collision && collision.id !== ownId) {
      throw new MediaImportError("duplicate-title", `A cue titled "${title.trim()}" already exists`)
    }
  }

  private async assertImportableFile(sourcePath: string, extension: string, kind: MediaCueKind): Promise<void> {
    let info
    try {
      info = await stat(sourcePath)
    } catch (err) {
      if (isNotFoundError(err)) throw new MediaImportError("not-a-file", "The file no longer exists")
      throw err
    }
    if (!info.isFile()) throw new MediaImportError("not-a-file", "Only regular files can be imported")
    if (info.size === 0) throw new MediaImportError("empty-file", "The file is empty")
    const limit = MAX_MEDIA_BYTES[kind]
    if (info.size > limit) {
      throw new MediaImportError(
        "too-large",
        `The file is ${formatMegabytes(info.size)}, over the ${formatMegabytes(limit)} limit for ${kind}`
      )
    }

    const handle = await open(sourcePath, "r")
    let leading: Uint8Array
    try {
      const buffer = Buffer.alloc(SIGNATURE_PROBE_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_PROBE_BYTES, 0)
      leading = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    if (!matchesSignature(extension, leading)) {
      throw new MediaImportError(
        "content-mismatch",
        `The file's content is not a valid ${extension} file`
      )
    }
  }

  /**
   * Atomic write, the same discipline `ConfigStore` established
   * (ARCHITECTURE.md section 37): unique temp file in the same directory,
   * fsync, close, rename over the real path. The temp file is removed if
   * any step fails, so a full disk does not leave debris behind.
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
    this.tempCounter += 1
    const tempPath = `${this.metadataFilePath}.${process.pid}.${Date.now()}.${this.tempCounter}.tmp`
    try {
      const handle = await open(tempPath, "w")
      try {
        await handle.writeFile(JSON.stringify(stored, null, 2))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempPath, this.metadataFilePath)
    } catch (err) {
      await unlink(tempPath).catch(() => undefined)
      throw err
    }
  }
}

/** Shared with MediaCueDetector — both must agree on what "the same title" means. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase()
}

function formatMegabytes(bytes: number): string {
  return Math.round(bytes / (1024 * 1024)) + " MB"
}

function isStoredMediaCue(value: unknown): value is StoredMediaCue {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "image" || candidate.kind === "video" || candidate.kind === "audio") &&
    typeof candidate.title === "string" &&
    normalizeTitle(candidate.title).length > 0 &&
    typeof candidate.storedFilename === "string" &&
    (candidate.autoClearMs === undefined ||
      candidate.autoClearMs === null ||
      (typeof candidate.autoClearMs === "number" && Number.isFinite(candidate.autoClearMs) && candidate.autoClearMs > 0))
  )
}

/**
 * The stored filename is read back from a JSON file on disk and later
 * served by `/media/<id>`. It must be exactly "<id><allowed extension>":
 * a hand-edited or tampered entry like "..\\..\\secrets.txt" would
 * otherwise let the static server read any file the app can reach.
 */
function isSafeStoredFilename(entry: StoredMediaCue): boolean {
  if (!isValidUlid(entry.id)) return false
  const extension = extname(entry.storedFilename).toLowerCase()
  return entry.storedFilename === entry.id + extension && ALLOWED_EXTENSIONS[entry.kind].includes(extension)
}
