import type { MediaCueKind } from "../../../packages/contracts"

/**
 * Content checks for imported media (ARCHITECTURE.md section 112).
 *
 * The extension decides the cue kind, but the bytes must agree: a renamed
 * executable or a text file called "slide.png" is rejected at import time
 * instead of being copied into the library and served to the overlay.
 * These are the published container signatures, checked against the first
 * bytes of the file only; this is not a decoder and does not prove the file
 * plays, only that it is the format its extension claims.
 */

/** Bytes needed from the start of a file to run every check below. */
export const SIGNATURE_PROBE_BYTES = 16

/**
 * Largest file accepted per kind. Bounded (AGENTS.md section 36): an
 * unbounded copy of a huge or wrong file would fill the disk mid-service.
 * Generous on purpose: a 1080p sermon clip is well under the video limit.
 */
export const MAX_MEDIA_BYTES: Readonly<Record<MediaCueKind, number>> = {
  image: 50 * 1024 * 1024,
  audio: 500 * 1024 * 1024,
  video: 4 * 1024 * 1024 * 1024,
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((value, index) => bytes[offset + index] === value)
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0))
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const RIFF = ascii("RIFF")
const WEBP = ascii("WEBP")
const WAVE = ascii("WAVE")
const FTYP = ascii("ftyp")
const EBML = [0x1a, 0x45, 0xdf, 0xa3]
const ID3 = ascii("ID3")

function isMp3FrameSync(bytes: Uint8Array): boolean {
  // MPEG audio frame header: 11 set sync bits, then a layer field that is
  // not "reserved" (00).
  const first = bytes[0]
  const second = bytes[1]
  if (first === undefined || second === undefined) return false
  return first === 0xff && (second & 0xe0) === 0xe0 && (second & 0x06) !== 0
}

const EXTENSION_CHECKS: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  ".png": (b) => startsWith(b, PNG),
  ".jpg": (b) => startsWith(b, JPEG),
  ".jpeg": (b) => startsWith(b, JPEG),
  ".webp": (b) => startsWith(b, RIFF) && startsWith(b, WEBP, 8),
  ".wav": (b) => startsWith(b, RIFF) && startsWith(b, WAVE, 8),
  // ISO base media (MP4/M4A): a box size, then "ftyp".
  ".mp4": (b) => startsWith(b, FTYP, 4),
  ".m4a": (b) => startsWith(b, FTYP, 4),
  ".webm": (b) => startsWith(b, EBML),
  ".mp3": (b) => startsWith(b, ID3) || isMp3FrameSync(b),
}

/** True when the file's leading bytes match the format its extension names. */
export function matchesSignature(extension: string, leadingBytes: Uint8Array): boolean {
  const check = EXTENSION_CHECKS[extension.toLowerCase()]
  return check ? check(leadingBytes) : false
}
