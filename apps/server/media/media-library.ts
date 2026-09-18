import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises"
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
      this.cues.set(entry.id, { kind: entry.kind, id: entry.id, title: entry.title })
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
  )
}
