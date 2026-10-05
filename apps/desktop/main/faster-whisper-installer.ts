import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import {
  EMBEDDED_PYTHON,
  FASTER_WHISPER_MODELS,
  FASTER_WHISPER_WHEELS,
  type FasterWhisperModelId,
  type PinnedFile,
} from "./faster-whisper-manifest"
import { atomicWrite, downloadWithProgress, exists, readZip } from "./local-asr-installer"

/**
 * Downloads the faster-whisper engine on demand (never in the installer):
 * an embeddable CPython, the wheels faster-whisper needs, and a CTranslate2
 * Whisper model. Nothing runs pip and nothing is trusted: every artifact is
 * pinned to an exact URL and SHA-256 (faster-whisper-manifest.ts) and verified
 * before a single byte is written. Wheels are plain zip files, extracted with
 * the same minimal reader as the whisper.cpp engine, and every entry name is
 * checked to stay inside site-packages (no zip-slip).
 *
 * Layout under rootDir (all outside the asar archive):
 *   python/            embeddable CPython + Lib/site-packages
 *   sidecar/server.py  copied from the app on every status() so updates apply
 *   models/<id>/       the CTranslate2 model files
 *   engine.json        written last: its presence means the engine is complete
 */

export { type FasterWhisperModelId } from "./faster-whisper-manifest"

export type FasterWhisperInstallState =
  | { readonly state: "unsupported"; readonly reason: string }
  | { readonly state: "not-installed" }
  | { readonly state: "downloading"; readonly step: "engine" | "model"; readonly progress: number }
  | {
      readonly state: "ready"
      readonly pythonPath: string
      readonly sidecarPath: string
      readonly modelDir: string
      readonly model: FasterWhisperModelId
    }
  | { readonly state: "error"; readonly error: string }

type Manifest = {
  readonly python: PinnedFile & { readonly version: string }
  readonly wheels: readonly (PinnedFile & { readonly file: string })[]
  readonly models: Readonly<Record<FasterWhisperModelId, { readonly revision: string; readonly files: readonly (PinnedFile & { readonly path: string })[] }>>
}

export type FasterWhisperInstallerOptions = {
  readonly rootDir: string
  /** Absolute path of the sidecar script shipped with the app. */
  readonly sidecarSource: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchImpl?: typeof fetch
  /** Overridable for tests (a local HTTP server serving fixtures). */
  readonly manifest?: Manifest
}

const DEFAULT_MANIFEST: Manifest = { python: EMBEDDED_PYTHON, wheels: FASTER_WHISPER_WHEELS, models: FASTER_WHISPER_MODELS }
const MODEL_FILE_PATH = /^[A-Za-z0-9._-]+$/

export class FasterWhisperInstaller {
  private readonly rootDir: string
  private readonly sidecarSource: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetchImpl: typeof fetch
  private readonly manifest: Manifest
  private installing: Promise<FasterWhisperInstallState> | null = null

  constructor(options: FasterWhisperInstallerOptions) {
    this.rootDir = options.rootDir
    this.sidecarSource = options.sidecarSource
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fetchImpl = options.fetchImpl ?? fetch
    this.manifest = options.manifest ?? DEFAULT_MANIFEST
  }

  get pythonDir(): string {
    return join(this.rootDir, "python")
  }
  get pythonPath(): string {
    return join(this.pythonDir, "python.exe")
  }
  get sidecarPath(): string {
    return join(this.rootDir, "sidecar", "server.py")
  }
  modelDir(model: FasterWhisperModelId): string {
    return join(this.rootDir, "models", model)
  }
  private get markerPath(): string {
    return join(this.rootDir, "engine.json")
  }

  private unsupportedReason(): string | null {
    if (this.platform !== "win32" || this.arch !== "x64") {
      return "The faster-whisper engine is currently available on Windows x64 only."
    }
    return null
  }

  private fingerprint(): string {
    return createHash("sha256")
      .update(JSON.stringify([this.manifest.python.sha256, this.manifest.wheels.map((w) => w.sha256)]))
      .digest("hex")
  }

  private async engineInstalled(): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(this.markerPath, "utf8")) as { fingerprint?: unknown }
      return marker.fingerprint === this.fingerprint() && (await exists(this.pythonPath))
    } catch {
      return false
    }
  }

  private async modelInstalled(model: FasterWhisperModelId): Promise<boolean> {
    for (const file of this.manifest.models[model].files) {
      if (!(await exists(join(this.modelDir(model), file.path)))) return false
    }
    return true
  }

  /** Cheap check — existence only; integrity was verified when the files were written. */
  async status(model: FasterWhisperModelId): Promise<FasterWhisperInstallState> {
    const reason = this.unsupportedReason()
    if (reason) return { state: "unsupported", reason }
    if ((await this.engineInstalled()) && (await this.modelInstalled(model))) {
      await this.refreshSidecar()
      return this.ready(model)
    }
    return { state: "not-installed" }
  }

  private ready(model: FasterWhisperModelId): FasterWhisperInstallState {
    return { state: "ready", pythonPath: this.pythonPath, sidecarPath: this.sidecarPath, modelDir: this.modelDir(model), model }
  }

  /** Idempotent: concurrent calls share one download. */
  install(model: FasterWhisperModelId, onProgress?: (state: FasterWhisperInstallState) => void): Promise<FasterWhisperInstallState> {
    if (!this.installing) {
      this.installing = this.doInstall(model, onProgress).finally(() => {
        this.installing = null
      })
    }
    return this.installing
  }

  private async doInstall(model: FasterWhisperModelId, onProgress?: (state: FasterWhisperInstallState) => void): Promise<FasterWhisperInstallState> {
    const reason = this.unsupportedReason()
    if (reason) return { state: "unsupported", reason }
    try {
      if (!(await this.engineInstalled())) await this.installEngine((p) => onProgress?.({ state: "downloading", step: "engine", progress: p }))
      if (!(await this.modelInstalled(model))) await this.installModel(model, (p) => onProgress?.({ state: "downloading", step: "model", progress: p }))
      await this.refreshSidecar()
      const ready = this.ready(model)
      onProgress?.(ready)
      return ready
    } catch (error) {
      const failed: FasterWhisperInstallState = { state: "error", error: error instanceof Error ? error.message : String(error) }
      onProgress?.(failed)
      return failed
    }
  }

  private async installEngine(report: (fraction: number) => void): Promise<void> {
    const { python, wheels } = this.manifest
    // Progress is weighted by download size so the bar moves smoothly.
    const sizes = [python.size || 10_000_000, ...wheels.map((w) => w.size)]
    const total = sizes.reduce((a, b) => a + b, 0)
    let done = 0
    const step = async (spec: PinnedFile, weight: number): Promise<Buffer> => {
      const data = await downloadWithProgress(this.fetchImpl, spec.url, (f) => report((done + f * weight) / total))
      verifySha256(data, spec.sha256, spec.url)
      done += weight
      report(done / total)
      return data
    }

    // Build in a staging folder and swap, so a crash never leaves a half engine that looks usable.
    const staging = `${this.pythonDir}.staging`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })

    const pyZip = readZip(await step(python, sizes[0] as number))
    for (const [name, content] of pyZip) await writeInside(staging, name, content)
    const pth = (await readdirPth(staging)) ?? "python312._pth"
    // Embeddable Python ignores PYTHONPATH; the ._pth file is the only way to add site-packages.
    await writeFile(join(staging, pth), "python312.zip\n.\nLib\\site-packages\n", "utf8")

    const site = join(staging, "Lib", "site-packages")
    await mkdir(site, { recursive: true })
    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i] as (typeof wheels)[number]
      const entries = readZip(await step(wheel, sizes[i + 1] as number))
      for (const [name, content] of entries) await writeInside(site, name, content)
    }

    await rm(this.pythonDir, { recursive: true, force: true })
    await rename(staging, this.pythonDir)
    await mkdir(this.rootDir, { recursive: true })
    await atomicWrite(this.markerPath, Buffer.from(JSON.stringify({ fingerprint: this.fingerprint(), python: python.version })))
  }

  private async installModel(model: FasterWhisperModelId, report: (fraction: number) => void): Promise<void> {
    const spec = this.manifest.models[model]
    const total = spec.files.reduce((sum, f) => sum + f.size, 0) || 1
    let done = 0
    const target = this.modelDir(model)
    await mkdir(target, { recursive: true })
    for (const file of spec.files) {
      if (!MODEL_FILE_PATH.test(file.path)) throw new Error(`Refusing model file name ${file.path}`)
      const weight = file.size
      const data = await downloadWithProgress(this.fetchImpl, file.url, (f) => report((done + f * weight) / total))
      verifySha256(data, file.sha256, file.url)
      await atomicWrite(join(target, file.path), data)
      done += weight
      report(done / total)
    }
  }

  /** Keeps the shipped sidecar and the installed copy identical (app updates apply without a re-download). */
  private async refreshSidecar(): Promise<void> {
    const wanted = await readFile(this.sidecarSource)
    try {
      if ((await readFile(this.sidecarPath)).equals(wanted)) return
    } catch {
      // not copied yet
    }
    await mkdir(dirname(this.sidecarPath), { recursive: true })
    await atomicWrite(this.sidecarPath, wanted)
  }
}

function verifySha256(data: Buffer, expected: string, label: string): void {
  const actual = createHash("sha256").update(data).digest("hex")
  if (actual !== expected) throw new Error(`Download failed verification (sha256 ${actual.slice(0, 12)}…) for ${label}`)
}

/** Writes an archive entry under `root`, refusing any name that would escape it. */
async function writeInside(root: string, entryName: string, content: Buffer): Promise<void> {
  const base = resolve(root)
  const target = resolve(base, entryName)
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`Archive entry escapes its folder: ${entryName}`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function readdirPth(dir: string): Promise<string | null> {
  const names = await readdir(dir)
  return names.find((n) => /^python\d+\._pth$/i.test(n)) ?? null
}

