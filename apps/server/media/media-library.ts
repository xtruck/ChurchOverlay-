import { copyFile, mkdir } from "node:fs/promises"
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
 */
export class MediaLibrary {
  private readonly mediaDir: string
  private readonly cues = new Map<string, MediaCue>()
  private readonly storedFilenames = new Map<string, string>()

  constructor(options: MediaLibraryOptions) {
    this.mediaDir = options.mediaDir
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
}

/** Shared with MediaCueDetector — both must agree on what "the same title" means. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase()
}
