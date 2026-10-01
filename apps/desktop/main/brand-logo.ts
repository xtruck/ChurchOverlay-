import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * ARCHITECTURE.md section 110.6. The church logo is validated, not trusted:
 * bounded input size, format decided by magic bytes (PNG/JPEG/WebP only, never
 * SVG, which can carry script), decoded and bounded, then re-encoded as a
 * normalized PNG. The picture decoder is injected so the policy is testable in
 * plain Node; the Electron main process passes a nativeImage-backed decoder.
 */
export const LOGO_MAX_INPUT_BYTES = 5 * 1024 * 1024
export const LOGO_MAX_SOURCE_PX = 4096
export const LOGO_MAX_STORED_WIDTH = 1024

export type LogoFormat = "png" | "jpeg" | "webp"

export interface DecodedLogo {
  readonly width: number
  readonly height: number
  /** Re-encodes as PNG, scaled down to `maxWidth` when wider (never up). */
  toPng(maxWidth: number): Buffer
}
export type LogoDecoder = (bytes: Buffer) => DecodedLogo | null

export class LogoRejectedError extends Error {
  constructor(readonly reason: "too-large" | "unsupported-format" | "undecodable" | "too-many-pixels" | "empty", message: string) {
    super(message)
    this.name = "LogoRejectedError"
  }
}

export function detectLogoFormat(bytes: Buffer): LogoFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp"
  return null
}

/** Pure policy: bytes in, normalized PNG bytes out, or LogoRejectedError. */
export function normalizeLogo(bytes: Buffer, decode: LogoDecoder): Buffer {
  if (bytes.length === 0) throw new LogoRejectedError("empty", "The file is empty.")
  if (bytes.length > LOGO_MAX_INPUT_BYTES) throw new LogoRejectedError("too-large", "The logo must be 5 MB or smaller.")
  if (!detectLogoFormat(bytes)) throw new LogoRejectedError("unsupported-format", "Use a PNG, JPEG or WebP image (SVG is not accepted).")
  const image = decode(bytes)
  if (!image || image.width < 1 || image.height < 1) throw new LogoRejectedError("undecodable", "The image could not be read.")
  if (image.width > LOGO_MAX_SOURCE_PX || image.height > LOGO_MAX_SOURCE_PX) {
    throw new LogoRejectedError("too-many-pixels", `The image must be at most ${LOGO_MAX_SOURCE_PX} px on each side.`)
  }
  const png = image.toPng(LOGO_MAX_STORED_WIDTH)
  if (png.length === 0 || !detectLogoFormat(png)) throw new LogoRejectedError("undecodable", "The image could not be converted.")
  return png
}

/** Temp file, flush, rename (AGENTS.md section 29): never a half-written logo at `destPath`. */
export async function writeFileAtomic(destPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true })
  const tmp = `${destPath}.${process.pid}.tmp`
  const handle = await open(tmp, "w", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, destPath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Reads, validates and stores the logo at `destPath`. Throws LogoRejectedError for bad input. */
export async function importBrandLogo(sourcePath: string, destPath: string, decode: LogoDecoder): Promise<void> {
  const info = await stat(sourcePath)
  // Checked before reading so a huge file is never loaded into memory.
  if (info.size > LOGO_MAX_INPUT_BYTES) throw new LogoRejectedError("too-large", "The logo must be 5 MB or smaller.")
  await writeFileAtomic(destPath, normalizeLogo(await readFile(sourcePath), decode))
}
