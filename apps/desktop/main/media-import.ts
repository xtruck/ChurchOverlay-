// Explicitly node:path/win32, not the platform-dependent node:path: this
// app only ever receives paths from Electron's native file dialog on
// Windows (its only supported OS, per package.json's electron-builder
// config), so a path here is always Windows-shaped regardless of which
// path module Node would otherwise auto-select for the host platform.
// Forcing win32 semantics removes that implicit, easy-to-break
// dependency rather than relying on it holding by coincidence.
import { basename, extname } from "node:path/win32"
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
