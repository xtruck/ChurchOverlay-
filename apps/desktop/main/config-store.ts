import { constants } from "node:fs"
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import type { DisplayMode, VerseConfirmationMode, VerseLayout } from "../../../packages/contracts"
import type { AudioProfile } from "../../server/audio/audio-profile"
import { ASR_STRATEGIES, type AsrStrategy } from "../../server/asr/asr-strategy"
import { AI_PROVIDERS, type AiProvider } from "../../server/ai/ai-provider"
import type { OverlayStyleSettings } from "../../../packages/contracts/overlay-style"
import { normalizeOverlayStyleSettings } from "../../server/overlay/overlay-style"
import type { LogFields } from "../../../packages/shared/logger"
import { isNotFoundError, isPlainObject } from "../../../packages/shared/type-guards"

/** Desktop-app-only concern (not part of the WS protocol) — the operator dashboard/setup UI's own language, ARCHITECTURE.md section 63.5. */
export type UiLanguage = "en" | "fr"

export const DISPLAY_MODES: readonly DisplayMode[] = ["english", "french", "bilingual"]
export const UI_LANGUAGES: readonly UiLanguage[] = ["en", "fr"]
export const VERSE_CONFIRMATION_MODES: readonly VerseConfirmationMode[] = ["auto", "review"]
export const VERSE_LAYOUTS: readonly VerseLayout[] = ["fullscreen", "lower-third"]
/**
 * ARCHITECTURE.md section 107 — public-domain only (confirmed explicitly:
 * NIV/Segond 21 are copyrighted and excluded until a licensed API is
 * wired in). "ls1910" (Louis Segond 1910) was the only French translation
 * before this existed and stays the default; "darby" (J.N. Darby, French,
 * public domain) is the new second option.
 */
export const FRENCH_TRANSLATIONS: readonly string[] = ["ls1910", "darby"]
/**
 * ARCHITECTURE.md section 108 — preset visual styles for how a verse
 * appears on the overlay, independent of verseLayout (fullscreen/
 * lower-third is WHERE it sits; this is what it looks like there).
 */
export const OVERLAY_TEMPLATES: readonly string[] = ["classic", "banner", "minimal", "elegant"]

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
  /** Optional Anthropic key for the AI helpers; absent means the helpers stay off. */
  readonly anthropicApiKey?: string
  /**
   * ARCHITECTURE.md section 128: which service runs the optional AI helpers. Absent means
   * Anthropic when an Anthropic key exists, otherwise no AI until the operator picks one.
   */
  readonly aiProvider?: AiProvider
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
  /**
   * ARCHITECTURE.md sections 123-125: live toggles of the optional Anthropic
   * features. Opt-in, off by default (absent = false); inert without an
   * Anthropic key.
   */
  readonly aiTranscriptCleanup?: boolean
  readonly aiSemanticDetection?: boolean
  readonly aiSermonCopilot?: boolean
  readonly audioProfile?: AudioProfile
  /**
   * ARCHITECTURE.md section 92 (AGENTS.md section 4 amendment: "a generic,
   * brandable audience... no church-specific defaults" — still a local
   * single-install app, not a hosted product). Both plain, non-secret
   * display strings, not encrypted like the API keys/tokens above.
   * Absent/blank means "use the app's own neutral default" (the
   * "ChurchOverlay" product name and the existing built-in accent color),
   * never a specific church's name or color baked in as a fallback.
   */
  readonly organizationName?: string
  readonly accentColor?: string
  /**
   * Which provider carries live audio when both keys exist (see
   * server/asr/asr-strategy.ts). Absent → streaming-first.
   */
  readonly asrStrategy?: AsrStrategy
  /** Adaptive gain on audio sent to ASR. Absent → on. */
  readonly autoGain?: boolean
  /** Transcript strictness for loud rooms and speaking in tongues (server/asr/noise-mode.ts). Absent → "normal". */
  readonly noiseMode?: "normal" | "noisy" | "tongues"
  /** Offline whisper.cpp engine as the last fallback. Absent → off (it is a download). */
  readonly localAsrEnabled?: boolean
  readonly localAsrModel?: "base" | "small"
  readonly localAsrEngine?: "whisper.cpp" | "faster-whisper"
  /**
   * ARCHITECTURE.md section 107 — always present after decode() (defaults
   * to "ls1910", the sole French translation before this existed, same
   * required-with-a-default shape as verseLayout above), even though it's
   * optional in storage for backward compatibility with configs saved
   * before this field existed.
   */
  readonly frenchTranslation: string
  /**
   * ARCHITECTURE.md section 108 — always present after decode() (defaults
   * to "classic", the overlay's one and only look before this existed),
   * same shape as frenchTranslation above.
   */
  readonly overlayTemplate: string
  /**
   * ARCHITECTURE.md section 110: the overlay style. Optional (absent on every
   * pre-section-110 file; AppCore then seeds it from overlayTemplate and
   * organizationName). Normalized on decode(), so a corrupt stored value
   * degrades field-by-field to defaults instead of failing the whole load.
   */
  readonly overlayStyle?: OverlayStyleSettings
  /**
   * Custom Bible API endpoint for churches with their own Bible data servers.
   * Absent → use the default bible-api.com. Must be a valid HTTPS URL.
   */
  readonly customBibleApiUrl?: string
}

/**
 * Bumped whenever the stored shape changes in a way an older app could misread.
 * Written on every save. A file WITHOUT one (every pre-B6 install) is read as version 0.
 * A file with a HIGHER number than this (written by a newer app, then rolled back) is read
 * tolerantly and never downgraded destructively (see ConfigStore.write).
 */
export const CONFIG_SCHEMA_VERSION = 1

export type SecretName = "groq" | "deepgram" | "anthropic"

/**
 * What the operator must be told after a load that did not go cleanly:
 * "bak" = the settings file was damaged and was restored from config.json.bak;
 * "quarantined" = it was damaged with no usable backup and was moved aside;
 * "key-unreadable:<name>" = that one secret could not be decrypted (re-enter it).
 */
export type ConfigRecovery = "bak" | "quarantined" | `key-unreadable:${SecretName}`

/** A minimal slice of the shared Logger, so tests can capture warnings. */
export type ConfigLogger = { warn(fields: LogFields): void }

const KNOWN_STORED_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "groqApiKeyEncrypted",
  "deepgramApiKeyEncrypted",
  "anthropicApiKeyEncrypted",
  "microphoneId",
  "operatorTokenEncrypted",
  "viewerTokenEncrypted",
  "displayMode",
  "uiLanguage",
  "allowPhoneRemote",
  "verseConfirmationMode",
  "enableSermonNotes",
  "verseLayout",
  "ndiEnabled",
  "aiTranscriptCleanup",
  "aiSemanticDetection",
  "aiSermonCopilot",
  "audioProfile",
  "organizationName",
  "accentColor",
  "asrStrategy",
  "aiProvider",
  "autoGain",
  "noiseMode",
  "localAsrEnabled",
  "localAsrModel",
  "localAsrEngine",
  "frenchTranslation",
  "overlayTemplate",
  "overlayStyle",
  "customBibleApiUrl",
])

type DecodedConfig = {
  readonly config: AppConfig
  /** Encrypted blobs that could not be decrypted, kept so a later save does not destroy them. */
  readonly unreadable: ReadonlyMap<SecretName, string>
  /** Fields this app does not know (only retained when the file came from a newer schema). */
  readonly extras: Readonly<Record<string, unknown>>
  readonly schemaVersion: number
}

type Candidate =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly decoded: DecodedConfig }
  | { readonly kind: "bad"; readonly error: Error }

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
 *
 * Loads are tolerant (audit B6): one invalid optional field or unknown enum falls back to
 * its default with a logged warning, one undecryptable secret is reported without losing
 * the others, and a truly unparseable file is restored from config.json.bak before it is
 * quarantined. What happened is available from getRecovery() so the operator can be told.
 */
export class ConfigStore {
  // Saves AND loads run one at a time on this chain (ARCHITECTURE.md section 112): several
  // handlers save in response to independent events, and two saves in the
  // same millisecond used to share a temp-file name and race each other.
  // A load can quarantine/restore the file, so two concurrent loads must not interleave either.
  private saveChain: Promise<unknown> = Promise.resolve()
  private tempCounter = 0
  private readonly stickyRecovery = new Set<"bak" | "quarantined">()
  private unreadable: ReadonlyMap<SecretName, string> = new Map()
  private extras: Readonly<Record<string, unknown>> = {}
  private loadedSchemaVersion = 0
  private newerVersionBackedUp = false

  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec,
    private readonly logger?: ConfigLogger
  ) {}

  private get backupPath(): string {
    return `${this.filePath}.bak`
  }

  /**
   * Everything the operator should hear about from the loads so far. "bak" and "quarantined"
   * stay for the session; "key-unreadable:*" always reflects the last load or save.
   */
  getRecovery(): ConfigRecovery[] {
    return [...this.stickyRecovery, ...[...this.unreadable.keys()].map((name) => `key-unreadable:${name}` as const)]
  }

  load(): Promise<AppConfig | null> {
    return this.enqueue(() => this.loadNow())
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.saveChain.then(step, step)
    this.saveChain = run.catch(() => undefined)
    return run
  }

  private async loadNow(): Promise<AppConfig | null> {
    const primary = await this.readCandidate(this.filePath, true)
    if (primary.kind === "missing") {
      this.adopt(null)
      return null
    }
    if (primary.kind === "ok") {
      this.adopt(primary.decoded)
      return primary.decoded.config
    }

    // Truly unreadable. Move it aside first (never overwritten, never lost), then try the
    // last known good copy before giving up on the operator's settings.
    const movedAside = await this.quarantine()
    const backup = await this.readCandidate(this.backupPath, false)
    if (backup.kind === "ok") {
      if (movedAside) await this.restoreFromBackup()
      this.stickyRecovery.add("bak")
      this.logger?.warn({
        component: "config-store",
        event: "config.restored-from-backup",
        error: primary.error.message,
      })
      this.adopt(backup.decoded)
      return backup.decoded.config
    }
    this.stickyRecovery.add("quarantined")
    this.adopt(null)
    throw primary.error
  }

  private adopt(decoded: DecodedConfig | null): void {
    this.unreadable = decoded?.unreadable ?? new Map()
    this.extras = decoded?.extras ?? {}
    this.loadedSchemaVersion = decoded?.schemaVersion ?? 0
  }

  private async readCandidate(path: string, rethrowIo: boolean): Promise<Candidate> {
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (err) {
      if (isNotFoundError(err) || !rethrowIo) return { kind: "missing" }
      throw err
    }
    let stored: unknown
    try {
      stored = JSON.parse(raw)
    } catch {
      return { kind: "bad", error: new Error(`ConfigStore: ${path} contains invalid JSON`) }
    }
    try {
      return { kind: "ok", decoded: this.decode(stored, path) }
    } catch (err) {
      return { kind: "bad", error: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  /**
   * An unreadable config is moved aside, never left in place: the setup
   * screen that follows writes a fresh file, and without this the old file
   * (with its encrypted API keys) would be overwritten and lost.
   * Returns whether the move succeeded.
   */
  private async quarantine(): Promise<boolean> {
    const aside = `${this.filePath}.corrupt-${Date.now()}`
    try {
      await rename(this.filePath, aside)
      return true
    } catch {
      // Best effort: the original error is what the caller needs to see.
      return false
    }
  }

  private async restoreFromBackup(): Promise<void> {
    this.tempCounter += 1
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.tempCounter}.restore.tmp`
    try {
      await copyFile(this.backupPath, tempPath)
      await rename(tempPath, this.filePath)
    } catch (err) {
      await unlink(tempPath).catch(() => undefined)
      // Not fatal: the backup content is still used for this session, and the next save rewrites the file.
      this.logger?.warn({
        component: "config-store",
        event: "config.restore-write-failed",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  save(config: AppConfig): Promise<void> {
    return this.enqueue(() => this.write(config))
  }

  /**
   * Load, change, save as one step on the same queue as save(). Callers
   * that load() and then save() separately can overwrite each other's
   * field when two handlers interleave; this cannot. Returns the saved
   * config, or null when no config exists yet (nothing is created).
   */
  update(mutate: (current: AppConfig) => AppConfig): Promise<AppConfig | null> {
    return this.enqueue(async (): Promise<AppConfig | null> => {
      const current = await this.loadNow()
      if (!current) return null
      const next = mutate(current)
      await this.write(next)
      return next
    })
  }

  private async write(config: AppConfig): Promise<void> {
    // An unreadable secret keeps its raw blob unless the operator has supplied a new value:
    // a transient decrypt failure (locked keyring) must not become permanent key loss.
    const secretBlob = (name: SecretName, value: string | undefined): string | undefined => {
      if (value) return this.codec.encrypt(value).toString("base64")
      return this.unreadable.get(name)
    }
    const groqBlob = secretBlob("groq", config.groqApiKey) ?? this.codec.encrypt(config.groqApiKey).toString("base64")
    const deepgramBlob = secretBlob("deepgram", config.deepgramApiKey)
    const anthropicBlob = secretBlob("anthropic", config.anthropicApiKey)

    const stored = {
      // Fields from a NEWER schema (a rollback) ride along untouched; known fields below win.
      ...(this.loadedSchemaVersion > CONFIG_SCHEMA_VERSION ? this.extras : {}),
      schemaVersion: Math.max(CONFIG_SCHEMA_VERSION, this.loadedSchemaVersion),
      groqApiKeyEncrypted: groqBlob,
      ...(deepgramBlob ? { deepgramApiKeyEncrypted: deepgramBlob } : {}),
      ...(anthropicBlob ? { anthropicApiKeyEncrypted: anthropicBlob } : {}),
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
      ...(config.aiTranscriptCleanup === undefined ? {} : { aiTranscriptCleanup: config.aiTranscriptCleanup }),
      ...(config.aiSemanticDetection === undefined ? {} : { aiSemanticDetection: config.aiSemanticDetection }),
      ...(config.aiSermonCopilot === undefined ? {} : { aiSermonCopilot: config.aiSermonCopilot }),
      ...(config.audioProfile === undefined ? {} : { audioProfile: config.audioProfile }),
      ...(config.organizationName === undefined ? {} : { organizationName: config.organizationName }),
      ...(config.accentColor === undefined ? {} : { accentColor: config.accentColor }),
      ...(config.asrStrategy === undefined ? {} : { asrStrategy: config.asrStrategy }),
      ...(config.aiProvider === undefined ? {} : { aiProvider: config.aiProvider }),
      ...(config.autoGain === undefined ? {} : { autoGain: config.autoGain }),
      ...(config.noiseMode === undefined ? {} : { noiseMode: config.noiseMode }),
      ...(config.localAsrEnabled === undefined ? {} : { localAsrEnabled: config.localAsrEnabled }),
      ...(config.localAsrModel === undefined ? {} : { localAsrModel: config.localAsrModel }),
      ...(config.localAsrEngine === undefined ? {} : { localAsrEngine: config.localAsrEngine }),
      ...(config.frenchTranslation === undefined ? {} : { frenchTranslation: config.frenchTranslation }),
      ...(config.overlayTemplate === undefined ? {} : { overlayTemplate: config.overlayTemplate }),
      ...(config.overlayStyle === undefined ? {} : { overlayStyle: normalizeOverlayStyleSettings(config.overlayStyle) }),
      ...(config.customBibleApiUrl === undefined ? {} : { customBibleApiUrl: config.customBibleApiUrl }),
    }

    await mkdir(dirname(this.filePath), { recursive: true })

    this.tempCounter += 1
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.tempCounter}.tmp`
    try {
      const handle = await open(tempPath, "w")
      try {
        await handle.writeFile(JSON.stringify(stored, null, 2))
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A file from a newer app is about to be rewritten by this older one: keep it once, verbatim.
      if (this.loadedSchemaVersion > CONFIG_SCHEMA_VERSION && !this.newerVersionBackedUp) {
        this.newerVersionBackedUp = true
        await copyFile(this.filePath, `${this.filePath}.schema-v${this.loadedSchemaVersion}.bak`, constants.COPYFILE_EXCL).catch(
          () => undefined
        )
      }
      // Keep the last good file; a failed copy (e.g. no previous file) must not block the save.
      await copyFile(this.filePath, this.backupPath).catch(() => undefined)
      await rename(tempPath, this.filePath)
    } catch (err) {
      await unlink(tempPath).catch(() => undefined)
      throw err
    }

    // A secret the operator just re-entered is no longer "unreadable".
    const stillUnreadable = new Map(this.unreadable)
    if (config.groqApiKey) stillUnreadable.delete("groq")
    if (config.deepgramApiKey) stillUnreadable.delete("deepgram")
    if (config.anthropicApiKey) stillUnreadable.delete("anthropic")
    this.unreadable = stillUnreadable
  }

  private warnField(path: string, field: string): void {
    // The value itself is never logged (it could be anything, including something secret-shaped).
    this.logger?.warn({
      component: "config-store",
      event: "config.field-invalid",
      metadata: { field, file: path },
    })
  }

  private decode(stored: unknown, path: string): DecodedConfig {
    if (!isPlainObject(stored)) {
      throw new Error(`ConfigStore: ${path} does not contain a valid config object`)
    }

    const {
      schemaVersion,
      groqApiKeyEncrypted,
      operatorTokenEncrypted,
      viewerTokenEncrypted,
      microphoneId,
      displayMode,
      uiLanguage,
      allowPhoneRemote,
      verseConfirmationMode,
      enableSermonNotes,
      verseLayout,
      ndiEnabled,
      aiTranscriptCleanup,
      aiSemanticDetection,
      aiSermonCopilot,
      audioProfile,
      organizationName,
      accentColor,
      asrStrategy,
      aiProvider,
      autoGain,
      noiseMode,
      localAsrEnabled,
      localAsrModel,
      localAsrEngine,
      frenchTranslation,
      overlayTemplate,
      overlayStyle,
      customBibleApiUrl,
    } = stored

    // Structural: without these three there is no config to speak of (tokens cannot be invented here).
    if (
      typeof groqApiKeyEncrypted !== "string" ||
      typeof operatorTokenEncrypted !== "string" ||
      typeof viewerTokenEncrypted !== "string"
    ) {
      throw new Error(`ConfigStore: ${path} is missing required encrypted fields`)
    }

    // Everything below degrades per field to its default, with a warning, never to a quarantine.
    const bad = (field: string): undefined => {
      this.warnField(path, field)
      return undefined
    }
    const bool = (field: string, value: unknown): boolean | undefined =>
      value === undefined ? undefined : typeof value === "boolean" ? value : bad(field)
    const text = (field: string, value: unknown): string | undefined =>
      value === undefined ? undefined : typeof value === "string" ? value : bad(field)
    const oneOf = <T extends string>(field: string, value: unknown, allowed: readonly T[]): T | undefined =>
      value === undefined ? undefined : typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : bad(field)

    const version = typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : 0
    if (schemaVersion !== undefined && version === 0) this.warnField(path, "schemaVersion")

    const unreadable = new Map<SecretName, string>()
    const readSecret = (name: SecretName, blob: unknown): string | undefined => {
      if (blob === undefined) return undefined
      if (typeof blob !== "string") return bad(`${name}ApiKeyEncrypted`)
      try {
        return this.codec.decrypt(Buffer.from(blob, "base64"))
      } catch {
        // Only the NAME is reported/logged; never the blob or the codec's error text.
        unreadable.set(name, blob)
        this.logger?.warn({ component: "config-store", event: "config.secret-unreadable", metadata: { name, file: path } })
        return undefined
      }
    }
    const groqApiKey = readSecret("groq", groqApiKeyEncrypted) ?? ""
    const deepgramApiKey = readSecret("deepgram", stored.deepgramApiKeyEncrypted)
    const anthropicApiKey = readSecret("anthropic", stored.anthropicApiKeyEncrypted)

    let operatorToken: string
    let viewerToken: string
    try {
      operatorToken = this.codec.decrypt(Buffer.from(operatorTokenEncrypted, "base64"))
      viewerToken = this.codec.decrypt(Buffer.from(viewerTokenEncrypted, "base64"))
    } catch {
      throw new Error(`ConfigStore: ${path} has tokens that could not be decrypted`)
    }

    const mic = microphoneId === null || typeof microphoneId === "string" ? microphoneId : bad("microphoneId")
    const noise = oneOf("noiseMode", noiseMode, ["normal", "noisy", "tongues"] as const)
    const url = text("customBibleApiUrl", customBibleApiUrl)
    const safeUrl = url !== undefined && !url.startsWith("https://") ? bad("customBibleApiUrl") : url

    const ndi = bool("ndiEnabled", ndiEnabled)
    const cleanup = bool("aiTranscriptCleanup", aiTranscriptCleanup)
    const semantic = bool("aiSemanticDetection", aiSemanticDetection)
    const copilot = bool("aiSermonCopilot", aiSermonCopilot)
    const profile = oneOf("audioProfile", audioProfile, ["responsive", "balanced", "robust"] as const)
    const org = text("organizationName", organizationName)
    const accent = text("accentColor", accentColor)
    const strategy = oneOf("asrStrategy", asrStrategy, ASR_STRATEGIES)
    const provider = oneOf("aiProvider", aiProvider, AI_PROVIDERS)
    const gain = bool("autoGain", autoGain)
    const localEnabled = bool("localAsrEnabled", localAsrEnabled)
    const localModel = oneOf("localAsrModel", localAsrModel, ["base", "small"] as const)
    const localEngine = oneOf("localAsrEngine", localAsrEngine, ["whisper.cpp", "faster-whisper"] as const)

    const extras: Record<string, unknown> = {}
    if (version > CONFIG_SCHEMA_VERSION) {
      for (const [field, value] of Object.entries(stored)) {
        if (!KNOWN_STORED_FIELDS.has(field)) extras[field] = value
      }
    }

    const config: AppConfig = {
      groqApiKey,
      ...(deepgramApiKey === undefined ? {} : { deepgramApiKey }),
      ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
      microphoneId: mic ?? null,
      operatorToken,
      viewerToken,
      // Absent or unrecognised (a config from an older or NEWER version) both mean "the default".
      displayMode: oneOf("displayMode", displayMode, DISPLAY_MODES) ?? "english",
      uiLanguage: oneOf("uiLanguage", uiLanguage, UI_LANGUAGES) ?? "en",
      // Opt-in, off-by-default settings default to off just as much for an upgrade as for a fresh install.
      allowPhoneRemote: bool("allowPhoneRemote", allowPhoneRemote) ?? false,
      verseConfirmationMode: oneOf("verseConfirmationMode", verseConfirmationMode, VERSE_CONFIRMATION_MODES) ?? "auto",
      enableSermonNotes: bool("enableSermonNotes", enableSermonNotes) ?? false,
      verseLayout: oneOf("verseLayout", verseLayout, VERSE_LAYOUTS) ?? "fullscreen",
      ...(ndi === undefined ? {} : { ndiEnabled: ndi }),
      ...(cleanup === undefined ? {} : { aiTranscriptCleanup: cleanup }),
      ...(semantic === undefined ? {} : { aiSemanticDetection: semantic }),
      ...(copilot === undefined ? {} : { aiSermonCopilot: copilot }),
      ...(profile === undefined ? {} : { audioProfile: profile }),
      ...(org === undefined ? {} : { organizationName: org }),
      ...(accent === undefined ? {} : { accentColor: accent }),
      ...(strategy === undefined ? {} : { asrStrategy: strategy }),
      ...(provider === undefined ? {} : { aiProvider: provider }),
      ...(gain === undefined ? {} : { autoGain: gain }),
      ...(noise === undefined ? {} : { noiseMode: noise }),
      ...(localEnabled === undefined ? {} : { localAsrEnabled: localEnabled }),
      ...(localModel === undefined ? {} : { localAsrModel: localModel }),
      ...(localEngine === undefined ? {} : { localAsrEngine: localEngine }),
      frenchTranslation: oneOf("frenchTranslation", frenchTranslation, FRENCH_TRANSLATIONS) ?? "ls1910",
      overlayTemplate: oneOf("overlayTemplate", overlayTemplate, OVERLAY_TEMPLATES) ?? "classic",
      ...(overlayStyle === undefined ? {} : { overlayStyle: normalizeOverlayStyleSettings(overlayStyle) }),
      ...(safeUrl === undefined ? {} : { customBibleApiUrl: safeUrl }),
    }
    return { config, unreadable, extras, schemaVersion: version }
  }
}
