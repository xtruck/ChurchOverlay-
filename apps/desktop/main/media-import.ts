// Explicitly node:path/win32, not the platform-dependent node:path: this
// app only ever receives paths from Electron's native file dialog on
// Windows (its only supported OS, per package.json's electron-builder
// config), so a path here is always Windows-shaped regardless of which
// path module Node would otherwise auto-select for the host platform.
// Forcing win32 semantics removes that implicit, easy-to-break
// dependency rather than relying on it holding by coincidence.
import { basename, extname, isAbsolute, normalize } from "node:path/win32"
import type { MediaCueKind } from "../../../packages/contracts"

const EXTENSION_KINDS: Readonly<Record<string, MediaCueKind>> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".mp4": "video",
  ".webm": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
}

/**
 * ARCHITECTURE.md section 60.4: the operator picks a file, and the main
 * process decides everything from there — including what kind of cue it
 * is, from its extension. Returns null for anything outside the same
 * allowlist MediaLibrary itself enforces at import time (kept as two
 * separate checks deliberately: this one lets the file picker's own
 * dialog filter and this pre-check give an immediate answer before ever
 * touching the filesystem; MediaLibrary's is the one that actually
 * matters and can never be bypassed by calling it directly).
 */
export function inferMediaKind(filePath: string): MediaCueKind | null {
  return EXTENSION_KINDS[extname(filePath).toLowerCase()] ?? null
}

/**
 * A sensible default title (also the voice-trigger phrase, section
 * 60.3) derived from the filename the operator picked — "least
 * surprising, document it" (AGENTS.md section 61) rather than prompting
 * for one with a custom dialog UI nothing has asked for yet. An operator
 * who wants a different spoken trigger renames the file before
 * importing it.
 */
export function deriveTitleFromFilename(filePath: string): string {
  const withoutExtension = basename(filePath, extname(filePath))
  return withoutExtension.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
}

/** Most files one drop may queue; the rest are refused with a message. */
export const MAX_DROPPED_FILES = 20

export type DroppedPathCheck =
  | { readonly ok: true; readonly filePath: string; readonly kind: MediaCueKind }
  | { readonly ok: false; readonly error: string }

/**
 * ARCHITECTURE.md section 112: a path dropped onto the dashboard arrives
 * from the renderer, so it is checked like any other renderer input before
 * the main process touches the filesystem with it. Only a local, absolute,
 * drive-letter path with a supported extension passes. UNC paths
 * (\\server\share\...) are refused on purpose: merely stat-ing one makes
 * Windows contact that server and offer the user's credentials, so a
 * crafted path must never reach fs. Content and size are checked later by
 * MediaLibrary.import(), the same as for the file picker.
 */
export function checkDroppedPath(value: unknown): DroppedPathCheck {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) {
    return { ok: false, error: "That item is not a file." }
  }
  if (value.startsWith("\\\\") || value.startsWith("//")) {
    return { ok: false, error: "Files on a network share can't be imported. Copy the file to this computer first." }
  }
  const filePath = normalize(value)
  if (!/^[A-Za-z]:\\/.test(filePath) || !isAbsolute(filePath)) {
    return { ok: false, error: "That item is not a file on this computer." }
  }
  const kind = inferMediaKind(filePath)
  if (!kind) {
    return { ok: false, error: "That file type isn't supported. Use JPG, PNG, WebP, MP4, WebM, MP3, WAV or M4A." }
  }
  return { ok: true, filePath, kind }
}
