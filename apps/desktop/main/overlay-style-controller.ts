import { rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { OverlayStyle, OverlayStyleSettings } from "../../../packages/contracts/overlay-style"
import { normalizeOverlayStyleSettings } from "../../server/overlay/overlay-style"
import { LogoRejectedError, importBrandLogo, type LogoDecoder } from "./brand-logo"

/** The slice of AppCoreHandle this controller needs (so tests need no real AppCore). */
export interface OverlayStyleCore {
  getOverlayStyle(): OverlayStyle
  setOverlayStyle(settings: unknown): OverlayStyle
}

export interface OverlayStyleControllerDeps {
  /** Null while services are not running. */
  getCore(): OverlayStyleCore | null
  /** Persists the NORMALIZED settings (never raw input). */
  persist(settings: OverlayStyleSettings): Promise<void>
  logoPath: string
  decodeLogo: LogoDecoder
  log(event: string, error?: string): void
  debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 400

/**
 * ARCHITECTURE.md section 110.4/110.6: the one place the main process turns an
 * operator edit into (validate -> live broadcast -> debounced atomic persist).
 * The renderer only ever supplies settings; the logo version is owned here, so
 * a client can neither forge nor skip a cache-bust.
 */
export class OverlayStyleController {
  private timer: NodeJS.Timeout | null = null
  private pending: OverlayStyleSettings | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly deps: OverlayStyleControllerDeps) {}

  private core(): OverlayStyleCore {
    const core = this.deps.getCore()
    if (!core) throw new Error("Services are not started yet.")
    return core
  }

  get(): OverlayStyle {
    return this.core().getOverlayStyle()
  }

  /** The stored logo's path while one is set (the StaticServer's `brandLogoPath`). */
  currentLogoPath(): string | null {
    const core = this.deps.getCore()
    if (!core || core.getOverlayStyle().brand.logo.version === 0) return null
    return existsSync(this.deps.logoPath) ? this.deps.logoPath : null
  }

  apply(raw: unknown): OverlayStyle {
    const core = this.core()
    const settings = normalizeOverlayStyleSettings(raw)
    const version = core.getOverlayStyle().brand.logo.version
    settings.brand.logo = { ...settings.brand.logo, version }
    return this.commit(core, settings)
  }

  async setLogo(sourcePath: string): Promise<OverlayStyle> {
    const core = this.core()
    try {
      await importBrandLogo(sourcePath, this.deps.logoPath, this.deps.decodeLogo)
    } catch (error) {
      if (!(error instanceof LogoRejectedError)) this.deps.log("logo.import-failed", error instanceof Error ? error.message : String(error))
      throw error
    }
    const current = core.getOverlayStyle()
    const settings = normalizeOverlayStyleSettings(current)
    settings.brand.logo = { ...settings.brand.logo, version: current.brand.logo.version + 1, visible: true }
    return this.commit(core, settings)
  }

  async clearLogo(): Promise<OverlayStyle> {
    const core = this.core()
    const current = core.getOverlayStyle()
    const settings = normalizeOverlayStyleSettings(current)
    settings.brand.logo = { ...settings.brand.logo, version: 0, visible: false }
    const style = this.commit(core, settings)
    await rm(this.deps.logoPath, { force: true }).catch((error: unknown) =>
      this.deps.log("logo.remove-failed", error instanceof Error ? error.message : String(error)),
    )
    return style
  }

  private commit(core: OverlayStyleCore, settings: OverlayStyleSettings): OverlayStyle {
    const style = core.setOverlayStyle(settings)
    this.schedulePersist(settings)
    return style
  }

  private schedulePersist(settings: OverlayStyleSettings): void {
    this.pending = normalizeOverlayStyleSettings(settings)
    if (this.timer) clearTimeout(this.timer)
    // A drag produces dozens of updates a second: only the last one is written.
    this.timer = setTimeout(() => void this.flush(), this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.timer.unref()
  }

  /** Writes any pending change now (also called on shutdown so the last edit is never lost). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const settings = this.pending
    if (!settings) return this.writing
    this.pending = null
    this.writing = this.writing
      .then(() => this.deps.persist(settings))
      .catch((error: unknown) => this.deps.log("persist-failed", error instanceof Error ? error.message : String(error)))
    return this.writing
  }
}
