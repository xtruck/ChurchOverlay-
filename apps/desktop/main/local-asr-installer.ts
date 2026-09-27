import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"

/**
 * Downloads and verifies the offline transcription engine on demand — the
 * installer never ships it, so churches that don't want offline fallback
 * don't pay ~150 MB for it.
 *
 * - Engine: whisper.cpp's official Windows x64 build, pinned to a release
 *   and verified by SHA-256 before a single file is extracted. Only the
 *   server executable and the DLLs it needs are written to disk.
 * - Model: a multilingual Whisper ggml model, verified against the SHA-1
 *   published in whisper.cpp's models/README.md.
 *
 * Everything lands in the per-user data folder, outside the app's asar
 * archive (a previous generation of this app broke by spawning an .exe
 * packed inside asar).
 */

export const WHISPER_RELEASE = {
  version: "v1.8.0",
  url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.0/whisper-bin-x64.zip",
  sha256: "b2ef45d9dae84df20437fd75346bd24e2f4ecc49f8292ca2545ab8890d342d89",
  /** Entries extracted from the zip (flattened into the engine folder). */
  files: [
    "Release/whisper-server.exe",
    "Release/whisper.dll",
    "Release/ggml.dll",
    "Release/ggml-base.dll",
    "Release/ggml-cpu.dll",
  ],
} as const

export type LocalModelId = "base" | "small"

export const LOCAL_MODELS: Readonly<Record<LocalModelId, { file: string; url: string; sha1: string; approxMb: number }>> = {
  base: {
    file: "ggml-base.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    sha1: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
    approxMb: 142,
  },
  small: {
    file: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha1: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    approxMb: 466,
  },
}

export type LocalAsrInstallState =
  | { readonly state: "unsupported"; readonly reason: string }
  | { readonly state: "not-installed" }
  | { readonly state: "downloading"; readonly step: "engine" | "model"; readonly progress: number }
  | { readonly state: "ready"; readonly serverPath: string; readonly modelPath: string; readonly model: LocalModelId }
  | { readonly state: "error"; readonly error: string }

export type LocalAsrInstallerOptions = {
  readonly rootDir: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchImpl?: typeof fetch
  /** Overridable for tests (a local HTTP server serving fixtures). */
  readonly release?: { readonly url: string; readonly sha256: string; readonly files: readonly string[] }
  readonly models?: Readonly<Record<LocalModelId, { file: string; url: string; sha1: string; approxMb: number }>>
}

export class LocalAsrInstaller {
  private readonly rootDir: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetchImpl: typeof fetch
  private readonly release: { readonly url: string; readonly sha256: string; readonly files: readonly string[] }
  private readonly models: Readonly<Record<LocalModelId, { file: string; url: string; sha1: string; approxMb: number }>>
  private installing: Promise<LocalAsrInstallState> | null = null

  constructor(options: LocalAsrInstallerOptions) {
    this.rootDir = options.rootDir
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fetchImpl = options.fetchImpl ?? fetch
    this.release = options.release ?? WHISPER_RELEASE
    this.models = options.models ?? LOCAL_MODELS
  }

  get engineDir(): string {
    return join(this.rootDir, "engine", WHISPER_RELEASE.version)
  }

  get serverPath(): string {
    return join(this.engineDir, "whisper-server.exe")
  }

  modelPath(model: LocalModelId): string {
    return join(this.rootDir, "models", this.models[model].file)
  }

  private unsupportedReason(): string | null {
    if (this.platform !== "win32" || this.arch !== "x64") {
      return "Offline transcription is currently available on Windows x64 only."
    }
    return null
  }

  /** Cheap check — existence only; integrity was verified when the files were written. */
  async status(model: LocalModelId): Promise<LocalAsrInstallState> {
    const reason = this.unsupportedReason()
    if (reason) return { state: "unsupported", reason }
    if ((await exists(this.serverPath)) && (await exists(this.modelPath(model)))) {
      return { state: "ready", serverPath: this.serverPath, modelPath: this.modelPath(model), model }
    }
    return { state: "not-installed" }
  }

  /** Idempotent: concurrent calls share one download. */
  install(model: LocalModelId, onProgress?: (state: LocalAsrInstallState) => void): Promise<LocalAsrInstallState> {
    if (!this.installing) {
      this.installing = this.doInstall(model, onProgress).finally(() => {
        this.installing = null
      })
    }
    return this.installing
  }

  private async doInstall(model: LocalModelId, onProgress?: (state: LocalAsrInstallState) => void): Promise<LocalAsrInstallState> {
    const reason = this.unsupportedReason()
    if (reason) return { state: "unsupported", reason }
    try {
      if (!(await exists(this.serverPath))) {
        const zip = await this.download(this.release.url, (p) => onProgress?.({ state: "downloading", step: "engine", progress: p }))
        const actual = createHash("sha256").update(zip).digest("hex")
        if (actual !== this.release.sha256) {
          throw new Error(`Engine download failed verification (sha256 ${actual.slice(0, 12)}…)`)
        }
        const entries = readZip(zip)
        await mkdir(this.engineDir, { recursive: true })
        for (const wanted of this.release.files) {
          const entry = entries.get(wanted)
          if (!entry) throw new Error(`Engine archive is missing ${wanted}`)
          const name = wanted.split("/").pop() as string
          await atomicWrite(join(this.engineDir, name), entry)
        }
      }
      const spec = this.models[model]
      const target = this.modelPath(model)
      if (!(await exists(target))) {
        const data = await this.download(spec.url, (p) => onProgress?.({ state: "downloading", step: "model", progress: p }))
        const actual = createHash("sha1").update(data).digest("hex")
        if (actual !== spec.sha1) throw new Error(`Model download failed verification (sha1 ${actual.slice(0, 12)}…)`)
        await mkdir(join(this.rootDir, "models"), { recursive: true })
        await atomicWrite(target, data)
      }
      const ready: LocalAsrInstallState = { state: "ready", serverPath: this.serverPath, modelPath: target, model }
      onProgress?.(ready)
      return ready
    } catch (error) {
      const failed: LocalAsrInstallState = { state: "error", error: error instanceof Error ? error.message : String(error) }
      onProgress?.(failed)
      return failed
    }
  }

  private async download(url: string, onProgress: (fraction: number) => void): Promise<Buffer> {
    const response = await this.fetchImpl(url, { redirect: "follow" })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`)
    const total = Number(response.headers.get("content-length") ?? 0)
    const chunks: Buffer[] = []
    let received = 0
    let lastReported = -1
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      received += value.byteLength
      if (total > 0) {
        const fraction = Math.min(1, received / total)
        const percent = Math.floor(fraction * 100)
        if (percent !== lastReported) {
          lastReported = percent
          onProgress(fraction)
        }
      }
    }
    return Buffer.concat(chunks)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Write to a temp name then rename, so a crash mid-write never leaves a half file that status() would call "ready". */
async function atomicWrite(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.partial`
  await writeFile(temp, data)
  await rm(path, { force: true })
  await rename(temp, path)
}

/**
 * Minimal ZIP reader (stored + deflate), enough for a release archive.
 * Reads the central directory — the authoritative entry list — rather than
 * trusting local headers. Entry names are returned as-is; callers choose
 * which exact names to write, so a crafted "../" name can never be written
 * anywhere (no zip-slip: nothing is extracted by its own name).
 */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive")
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  const entries = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt zip central directory")
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength).replace(/\\/g, "/")
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith("/")) continue
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) entries.set(name, Buffer.from(raw))
    else if (method === 8) entries.set(name, inflateRawSync(raw))
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`)
  }
  return entries
}

/** For tests and diagnostics. */
export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}
