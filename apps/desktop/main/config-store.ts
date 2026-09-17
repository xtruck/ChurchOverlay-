import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname } from "node:path"
import type { DisplayMode } from "../../../packages/contracts"

/** Desktop-app-only concern (not part of the WS protocol) — the operator dashboard/setup UI's own language, ARCHITECTURE.md section 63.5. */
export type UiLanguage = "en" | "fr"

export const DISPLAY_MODES: readonly DisplayMode[] = ["english", "french", "bilingual"]
export const UI_LANGUAGES: readonly UiLanguage[] = ["en", "fr"]

/**
 * Matches Electron's `safeStorage` API shape exactly
 * (`encryptString`/`decryptString`), injected rather than imported
 * directly so ConfigStore — and specifically its atomic-write guarantee,
 * the part that actually needs testing — is testable in plain Node
 * without a real Electron runtime. The real Electron main process passes
 * the actual `safeStorage` module here; tests pass a fake codec.
 */
export interface SecretCodec {
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export type AppConfig = {
  readonly groqApiKey: string
  readonly microphoneId: string | null
  readonly operatorToken: string
  readonly viewerToken: string
  readonly displayMode: DisplayMode
  readonly uiLanguage: UiLanguage
}

type StoredConfig = {
  readonly groqApiKeyEncrypted: string
  readonly microphoneId: string | null
  readonly operatorTokenEncrypted: string
  readonly viewerTokenEncrypted: string
  /** Optional in storage: absent in configs saved before ARCHITECTURE.md section 63 existed. */
  readonly displayMode?: string
  readonly uiLanguage?: string
}

/**
 * Secure, crash-safe configuration storage (ARCHITECTURE.md sections
 * 37-38, AGENTS.md section 29). Secrets (the Groq API key and both WS
 * tokens) are encrypted at rest via the injected SecretCodec; only
 * microphoneId is stored in plaintext, since it identifies a device, not
 * a credential.
 *
 * Writes are atomic: write to a uniquely-named temp file in the same
 * directory, fsync it so the bytes are actually durable on disk, close
 * it, then rename over the real path. A crash or failure partway through
 * a write can never leave the previous valid configuration corrupted or
 * missing — the rename is the only step that can affect the real file,
 * and a rename either fully happens or fully doesn't.
 */
export class ConfigStore {
  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec
  ) {}

  async load(): Promise<AppConfig | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }

    let stored: unknown
    try {
      stored = JSON.parse(raw)
    } catch {
      throw new Error(`ConfigStore: ${this.filePath} contains invalid JSON`)
    }

    return this.decode(stored)
  }

  async save(config: AppConfig): Promise<void> {
    const stored: StoredConfig = {
      groqApiKeyEncrypted: this.codec.encrypt(config.groqApiKey).toString("base64"),
      microphoneId: config.microphoneId,
      operatorTokenEncrypted: this.codec.encrypt(config.operatorToken).toString("base64"),
      viewerTokenEncrypted: this.codec.encrypt(config.viewerToken).toString("base64"),
      displayMode: config.displayMode,
      uiLanguage: config.uiLanguage,
    }

    await mkdir(dirname(this.filePath), { recursive: true })

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(tempPath, "w")
    try {
      await handle.writeFile(JSON.stringify(stored, null, 2))
      await handle.sync()
    } finally {
      await handle.close()
    }

    await rename(tempPath, this.filePath)
  }

  private decode(stored: unknown): AppConfig {
    if (!isPlainObject(stored)) {
      throw new Error(`ConfigStore: ${this.filePath} does not contain a valid config object`)
    }

    const { groqApiKeyEncrypted, microphoneId, operatorTokenEncrypted, viewerTokenEncrypted, displayMode, uiLanguage } =
      stored

    if (
      typeof groqApiKeyEncrypted !== "string" ||
      typeof operatorTokenEncrypted !== "string" ||
      typeof viewerTokenEncrypted !== "string"
    ) {
      throw new Error(`ConfigStore: ${this.filePath} is missing required encrypted fields`)
    }
    if (microphoneId !== null && typeof microphoneId !== "string") {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid microphoneId`)
    }
    // Absent (a config saved before section 63 existed) defaults rather than
    // fails — this is expected for an older file, not corruption. A present
    // but invalid value IS corruption and still throws.
    if (displayMode !== undefined && !DISPLAY_MODES.includes(displayMode as DisplayMode)) {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid displayMode`)
    }
    if (uiLanguage !== undefined && !UI_LANGUAGES.includes(uiLanguage as UiLanguage)) {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid uiLanguage`)
    }

    return {
      groqApiKey: this.codec.decrypt(Buffer.from(groqApiKeyEncrypted, "base64")),
      microphoneId,
      operatorToken: this.codec.decrypt(Buffer.from(operatorTokenEncrypted, "base64")),
      viewerToken: this.codec.decrypt(Buffer.from(viewerTokenEncrypted, "base64")),
      displayMode: (displayMode as DisplayMode | undefined) ?? "english",
      uiLanguage: (uiLanguage as UiLanguage | undefined) ?? "en",
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
