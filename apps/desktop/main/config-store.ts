import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname } from "node:path"
import type { DisplayMode, VerseConfirmationMode, VerseLayout } from "../../../packages/contracts"

/** Desktop-app-only concern (not part of the WS protocol) — the operator dashboard/setup UI's own language, ARCHITECTURE.md section 63.5. */
export type UiLanguage = "en" | "fr"

export const DISPLAY_MODES: readonly DisplayMode[] = ["english", "french", "bilingual"]
export const UI_LANGUAGES: readonly UiLanguage[] = ["en", "fr"]
export const VERSE_CONFIRMATION_MODES: readonly VerseConfirmationMode[] = ["auto", "review"]
export const VERSE_LAYOUTS: readonly VerseLayout[] = ["fullscreen", "lower-third"]

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
  readonly deepgramApiKey?: string
  readonly microphoneId: string | null
  readonly operatorToken: string
  readonly viewerToken: string
  readonly displayMode: DisplayMode
  readonly uiLanguage: UiLanguage
  /**
   * ARCHITECTURE.md section 65.6 — confirmed explicitly with the user:
   * opt-in, off by default. When true, the WS server and the remote page's
   * StaticServer bind to 0.0.0.0 (reachable from the local network) instead
   * of 127.0.0.1-only, so a phone on the same WiFi can reach the operator
   * remote. A real network-exposure change, not a cosmetic setting — never
   * defaulted to true.
   */
  readonly allowPhoneRemote: boolean
  /**
   * ARCHITECTURE.md section 65.3 — confirmed explicitly: "auto" stays the
   * default, unchanged from every existing/new install unless the
   * operator explicitly switches to "review".
   */
  readonly verseConfirmationMode: VerseConfirmationMode
  /**
   * ARCHITECTURE.md section 65.7 — opt-in, off by default, mirroring
   * allowPhoneRemote's reasoning above but for real per-request Groq API
   * cost rather than network exposure: the AI sermon-notes copilot never
   * runs, and never makes an API call, unless explicitly turned on.
   */
  readonly enableSermonNotes: boolean
  /**
   * ARCHITECTURE.md section 82 — confirmed with the user: full-bleed
   * verse text should be the default (readable from across a room), with
   * lower-third available for when video/media shares the screen.
   */
  readonly verseLayout: VerseLayout
  readonly ndiEnabled?: boolean
}

type StoredConfig = {
  readonly groqApiKeyEncrypted: string
  readonly deepgramApiKeyEncrypted?: string
  readonly microphoneId: string | null
  readonly operatorTokenEncrypted: string
  readonly viewerTokenEncrypted: string
  /** Optional in storage: absent in configs saved before ARCHITECTURE.md section 63 existed. */
  readonly displayMode?: string
  readonly uiLanguage?: string
  /** Optional in storage: absent in configs saved before ARCHITECTURE.md section 65.6 existed. */
  readonly allowPhoneRemote?: boolean
  /** Optional in storage: absent in configs saved before ARCHITECTURE.md section 65.3 existed. */
  readonly verseConfirmationMode?: string
  /** Optional in storage: absent in configs saved before ARCHITECTURE.md section 65.7 existed. */
  readonly enableSermonNotes?: boolean
  /** Optional in storage: absent in configs saved before ARCHITECTURE.md section 82 existed. */
  readonly verseLayout?: string
  readonly ndiEnabled?: boolean
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
      ...(config.deepgramApiKey ? { deepgramApiKeyEncrypted: this.codec.encrypt(config.deepgramApiKey).toString("base64") } : {}),
      microphoneId: config.microphoneId,
      operatorTokenEncrypted: this.codec.encrypt(config.operatorToken).toString("base64"),
      viewerTokenEncrypted: this.codec.encrypt(config.viewerToken).toString("base64"),
      displayMode: config.displayMode,
      uiLanguage: config.uiLanguage,
      allowPhoneRemote: config.allowPhoneRemote,
      verseConfirmationMode: config.verseConfirmationMode,
      enableSermonNotes: config.enableSermonNotes,
      verseLayout: config.verseLayout,
      ...(config.ndiEnabled === undefined ? {} : { ndiEnabled: config.ndiEnabled }),
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

    const {
      groqApiKeyEncrypted,
      deepgramApiKeyEncrypted,
      microphoneId,
      operatorTokenEncrypted,
      viewerTokenEncrypted,
      displayMode,
      uiLanguage,
      allowPhoneRemote,
      verseConfirmationMode,
      enableSermonNotes,
      verseLayout,
      ndiEnabled,
    } = stored

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
    if (allowPhoneRemote !== undefined && typeof allowPhoneRemote !== "boolean") {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid allowPhoneRemote`)
    }
    if (
      verseConfirmationMode !== undefined &&
      !VERSE_CONFIRMATION_MODES.includes(verseConfirmationMode as VerseConfirmationMode)
    ) {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid verseConfirmationMode`)
    }
    if (enableSermonNotes !== undefined && typeof enableSermonNotes !== "boolean") {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid enableSermonNotes`)
    }
    if (verseLayout !== undefined && !VERSE_LAYOUTS.includes(verseLayout as VerseLayout)) {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid verseLayout`)
    }
    if (ndiEnabled !== undefined && typeof ndiEnabled !== "boolean") {
      throw new Error(`ConfigStore: ${this.filePath} has an invalid ndiEnabled`)
    }

    return {
      groqApiKey: this.codec.decrypt(Buffer.from(groqApiKeyEncrypted, "base64")),
      ...(typeof deepgramApiKeyEncrypted === "string"
        ? { deepgramApiKey: this.codec.decrypt(Buffer.from(deepgramApiKeyEncrypted, "base64")) }
        : {}),
      microphoneId,
      operatorToken: this.codec.decrypt(Buffer.from(operatorTokenEncrypted, "base64")),
      viewerToken: this.codec.decrypt(Buffer.from(viewerTokenEncrypted, "base64")),
      displayMode: (displayMode as DisplayMode | undefined) ?? "english",
      uiLanguage: (uiLanguage as UiLanguage | undefined) ?? "en",
      // Absent (a config saved before section 65.6 existed) defaults to
      // false — the opt-in, off-by-default confirmed decision applies
      // just as much to an existing install upgrading as to a fresh one.
      allowPhoneRemote: allowPhoneRemote ?? false,
      // Absent (a config saved before section 65.3 existed) defaults to
      // "auto" — the confirmed unchanged-behavior default applies just as
      // much to an existing install upgrading as to a fresh one.
      verseConfirmationMode: (verseConfirmationMode as VerseConfirmationMode | undefined) ?? "auto",
      // Absent (a config saved before section 65.7 existed) defaults to
      // false — same opt-in-for-cost reasoning as allowPhoneRemote above.
      enableSermonNotes: enableSermonNotes ?? false,
      // Absent (a config saved before section 82 existed) defaults to
      // "fullscreen" — the confirmed default for every existing install
      // upgrading, not just fresh ones.
      verseLayout: (verseLayout as VerseLayout | undefined) ?? "fullscreen",
      ...(ndiEnabled === undefined ? {} : { ndiEnabled }),
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
