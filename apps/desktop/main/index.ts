import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } from "electron"
import { randomBytes } from "node:crypto"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { stat, writeFile } from "node:fs/promises"
import { startAppCore, type AppCoreHandle } from "../../server/core/app-core"
import type { SessionEntry } from "../../server/core/session-recorder"
import { StaticServer } from "../../server/http/static-server"
import { RegexDetector } from "../../server/detector/regex-detector"
import { GLOSSARY } from "../../server/glossary/glossary"
import { KnownValidVerseIndex } from "../../server/verse/known-valid-verse-index"
import { FreeApiSource } from "../../server/verse/free-api-source"
import { GetBibleVerseSource } from "../../server/verse/get-bible-verse-source"
import { LocalizedVerseSource } from "../../server/verse/localized-verse-source"
import { loadOfflineBibleData, OfflineVerseSource, type OfflineBibleData } from "../../server/verse/offline-verse-source"
import { QuoteMatcher, type QuoteMatch } from "../../server/detector/quote-matcher"
import { OfflineFallbackVerseSource } from "../../server/verse/offline-fallback-verse-source"
import { GroqProvider } from "../../server/asr/groq-provider"
import { DeepgramProvider } from "../../server/asr/deepgram-provider"
import { FailoverAsrProvider } from "../../server/asr/failover-provider"
import { ASR_STRATEGIES, asrChain, deepgramLanguageFor, planAsr, type AsrProviderId, type AsrStrategy } from "../../server/asr/asr-strategy"
import { LocalWhisperProvider } from "../../server/asr/local-whisper-provider"
import { WhisperServerProcess } from "../../server/asr/local-whisper-server"
import { LocalAsrInstaller, LOCAL_MODELS, type LocalAsrInstallState, type LocalModelId } from "./local-asr-installer"
import { SermonNotesGenerator } from "../../server/ai/sermon-notes-generator"
import { buildServiceSummaryInput, SERVICE_SUMMARY_SYSTEM_PROMPT } from "../../server/ai/service-summary"
import { MediaImportError, MediaLibrary, isTitleErrorCode } from "../../server/media/media-library"
import { SessionHistoryStore } from "../../server/core/session-history-store"
import {
  ConfigStore,
  DISPLAY_MODES,
  UI_LANGUAGES,
  VERSE_CONFIRMATION_MODES,
  FRENCH_TRANSLATIONS,
  OVERLAY_TEMPLATES,
  type AppConfig,
  type UiLanguage,
} from "./config-store"
import type { DisplayMode, MediaCueKind, VerseConfirmationMode, VerseLayout, VerseSource } from "../../../packages/contracts"
import { checkDroppedPath, inferMediaKind, deriveTitleFromFilename } from "./media-import"
import { isAllowedNavigation, isExternalHttpsUrl } from "./navigation-guard"
import { Logger } from "../../../packages/shared/logger"
import { NDIOutput, type PaintSource } from "./ndi-output"
import { createNdiWindow } from "./ndi-window"
import { PALETTES } from "../../server/overlay/palettes"
import { BRAND_NAME_SIZE, BRAND_SCALE, BRAND_TEXT_MAX } from "../../server/overlay/overlay-style"
import { OVERLAY_BRAND_FONTS, OVERLAY_CARD_DESIGNS, OVERLAY_PALETTE_GROUPS } from "../../../packages/contracts/overlay-style"
import { OverlayStyleController } from "./overlay-style-controller"
import { LogoRejectedError, type DecodedLogo } from "./brand-logo"
import { getAudioProfileSettings, type AudioProfile } from "../../server/audio/audio-profile"
import { SilenceGate } from "../../server/audio/silence-gate"
import { AdaptiveGain } from "../../server/audio/adaptive-gain"

/**
 * Electron main process entry point (ARCHITECTURE.md section 6.1). Owns
 * application lifecycle, window management, secure configuration, and
 * starting/stopping the local server — and, per section 6.1's own
 * explicit boundary, contains NO verse-detection or pipeline business
 * logic itself. All of that lives in AppCore, constructed with real
 * providers and handed a real WS server here.
 */

const WS_PORT = 8787
const OVERLAY_HTTP_PORT = 8788
const REMOTE_HTTP_PORT = 8789

// This compiled file lives at dist/apps/desktop/main/index.js (tsconfig's
// rootDir/outDir mirror the source tree exactly). The renderer HTML/JS and
// the overlay's static assets are plain files tsc never compiles or
// copies — they only exist under the repo root, not under dist/ — so
// paths into them must climb out of dist/apps/desktop/main entirely
// (4 levels) rather than just up within it, the same gap that had to be
// fixed for scripts/dev-preview.ts and scripts/dry-run.ts (each 2 levels
// under dist/, not 3).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

const logger = new Logger({ minLevel: "info" })

let appCoreHandle: AppCoreHandle | null = null
let staticServer: StaticServer | null = null
let remoteStaticServer: StaticServer | null = null
let dashboardWindow: BrowserWindow | null = null
let currentTokens: { operatorToken: string; viewerToken: string } | null = null
let configStore: ConfigStore | null = null
let mediaLibrary: MediaLibrary | null = null
let sessionHistoryStore: SessionHistoryStore | null = null
let localizedVerseSource: LocalizedVerseSource | null = null
let asrProvider: GroqProvider | DeepgramProvider | LocalWhisperProvider | FailoverAsrProvider | null = null
// The concrete providers behind asrProvider, kept so each gets the language
// code its own API expects (Whisper auto-detects when given none; Deepgram
// does not and would fall back to English).
let groqAsr: GroqProvider | null = null
let deepgramAsr: DeepgramProvider | null = null
let localAsr: LocalWhisperProvider | null = null
let localWhisperServer: WhisperServerProcess | null = null
let localAsrInstaller: LocalAsrInstaller | null = null

function setAsrLanguage(mode: DisplayMode): void {
  groqAsr?.setLanguage(whisperLanguageFor(mode))
  deepgramAsr?.setLanguage(deepgramLanguageFor(mode))
  localAsr?.setLanguage(whisperLanguageFor(mode))
}
let currentRemoteUrl: string | null = null
let currentOverlayUrl: string | null = null
let currentAllowPhoneRemote = false
let currentVerseConfirmationMode: VerseConfirmationMode = "auto"
let currentEnableSermonNotes = false
let currentVerseLayout: VerseLayout = "fullscreen"
let currentFrenchTranslation = "ls1910"
let currentOverlayTemplate = "classic"
let ndiWindow: BrowserWindow | null = null
let ndiOutput: NDIOutput | null = null
const logNdi = (event: string, error?: string): void => logger.error({ component: "ndi", event, error })

let activeConfig: AppConfig | null = null

/**
 * ARCHITECTURE.md section 110: live overlay style. Constructed lazily (needs
 * app.getPath, which is only valid after ready) and reads the CURRENT AppCore
 * on every call, so it survives a services restart without being rebuilt.
 */
let overlayStyleController: OverlayStyleController | null = null
function getOverlayStyleController(): OverlayStyleController {
  if (!overlayStyleController) {
    overlayStyleController = new OverlayStyleController({
      getCore: () => appCoreHandle,
      logoPath: join(app.getPath("userData"), "brand", "logo.png"),
      decodeLogo: (bytes) => {
        const image = nativeImage.createFromBuffer(bytes)
        if (image.isEmpty()) return null
        const { width, height } = image.getSize()
        const decoded: DecodedLogo = {
          width,
          height,
          toPng: (maxWidth) =>
            (width > maxWidth ? image.resize({ width: maxWidth, quality: "best" }) : image).toPNG(),
        }
        return decoded
      },
      persist: async (overlayStyle) => {
        await persistConfig((existing) => ({ ...existing, overlayStyle }))
      },
      log: (event, error) => logger.error({ component: "overlay-style", event, error }),
    })
  }
  return overlayStyleController
}
// ARCHITECTURE.md section 74 (production audit): the operator-picked file
// path, held here between the native file-picker dialog and the
// renderer's title confirmation step, so the actual import still happens
// entirely in the main process — the renderer never receives the raw
// filesystem path, only the derived suggested title (section 60.4's
// "never a raw path past this handler" boundary, unchanged).
let pendingMediaImport: { filePath: string; kind: MediaCueKind } | null = null

function generateToken(): string {
  return randomBytes(24).toString("hex")
}

/**
 * ARCHITECTURE.md section 65.6: the address a phone on the same WiFi
 * would use to reach this machine — the first non-internal IPv4 address
 * Node reports. Returns null if none is found (e.g. no network adapter
 * up at all), in which case the remote feature has nothing reachable to
 * offer even though the operator opted in.
 */
function getLanIpAddress(): string | null {
  const interfaces = networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address
    }
  }
  return null
}

/**
 * ARCHITECTURE.md section 81: maps the display/translation mode to a
 * Whisper language hint. "bilingual" deliberately has no single correct
 * hint (a genuinely mixed-language service), so it stays undefined —
 * Whisper's own per-chunk auto-detection is the least-wrong option there.
 */
function whisperLanguageFor(mode: DisplayMode): string | undefined {
  if (mode === "french") return "fr"
  if (mode === "english") return "en"
  return undefined
}

/**
 * Indexing the 31k LSG verses takes ~0.5 s: done off the startup path, on
 * the next macrotask, so the dashboard appears first. Until it is ready,
 * match() simply finds nothing — quote suggestions are a bonus, never a
 * dependency of the live pipeline.
 */
function lazyQuoteMatcher(data: OfflineBibleData): { match(text: string): QuoteMatch | null } {
  // The index is built once per process and reused across service restarts
  // (ASR strategy, local ASR, branding): each rebuild blocked the main
  // process for ~0.65 s, stalling audio, WS and the dashboard mid-service.
  if (sharedQuoteMatcher?.data !== data && !quoteMatcherBuildPending) {
    quoteMatcherBuildPending = true
    setTimeout(() => {
      quoteMatcherBuildPending = false
      try {
        const startedAt = performance.now()
        sharedQuoteMatcher = { data, matcher: new QuoteMatcher(data) }
        logger.info({
          component: "main",
          event: "quote-matcher.ready",
          durationMs: Math.round(performance.now() - startedAt),
          metadata: { verses: sharedQuoteMatcher.matcher.size },
        })
      } catch (err) {
        logger.error({ component: "main", event: "quote-matcher.failed", error: err instanceof Error ? err.message : String(err) })
      }
    }, 0)
  }
  return { match: (text) => (sharedQuoteMatcher?.data === data ? sharedQuoteMatcher.matcher.match(text) : null) }
}

let sharedQuoteMatcher: { readonly data: OfflineBibleData; readonly matcher: QuoteMatcher } | null = null
let quoteMatcherBuildPending = false

/**
 * The bundled Bible is immutable for the life of the process: parse it once
 * and share it across service restarts. A failed load is not cached, so the
 * next restart retries.
 */
let offlineBibleDataPromise: Promise<OfflineBibleData> | null = null
function getOfflineBibleData(): Promise<OfflineBibleData> {
  if (!offlineBibleDataPromise) {
    offlineBibleDataPromise = loadOfflineBibleData().catch((err: unknown) => {
      offlineBibleDataPromise = null
      throw err
    })
  }
  return offlineBibleDataPromise
}

/**
 * ARCHITECTURE.md section 107 — shared by startServices() (at launch/setup)
 * and set-french-translation (a live switch) so the two never drift: the
 * bundled offline fallback (ARCHITECTURE.md section 77) is Louis Segond
 * 1910-specific data, so it only ever wraps the "ls1910" source. Any other
 * translation (currently just "darby") is live-API-only — a real,
 * documented limitation (AGENTS.md section 46: an honest gap, not a silent
 * one), surfaced the same way section 77's own "degrades to the plain live
 * source" comment already documents for when the bundle itself fails to
 * load.
 */
async function buildFrenchSource(translation: string): Promise<VerseSource> {
  if (translation !== "ls1910") return new GetBibleVerseSource(undefined, translation)
  try {
    const offlineData = await getOfflineBibleData()
    return new OfflineFallbackVerseSource({
      primary: new GetBibleVerseSource(undefined, "ls1910"),
      offline: new OfflineVerseSource(offlineData),
      logger,
    })
  } catch (err) {
    logger.error({
      component: "main",
      event: "offline-bible-data.load-failed",
      error: err instanceof Error ? err.message : String(err),
    })
    return new GetBibleVerseSource(undefined, "ls1910")
  }
}

function getConfigStore(): ConfigStore {
  if (!configStore) {
    throw new Error("configStore accessed before initialization")
  }
  return configStore
}

/**
 * Starts AppCore + StaticServer for a config that already has a Groq key
 * — called either at launch (if a key was already saved from a previous
 * run) or once the operator finishes the setup screen for the first time.
 */
async function startServices(
  config: AppConfig
): Promise<{
  port: number
  token: string
  remoteUrl: string | null
  allowPhoneRemote: boolean
  overlayUrl: string
  ndi: ReturnType<NDIOutput["getStatus"]>
  organizationName?: string
  accentColor?: string
  frenchTranslation: string
  overlayTemplate: string
}> {
  if (appCoreHandle && activeConfig && sameServiceConfig(activeConfig, config) && currentTokens && currentOverlayUrl) {
    return {
      port: appCoreHandle.wsServer.port,
      token: currentTokens.operatorToken,
      remoteUrl: currentRemoteUrl,
      allowPhoneRemote: currentAllowPhoneRemote,
      overlayUrl: currentOverlayUrl,
      ndi: ndiOutput?.getStatus() ?? { state: "disabled" as const },
      organizationName: config.organizationName,
      accentColor: config.accentColor,
      frenchTranslation: currentFrenchTranslation,
      overlayTemplate: currentOverlayTemplate,
    }
  }
  // Setup can be submitted again after a partial startup failure. Tear down
  // any previous listeners first so a retry never inherits 8787/8788.
  if (appCoreHandle || staticServer || remoteStaticServer || ndiOutput) {
    await shutdown()
  }
  currentTokens = { operatorToken: config.operatorToken, viewerToken: config.viewerToken }
  // ARCHITECTURE.md section 77: a live-API outage (the venue's own
  // internet, or the API itself) no longer means the French source stops
  // resolving verses at all — a bundled, always-available offline Bible
  // backs it up. Degrades to the plain live source, unwrapped, if the
  // bundled data somehow fails to load (a real packaging bug worth
  // logging loudly, but not worth failing the entire app over — the live
  // source alone is exactly what shipped before this feature existed).
  // quoteSource (post-service quote-matching, ARCHITECTURE.md section 65.8)
  // always wants the bundled LSG data regardless of which French
  // translation is actively displayed — a separate, unrelated consumer of
  // the same file buildFrenchSource() also reads for its own offline
  // fallback.
  let quoteSource: OfflineBibleData | null = null
  try {
    quoteSource = await getOfflineBibleData()
  } catch {
    // Already logged inside buildFrenchSource()/getOfflineBibleData()'s own
    // error path if this same load is attempted there too; nothing further
    // to do here beyond quoteSource staying null (section 65.8 already
    // treats a missing quoteMatcher as an optional capability).
  }
  const frenchTranslation = config.frenchTranslation ?? "ls1910"
  const frenchSource = await buildFrenchSource(frenchTranslation)
  localizedVerseSource = new LocalizedVerseSource(
    new FreeApiSource(),
    frenchSource,
    config.displayMode,
    logger,
    frenchTranslation
  )

  // ARCHITECTURE.md section 65.6: opt-in, off by default — binding to
  // 0.0.0.0 (reachable from the local network) only ever happens when the
  // operator explicitly enabled the phone remote. Otherwise this stays
  // undefined, so ChurchOverlayWsServer keeps its existing 127.0.0.1-only
  // default (section 24) exactly as before this feature existed.
  const wsHost = config.allowPhoneRemote ? "0.0.0.0" : undefined

  const plan = planAsr({
    groqApiKey: config.groqApiKey,
    deepgramApiKey: config.deepgramApiKey,
    preferred: config.asrStrategy,
  })
  groqAsr = config.groqApiKey
    ? new GroqProvider({
        apiKey: config.groqApiKey,
        logger,
        chunkDurationMs: getAudioProfileSettings(config.audioProfile).chunkDurationMs,
        language: whisperLanguageFor(config.displayMode),
      })
    : null
  deepgramAsr = config.deepgramApiKey
    ? new DeepgramProvider({
        apiKey: config.deepgramApiKey,
        language: deepgramLanguageFor(config.displayMode),
      })
    : null
  // Offline last resort, only when the operator enabled it AND the engine
  // is actually installed — never a surprise download at service start.
  const localModel: LocalModelId = config.localAsrModel ?? "base"
  const localStatus = config.localAsrEnabled ? await getLocalAsrInstaller().status(localModel) : null
  await localWhisperServer?.stop()
  localWhisperServer = null
  localAsr = null
  if (localStatus?.state === "ready") {
    localWhisperServer = new WhisperServerProcess({ serverPath: localStatus.serverPath, modelPath: localStatus.modelPath, logger })
    localAsr = new LocalWhisperProvider({ server: localWhisperServer, language: whisperLanguageFor(config.displayMode), logger })
    // Warm up now, in the background: loading the model takes seconds, and
    // the moment the internet drops is exactly when there are none to spare.
    localWhisperServer.ensureStarted().catch((err) => {
      logger.error({ component: "main", event: "local-whisper.warmup-failed", error: err instanceof Error ? err.message : String(err) })
    })
  }
  const chain = asrChain(plan, localAsr !== null)
  const providers: Record<AsrProviderId, GroqProvider | DeepgramProvider | LocalWhisperProvider | null> = {
    groq: groqAsr,
    deepgram: deepgramAsr,
    local: localAsr,
  }
  const labels: Record<AsrProviderId, string> = { groq: "Groq", deepgram: "Deepgram", local: "Whisper local" }
  // Build from the end: each link wraps "itself → everything after it".
  let composed: GroqProvider | DeepgramProvider | LocalWhisperProvider | FailoverAsrProvider = providers[chain[chain.length - 1] as AsrProviderId]!
  for (let i = chain.length - 2; i >= 0; i--) {
    const id = chain[i] as AsrProviderId
    composed = new FailoverAsrProvider({
      primary: providers[id]!,
      secondary: composed,
      // A streaming socket either works or it doesn't: fail over on any
      // error. A batch provider only after sustained 429s or sustained
      // network errors (GroqProvider signals both the same way).
      trigger: id === "deepgram" ? "primary-error" : "sustained-rate-limit",
      secondaryLabel: labels[chain[i + 1] as AsrProviderId],
    })
  }
  asrProvider = composed
  logger.info({ component: "main", event: "asr.plan", metadata: { ...plan, chain } })

  appCoreHandle = await startAppCore({
    asr: asrProvider!,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: localizedVerseSource,
    logger,
    ...(quoteSource ? { quoteMatcher: lazyQuoteMatcher(quoteSource) } : {}),
    silenceGate: new SilenceGate({ threshold: getAudioProfileSettings(config.audioProfile).silenceThreshold }),
    adaptiveGain: new AdaptiveGain({ enabled: config.autoGain ?? true }),
    onAutoGainChanged: (enabled) => {
      if (activeConfig) activeConfig = { ...activeConfig, autoGain: enabled }
      getConfigStore()
        .update((existing) => ({ ...existing, autoGain: enabled }))
        .catch((err) => {
          logger.error({
            component: "main",
            event: "auto-gain-persist-failed",
            error: err instanceof Error ? err.message : String(err),
          })
        })
    },
    host: wsHost,
    port: WS_PORT,
    tokens: currentTokens,
    mediaLibrary: mediaLibrary ?? undefined,
    sessionHistoryStore: sessionHistoryStore ?? undefined,
    verseConfirmationMode: config.verseConfirmationMode,
    organizationName: config.organizationName,
    accentColor: config.accentColor,
    overlayTemplate: config.overlayTemplate,
    ...(config.overlayStyle ? { overlayStyle: config.overlayStyle } : {}),
    // ARCHITECTURE.md section 65.7: always constructed (it makes no
    // network call until summarize() is actually invoked, and holding it
    // ready costs nothing) — reuses the same Groq API key already
    // established for ASR, not a second AI vendor. Gated by
    // sermonNotesEnabled below, so a live dashboard toggle can turn it on
    // mid-service without reconstructing AppCore.
    ...(config.groqApiKey ? { sermonNotesGenerator: new SermonNotesGenerator({ apiKey: config.groqApiKey }) } : {}),
    sermonNotesEnabled: config.enableSermonNotes,
    // ARCHITECTURE.md section 65.4: a voice-triggered display-mode switch
    // persists exactly like the set-display-mode IPC handler below does,
    // so it survives a restart identically to a dashboard-toggled one.
    onDisplayModeChanged: (mode) => {
      setAsrLanguage(mode)
      getConfigStore()
        .update((existing) => ({ ...existing, displayMode: mode }))
        .catch((err) => {
          logger.error({
            component: "main",
            event: "display-mode-persist-failed",
            error: err instanceof Error ? err.message : String(err),
          })
        })
    },
    verseLayout: config.verseLayout,
    onVerseLayoutChanged: (layout) => {
      currentVerseLayout = layout
      getConfigStore()
        .update((existing) => ({ ...existing, verseLayout: layout }))
        .catch((err) => {
          logger.error({
            component: "main",
            event: "verse-layout-persist-failed",
            error: err instanceof Error ? err.message : String(err),
          })
        })
    },
  })

  staticServer = new StaticServer({
    port: OVERLAY_HTTP_PORT,
    rootDir: join(REPO_ROOT, "apps", "overlay", "public"),
    // Without this, "/media/<id>" 404s regardless of what the overlay
    // itself tries to render (ARCHITECTURE.md section 60.4) — found
    // missing entirely during a full-codebase audit, alongside the
    // overlay never having any media-rendering code to call it in the
    // first place (both fixed together).
    mediaResolver: mediaLibrary ?? undefined,
    // ARCHITECTURE.md section 110.6: the church logo, served at /brand/logo.
    brandLogoPath: () => getOverlayStyleController().currentLogoPath(),
  })
  await staticServer.ready

  // ARCHITECTURE.md section 65.6: the remote page's own StaticServer only
  // ever runs when the operator opted in — no point exposing a second
  // HTTP server on the network for a feature nobody enabled. Loopback-only
  // installs (the default) are completely unaffected by this block.
  let remoteUrl: string | null = null
  if (config.allowPhoneRemote) {
    remoteStaticServer = new StaticServer({
      host: "0.0.0.0",
      port: REMOTE_HTTP_PORT,
      rootDir: join(REPO_ROOT, "apps", "remote", "public"),
    })
    await remoteStaticServer.ready
    const lanIp = getLanIpAddress()
    if (lanIp) {
      remoteUrl =
        `http://${lanIp}:${remoteStaticServer.port}/index.html` +
        `?token=${config.operatorToken}&wsPort=${appCoreHandle.wsServer.port}`
    } else {
      logger.warn({ component: "main", event: "remote.no-lan-ip-found" })
    }
  }
  // ARCHITECTURE.md section 69: this same URL now drives both the "OBS
  // Overlay" settings card (a copyable link for a real OBS Browser
  // Source) and the Live view's embedded preview iframe — one URL, two
  // consumers, never a value the operator has to construct by hand.
  const overlayUrl =
    `http://127.0.0.1:${staticServer.port}/index.html` +
    `?token=${config.viewerToken}&wsPort=${appCoreHandle.wsServer.port}`
  currentOverlayUrl = overlayUrl
  currentRemoteUrl = remoteUrl
  currentAllowPhoneRemote = config.allowPhoneRemote
  currentVerseConfirmationMode = config.verseConfirmationMode
  currentEnableSermonNotes = config.enableSermonNotes
  currentVerseLayout = config.verseLayout
  currentFrenchTranslation = frenchTranslation
  currentOverlayTemplate = config.overlayTemplate ?? "classic"

  ndiOutput = new NDIOutput("ChurchOverlay", undefined, (event, error) => {
    logger.error({ component: "ndi", event, error })
  })
  if (config.ndiEnabled) {
    ndiWindow = await createNdiWindow(overlayUrl, logNdi)
    const status = await ndiOutput.start(ndiWindow.webContents as unknown as PaintSource)
    if (status.state !== "running") {
      logger.warn({ component: "ndi", event: "output.unavailable", error: status.reason })
      ndiWindow.destroy()
      ndiWindow = null
    }
  }

  logger.info({
    component: "main",
    event: "services.started",
    metadata: {
      wsPort: appCoreHandle.wsServer.port,
      httpPort: staticServer.port,
      remoteHttpPort: remoteStaticServer?.port,
    },
  })

  activeConfig = config
  return {
    port: appCoreHandle.wsServer.port,
    token: currentTokens.operatorToken,
    remoteUrl,
    allowPhoneRemote: config.allowPhoneRemote,
    overlayUrl,
    ndi: ndiOutput?.getStatus() ?? { state: "disabled" as const },
    organizationName: config.organizationName,
    accentColor: config.accentColor,
    frenchTranslation,
    overlayTemplate: currentOverlayTemplate,
  }

  function sameServiceConfig(left: AppConfig, right: AppConfig): boolean {
    return left.groqApiKey === right.groqApiKey &&
      left.deepgramApiKey === right.deepgramApiKey &&
      left.displayMode === right.displayMode &&
      left.uiLanguage === right.uiLanguage &&
      left.allowPhoneRemote === right.allowPhoneRemote &&
      left.verseConfirmationMode === right.verseConfirmationMode &&
      left.enableSermonNotes === right.enableSermonNotes &&
      left.verseLayout === right.verseLayout &&
      left.ndiEnabled === right.ndiEnabled
      && left.audioProfile === right.audioProfile
      // ARCHITECTURE.md section 94: AppCore now bakes these into its own
      // branding:update sync-on-connect broadcast, so a branding-only
      // change must trigger a fresh AppCore (like every other field here),
      // not silently keep serving stale values from whenever the cached
      // instance was first constructed.
      && left.organizationName === right.organizationName
      && left.accentColor === right.accentColor
      && left.asrStrategy === right.asrStrategy
      && left.localAsrEnabled === right.localAsrEnabled
      && left.localAsrModel === right.localAsrModel
      // ARCHITECTURE.md section 108: overlayTemplate is baked into
      // AppCore's own branding:update sync-on-connect broadcast exactly
      // like organizationName/accentColor above, so it needs the same
      // fresh-AppCore treatment on change.
      && left.overlayTemplate === right.overlayTemplate
      // frenchTranslation deliberately NOT compared here: unlike every
      // field above, it hot-swaps live (setFrenchSource()) without
      // requiring a new AppCore, so a difference must NOT force the
      // restart this function exists to avoid — see
      // set-french-translation, the only thing that ever changes it
      // outside of this function.
  }
}

function createDashboardWindow(): void {
  dashboardWindow = new BrowserWindow({
    // ARCHITECTURE.md section 66, Phase 1: sized for the sidebar app shell
    // (each view gets the full window) rather than the old 3-column bento
    // grid this size was originally tuned for.
    width: 1440,
    height: 900,
    // Window/taskbar icon on Windows and Linux (macOS takes the Dock icon
    // from the packaged .icns). Without it, `npm start` shows Electron's own.
    icon: join(REPO_ROOT, "assets", "icons", "icon.png"),
    webPreferences: {
      // ARCHITECTURE.md section 7 / AGENTS.md section 27: never enable
      // nodeIntegration merely to simplify implementation.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, "..", "preload", "index.js"),
    },
  })

  dashboardWindow.loadFile(join(REPO_ROOT, "apps", "desktop", "renderer", "index.html"))

  dashboardWindow.on("closed", () => {
    dashboardWindow = null
  })
}

/**
 * The dashboard renderer calls this once on load to decide whether to
 * show its normal operator UI or a first-run setup screen. Deliberately
 * minimal (ARCHITECTURE.md section 2.1 item 21, "minimal operator
 * dashboard"): a single API-key field, not a general settings panel —
 * rotating the key or changing other settings later isn't built yet.
 */
ipcMain.handle("get-startup-status", async () => {
  // Read fresh from disk rather than cached module state, so the setup
  // screen's own language (and, once services are running, the live
  // display-mode toggle's initial value) always reflects whatever was
  // last actually saved — including on a fresh launch, before
  // startServices() has necessarily run at all.
  let uiLanguage: UiLanguage = "en"
  let organizationName: string | undefined
  let accentColor: string | undefined
  try {
    const existing = await getConfigStore().load()
    if (existing) {
      uiLanguage = existing.uiLanguage
      organizationName = existing.organizationName
      accentColor = existing.accentColor
    }
  } catch {
    // Corrupt/unreadable config: default silently here. complete-setup's
    // own recovery path (section on setup.existing-config-unreadable)
    // is where that gets actually fixed, not this read-only status check.
  }

  if (appCoreHandle && currentTokens && localizedVerseSource) {
    return {
      ready: true,
      port: appCoreHandle.wsServer.port,
      token: currentTokens.operatorToken,
      displayMode: localizedVerseSource.getMode(),
      uiLanguage,
      remoteUrl: currentRemoteUrl,
      overlayUrl: currentOverlayUrl,
      allowPhoneRemote: currentAllowPhoneRemote,
      verseConfirmationMode: currentVerseConfirmationMode,
      enableSermonNotes: currentEnableSermonNotes,
      verseLayout: currentVerseLayout,
      frenchTranslation: currentFrenchTranslation,
      overlayTemplate: currentOverlayTemplate,
      ndi: ndiOutput?.getStatus() ?? { state: "disabled" as const },
      organizationName,
      accentColor,
      asr: currentAsrStatus(),
    }
  }
  return { ready: false, uiLanguage, ndi: { state: "disabled" as const }, organizationName, accentColor }
})


/**
 * What the dashboard's transcription settings need to render: which keys
 * exist (so it only offers a strategy choice when both do), the saved
 * preference, and whether auto-gain is on.
 */
function currentAsrStatus(): {
  hasGroq: boolean
  hasDeepgram: boolean
  strategy: AsrStrategy
  autoGain: boolean
  localEnabled: boolean
  localModel: LocalModelId
  localActive: boolean
} {
  return {
    hasGroq: Boolean(activeConfig?.groqApiKey),
    hasDeepgram: Boolean(activeConfig?.deepgramApiKey),
    strategy: activeConfig?.asrStrategy ?? "streaming-first",
    autoGain: activeConfig?.autoGain ?? true,
    localEnabled: activeConfig?.localAsrEnabled ?? false,
    localModel: activeConfig?.localAsrModel ?? "base",
    localActive: localAsr !== null,
  }
}

function getLocalAsrInstaller(): LocalAsrInstaller {
  if (!localAsrInstaller) localAsrInstaller = new LocalAsrInstaller({ rootDir: join(app.getPath("userData"), "local-asr") })
  return localAsrInstaller
}

function toModelId(value: unknown): LocalModelId {
  return value === "small" ? "small" : "base"
}

ipcMain.handle("get-local-asr-status", async (_event, model: unknown) => {
  const id = toModelId(model ?? activeConfig?.localAsrModel)
  return { install: await getLocalAsrInstaller().status(id), sizeMb: LOCAL_MODELS[id].approxMb, asr: currentAsrStatus() }
})

/** Downloads the engine + model, streaming progress to the dashboard. */
ipcMain.handle("install-local-asr", async (event, model: unknown) => {
  const id = toModelId(model)
  const sender = event.sender
  const result: LocalAsrInstallState = await getLocalAsrInstaller().install(id, (state) => {
    if (!sender.isDestroyed()) sender.send("local-asr-progress", state)
  })
  return result
})

/** Enabling or changing the model rebuilds the provider chain (services restart). */
ipcMain.handle("set-local-asr", async (_event, payload: unknown) => {
  const body = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}
  const updated = await getConfigStore().update((existing) => ({
    ...existing,
    localAsrEnabled: body.enabled === true,
    localAsrModel: toModelId(body.model ?? existing.localAsrModel),
  }))
  if (!updated) throw new Error("Services are not configured yet.")
  await startServices(updated)
  return currentAsrStatus()
})

/**
 * Switches which provider carries live audio. The provider graph is built
 * once at service start, so this saves and restarts the services; the
 * dashboard's WS client reconnects on its own (same token, same port).
 */
ipcMain.handle("set-asr-strategy", async (_event, payload: unknown) => {
  if (!ASR_STRATEGIES.includes(payload as AsrStrategy)) throw new Error("Invalid ASR strategy.")
  const updated = await getConfigStore().update((existing) => ({ ...existing, asrStrategy: payload as AsrStrategy }))
  if (!updated) throw new Error("Services are not configured yet.")
  await startServices(updated)
  return currentAsrStatus()
})

/** ARCHITECTURE.md section 63.2: the live dashboard toggle, via IPC — an operator configuration action, not something that needs to round-trip through the WS server. */
ipcMain.handle("set-display-mode", async (_event, payload: unknown) => {
  const mode = DISPLAY_MODES.includes(payload as DisplayMode) ? (payload as DisplayMode) : null
  if (!mode) {
    throw new Error("Invalid display mode.")
  }
  if (!localizedVerseSource) {
    throw new Error("Services are not started yet.")
  }
  localizedVerseSource.setMode(mode)
  setAsrLanguage(mode)

  await persistConfig((existing) => ({ ...existing, displayMode: mode }))
  return { displayMode: mode }
})

/** ARCHITECTURE.md section 63.5: same setup-default + live-toggle pattern as display mode, for the dashboard/setup UI's own language. */
ipcMain.handle("set-ui-language", async (_event, payload: unknown) => {
  const uiLanguage = UI_LANGUAGES.includes(payload as UiLanguage) ? (payload as UiLanguage) : null
  if (!uiLanguage) {
    throw new Error("Invalid UI language.")
  }

  await persistConfig((existing) => ({ ...existing, uiLanguage }))
  return { uiLanguage }
})

/**
 * ARCHITECTURE.md section 65.3: the live-toggle half of "auto-send vs.
 * review-and-approve" — no setup-screen control for this one (unlike
 * display mode/UI language), only this live dashboard toggle, since
 * "auto" is the confirmed default every install starts with regardless.
 */
ipcMain.handle("set-verse-confirmation-mode", async (_event, payload: unknown) => {
  const mode = VERSE_CONFIRMATION_MODES.includes(payload as VerseConfirmationMode)
    ? (payload as VerseConfirmationMode)
    : null
  if (!mode) {
    throw new Error("Invalid verse confirmation mode.")
  }
  if (!appCoreHandle) {
    throw new Error("Services are not started yet.")
  }
  appCoreHandle.setVerseConfirmationMode(mode)
  currentVerseConfirmationMode = mode

  await persistConfig((existing) => ({ ...existing, verseConfirmationMode: mode }))
  return { verseConfirmationMode: mode }
})

/**
 * ARCHITECTURE.md section 65.7: the live-toggle half of the AI sermon-
 * notes copilot — no setup-screen control (same reasoning as
 * set-verse-confirmation-mode above), since this is an ongoing per-
 * service choice, not a one-time install decision. "off" is the
 * confirmed default every install starts with regardless.
 */
ipcMain.handle("set-enable-sermon-notes", async (_event, payload: unknown) => {
  if (typeof payload !== "boolean") {
    throw new Error("Invalid enableSermonNotes value.")
  }
  if (!appCoreHandle) {
    throw new Error("Services are not started yet.")
  }
  appCoreHandle.setSermonNotesEnabled(payload)
  currentEnableSermonNotes = payload

  await persistConfig((existing) => ({ ...existing, enableSermonNotes: payload }))
  return { enableSermonNotes: payload }
})

/**
 * ARCHITECTURE.md section 107: the live-toggle half of French translation
 * choice — no setup-screen control (same reasoning as
 * set-verse-confirmation-mode above). Unlike allowPhoneRemote (which must
 * tear down and rebuild AppCore because the WS server's listen host is
 * fixed at construction), this swaps LocalizedVerseSource's underlying
 * French VerseSource directly — no restart, no dropped connections.
 */
ipcMain.handle("set-french-translation", async (_event, payload: unknown) => {
  if (!FRENCH_TRANSLATIONS.includes(payload as string)) {
    throw new Error("Invalid French translation.")
  }
  const translation = payload as string
  if (!localizedVerseSource) {
    throw new Error("Services are not started yet.")
  }
  const source = await buildFrenchSource(translation)
  localizedVerseSource.setFrenchSource(source, translation)
  currentFrenchTranslation = translation
  if (activeConfig) activeConfig = { ...activeConfig, frenchTranslation: translation }

  await persistConfig((existing) => ({ ...existing, frenchTranslation: translation }))
  return { frenchTranslation: translation }
})

/**
 * ARCHITECTURE.md section 108 (superseded by section 110.4): the verse card
 * design now applies LIVE through the overlay style path, so the restart and
 * operator confirmation this used to need are gone. The channel and its
 * four-name validation are kept so existing renderers keep working.
 */
ipcMain.handle("set-overlay-template", async (_event, payload: unknown) => {
  if (!OVERLAY_TEMPLATES.includes(payload as string)) {
    throw new Error("Invalid overlay template.")
  }
  const controller = getOverlayStyleController()
  const style = controller.apply({ ...controller.get(), card: payload })
  await persistConfig((existing) => ({ ...existing, overlayTemplate: payload as string }))
  return { overlayTemplate: style.card }
})

/** ARCHITECTURE.md section 110.4: dashboard-only IPC; the overlay itself never calls these (section 20). */
ipcMain.handle("get-overlay-style", () => getOverlayStyleController().get())
/** The renderer cannot import the TypeScript catalog, so it asks once for it (single source of truth). */
ipcMain.handle("get-overlay-style-meta", () => ({
  palettes: PALETTES,
  groups: OVERLAY_PALETTE_GROUPS,
  cards: OVERLAY_CARD_DESIGNS,
  fonts: OVERLAY_BRAND_FONTS,
  limits: { textMax: BRAND_TEXT_MAX, size: BRAND_NAME_SIZE, scale: BRAND_SCALE },
}))
ipcMain.handle("set-overlay-style", (_event, payload: unknown) => getOverlayStyleController().apply(payload))
ipcMain.handle("pick-brand-logo", async () => {
  if (!dashboardWindow) throw new Error("Dashboard window is not available.")
  const result = await dialog.showOpenDialog(dashboardWindow, {
    title: "Choose your church logo",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  })
  const picked = result.filePaths[0]
  if (result.canceled || !picked) return { canceled: true as const }
  try {
    return { canceled: false as const, style: await getOverlayStyleController().setLogo(picked) }
  } catch (error) {
    // A bad file is the operator's input problem, not an app fault: return the reason for the UI.
    if (error instanceof LogoRejectedError) return { canceled: false as const, error: { reason: error.reason, message: error.message } }
    throw error
  }
})
ipcMain.handle("clear-brand-logo", () => getOverlayStyleController().clearLogo())

/** Cheap read for the dashboard's NDI status line (no config load, unlike get-startup-status). */
ipcMain.handle("get-ndi-status", () => ndiOutput?.getStatus() ?? { state: "disabled" as const })

ipcMain.handle("set-ndi-enabled", async (_event, payload: unknown) => {
  if (typeof payload !== "boolean") throw new Error("Invalid ndiEnabled value.")
  if (!appCoreHandle || !currentOverlayUrl) throw new Error("Services are not started yet.")
  if (!ndiOutput) {
    ndiOutput = new NDIOutput("ChurchOverlay", undefined, (event, error) => {
      logger.error({ component: "ndi", event, error })
    })
  }

  if (payload) {
    // A retry from the error state must tear the old attempt down first: start() is a no-op while attached.
    if (ndiOutput.getStatus().state === "error") {
      await ndiOutput.stop()
      ndiWindow?.destroy()
      ndiWindow = null
    }
    if (!ndiWindow) ndiWindow = await createNdiWindow(currentOverlayUrl, logNdi)
    const status = await ndiOutput.start(ndiWindow.webContents as unknown as PaintSource)
    if (status.state !== "running") {
      ndiWindow.destroy()
      ndiWindow = null
    }
    await persistConfig((existing) => ({ ...existing, ndiEnabled: status.state === "running" }))
    return status
  }

  await ndiOutput.stop()
  ndiWindow?.destroy()
  ndiWindow = null
  await persistConfig((existing) => ({ ...existing, ndiEnabled: false }))
  return ndiOutput.getStatus()
})

// ARCHITECTURE.md section 65.6's original toggle only ever existed on the
// first-run setup screen — no way to turn it on/off afterward short of
// hand-editing config.json. Unlike set-ndi-enabled/set-enable-sermon-notes
// above, this can't just flip a running service's own flag: the WS server's
// listen host (127.0.0.1 vs 0.0.0.0) and the remote page's own StaticServer
// are both fixed at construction time (ARCHITECTURE.md section 24/65.6), so
// changing this genuinely requires tearing down and restarting AppCore —
// the same shutdown()-then-startServices() cycle complete-setup already
// runs on any other service-affecting config change. This is a real,
// visible interruption (mic/ASR/all WS clients briefly disconnect), which
// the dashboard confirms with the operator before calling this.
ipcMain.handle("set-allow-phone-remote", async (_event, payload: unknown) => {
  if (typeof payload !== "boolean") throw new Error("Invalid allowPhoneRemote value.")
  const store = getConfigStore()
  const existing = await store.load().catch(() => null)
  if (!existing) throw new Error("Services are not started yet.")
  const config: AppConfig = { ...existing, allowPhoneRemote: payload }
  await store.save(config)
  try {
    return await startServices(config)
  } catch (error) {
    // Mirrors complete-setup's own recovery path: startServices opens
    // resources in stages, so a later listener failing must not leave
    // earlier ones (e.g. the old WS server) still bound.
    await shutdown()
    throw error
  }
})

ipcMain.handle("complete-setup", async (_event, payload: unknown) => {
  const payloadObject = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}

  const groqApiKey = String(payloadObject.groqApiKey ?? "").trim()
  const deepgramApiKey = String(payloadObject.deepgramApiKey ?? "").trim()
  if (!groqApiKey && !deepgramApiKey) {
    throw new Error("A Groq or Deepgram API key is required.")
  }

  // ARCHITECTURE.md section 63.2/63.5: both default to the existing
  // established default (english/en) when the setup screen doesn't send
  // one — never trust an unrecognized value from the renderer, since it's
  // going straight into ConfigStore.
  const displayMode = DISPLAY_MODES.includes(payloadObject.displayMode as DisplayMode)
    ? (payloadObject.displayMode as DisplayMode)
    : "english"
  const uiLanguage = UI_LANGUAGES.includes(payloadObject.uiLanguage as UiLanguage)
    ? (payloadObject.uiLanguage as UiLanguage)
    : "en"
  // ARCHITECTURE.md section 65.6: opt-in, off by default — anything other
  // than a literal boolean true from the renderer is treated as false,
  // never trusted as "the operator meant to enable network exposure."
  const allowPhoneRemote = payloadObject.allowPhoneRemote === true
  const audioProfile = ["responsive", "balanced", "robust"].includes(String(payloadObject.audioProfile))
    ? (String(payloadObject.audioProfile) as AudioProfile)
    : "balanced"
  // ARCHITECTURE.md section 92: plain display strings, not secrets. Blank
  // input clears back to "no override" (the app's own neutral default),
  // rather than persisting an empty string forever.
  const organizationName = String(payloadObject.organizationName ?? "").trim()
  const accentColor = String(payloadObject.accentColor ?? "").trim()
  const asrStrategy = ASR_STRATEGIES.includes(payloadObject.asrStrategy as AsrStrategy)
    ? (payloadObject.asrStrategy as AsrStrategy)
    : undefined

  const store = getConfigStore()
  // A corrupt or unreadable existing config must not permanently block
  // setup — this handler's whole purpose is to write a fresh, valid one.
  // The exact failure the app hit on a real first run: a stale/malformed
  // config.json made ConfigStore.load() throw, which is correct for
  // load()'s own contract (fail loud on corruption) but would otherwise
  // make every subsequent complete-setup attempt fail the same way,
  // forever, with no way for the operator to recover short of manually
  // deleting the file.
  let existing: AppConfig | null = null
  try {
    existing = await store.load()
  } catch (err) {
    logger.warn({
      component: "main",
      event: "setup.existing-config-unreadable",
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const config: AppConfig = {
    groqApiKey,
    ...(deepgramApiKey || existing?.deepgramApiKey
      ? { deepgramApiKey: deepgramApiKey || existing?.deepgramApiKey }
      : {}),
    microphoneId: existing?.microphoneId ?? null,
    operatorToken: existing?.operatorToken ?? generateToken(),
    // ARCHITECTURE.md section 65.3: not a setup-screen control (unlike
    // displayMode/uiLanguage) — "auto" is the confirmed default for every
    // fresh install; changeable afterward via the live dashboard toggle
    // only (set-verse-confirmation-mode), which persists it from then on.
    verseConfirmationMode: existing?.verseConfirmationMode ?? "auto",
    // ARCHITECTURE.md section 65.7: not a setup-screen control (same
    // reasoning as verseConfirmationMode above) — "off" is the confirmed
    // default for every fresh install; changeable afterward only via the
    // live dashboard toggle (set-enable-sermon-notes).
    enableSermonNotes: existing?.enableSermonNotes ?? false,
    // ARCHITECTURE.md section 82: not a setup-screen control (same
    // reasoning as verseConfirmationMode above) — "fullscreen" is the
    // confirmed default for every fresh install; changeable afterward
    // only via the live dashboard toggle (layout:set).
    verseLayout: existing?.verseLayout ?? "fullscreen",
    // ARCHITECTURE.md section 107: not a setup-screen control (same
    // reasoning as verseConfirmationMode above) — "ls1910" is the
    // confirmed default for every fresh install; changeable afterward via
    // the live dashboard toggle (set-french-translation).
    frenchTranslation: existing?.frenchTranslation ?? "ls1910",
    // ARCHITECTURE.md section 108: same reasoning — "classic" is the
    // confirmed default; changeable afterward via the live dashboard
    // toggle (set-overlay-template).
    overlayTemplate: existing?.overlayTemplate ?? "classic",
    viewerToken: existing?.viewerToken ?? generateToken(),
    displayMode,
    uiLanguage,
    allowPhoneRemote,
    audioProfile: existing?.audioProfile ?? audioProfile,
    ndiEnabled: existing?.ndiEnabled ?? false,
    ...(organizationName || existing?.organizationName
      ? { organizationName: organizationName || existing?.organizationName }
      : {}),
    ...(accentColor || existing?.accentColor ? { accentColor: accentColor || existing?.accentColor } : {}),
    ...(asrStrategy || existing?.asrStrategy ? { asrStrategy: asrStrategy ?? existing?.asrStrategy } : {}),
  }
  await store.save(config)

  try {
    return await startServices(config)
  } catch (error) {
    // startServices opens resources in stages. If a later listener fails,
    // release every earlier listener before returning the IPC error.
    await shutdown()
    throw error
  }
})

/**
 * Persists one config change without clobbering concurrent ones
 * (ConfigStore.update is serialized). A failure is logged, not thrown:
 * the live setting already applied, and refusing the toggle because the
 * file could not be written would be worse than losing persistence once.
 */
async function persistConfig(mutate: (current: AppConfig) => AppConfig): Promise<void> {
  try {
    await getConfigStore().update(mutate)
  } catch (err) {
    logger.error({ component: "main", event: "config.persist-failed", error: err instanceof Error ? err.message : String(err) })
  }
}

ipcMain.handle("get-operator-connection-info", () => {
  if (!appCoreHandle || !currentTokens) {
    throw new Error("services are not started yet")
  }
  return { port: appCoreHandle.wsServer.port, token: currentTokens.operatorToken }
})

/**
 * ARCHITECTURE.md section 60.4 points 1-2: the renderer only ever asks
 * for a file to be picked — it never receives a raw filesystem path
 * back. dialog.showOpenDialog happens here in the main process, and the
 * actual file copy is deferred to confirm-media-import below: this
 * handler now only picks the file and returns a suggested title for the
 * renderer's confirmation step (ARCHITECTURE.md section 74) — the
 * title IS the voice-trigger phrase (section 60.3), so silently
 * defaulting to a filename-derived one without ever asking was a real
 * missing-feature gap, not a style choice.
 */
ipcMain.handle("import-media-file", async () => {
  if (!dashboardWindow) {
    throw new Error("dashboard window is not available")
  }
  if (!mediaLibrary) {
    throw new Error("media library is not initialized yet")
  }

  const result = await dialog.showOpenDialog(dashboardWindow, {
    title: "Import media",
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] },
      { name: "Video", extensions: ["mp4", "webm"] },
      { name: "Audio", extensions: ["mp3", "wav", "m4a"] },
    ],
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true as const }
  }

  const filePath = result.filePaths[0] as string
  const kind = inferMediaKind(filePath)
  if (!kind) {
    return { canceled: false as const, error: "That file type isn't supported." }
  }

  pendingMediaImport = { filePath, kind }
  return { canceled: false as const, needsTitle: true as const, suggestedTitle: deriveTitleFromFilename(filePath) }
})

/**
 * ARCHITECTURE.md section 112: a file dragged from Windows Explorer onto
 * the dashboard. The preload turns the dropped File into its path with
 * webUtils.getPathForFile() (the renderer itself never sees it) and sends
 * it here, where it is checked before any filesystem access, then joins
 * the exact same pending-import -> title confirmation -> copy flow as the
 * file picker. Content, size and title are validated by MediaLibrary.
 */
ipcMain.handle("import-media-drop", async (_event, droppedPath: unknown) => {
  if (!mediaLibrary) {
    throw new Error("media library is not initialized yet")
  }
  const check = checkDroppedPath(droppedPath)
  if (!check.ok) {
    logger.info({ component: "main", event: "media.drop-rejected", metadata: { reason: check.error } })
    return { canceled: false as const, error: check.error }
  }
  let isFile = false
  try {
    isFile = (await stat(check.filePath)).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    return { canceled: false as const, error: "That item is not a file (folders can't be imported)." }
  }
  pendingMediaImport = { filePath: check.filePath, kind: check.kind }
  return { canceled: false as const, needsTitle: true as const, suggestedTitle: deriveTitleFromFilename(check.filePath) }
})

/**
 * ARCHITECTURE.md section 74: completes the import started by
 * import-media-file above, once the operator has confirmed or edited
 * the suggested title in the renderer's own dialog. Still the only place
 * the actual file copy happens — the renderer supplies just the final
 * title text, never a path.
 */
ipcMain.handle("confirm-media-import", async (_event, title: string) => {
  if (!mediaLibrary) {
    throw new Error("media library is not initialized yet")
  }
  const pending = pendingMediaImport
  if (!pending) {
    return { error: "No import is pending — pick a file again." }
  }

  // A title problem keeps the file pending so the operator can fix the
  // title in the still-open dialog and confirm again. It used to clear the
  // pending file first, so a duplicate title forced re-picking the file.
  const trimmedTitle = typeof title === "string" ? title.trim() : ""
  if (!trimmedTitle) {
    return { error: "Title cannot be empty." }
  }

  try {
    const cue = await mediaLibrary.import(pending.filePath, trimmedTitle, pending.kind)
    pendingMediaImport = null
    logger.info({ component: "main", event: "media.imported", metadata: { id: cue.id, kind: cue.kind } })
    return { cue }
  } catch (err) {
    const retryable = err instanceof MediaImportError && isTitleErrorCode(err.code)
    if (!retryable) pendingMediaImport = null
    logger.warn({
      component: "main",
      event: "media.import-failed",
      metadata: { code: err instanceof MediaImportError ? err.code : "io", retryable },
      error: err instanceof Error ? err.message : String(err),
    })
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

/** ARCHITECTURE.md section 74: the operator dismissed the title dialog without confirming — discard the pending file, nothing is imported. */
ipcMain.handle("cancel-media-import", async () => {
  pendingMediaImport = null
})

ipcMain.handle("list-media-cues", () => {
  return mediaLibrary?.list() ?? []
})

/**
 * ARCHITECTURE.md section 78: the dashboard's Voice Commands reference
 * needs to show what to actually SAY, not just which terms exist — each
 * entry's own first trigger phrase (glossary.ts's own "each entry is its
 * own English or French trigger phrase" — English entries use "define
 * X", French ones use "definis X"/"que veut dire X", never a single
 * universal template across both). GLOSSARY is a fixed, compiled-in
 * dataset, so this is a plain read, no live state to manage.
 */
ipcMain.handle("list-glossary-terms", () => {
  return GLOSSARY.map((entry) => ({ term: entry.term, examplePhrase: entry.phrases[0] }))
})

/**
 * ARCHITECTURE.md section 74: the operator confirmed a real bug — an
 * import made with the wrong file, or a title with a typo, had no fix
 * short of restarting the app and hoping the stale metadata didn't
 * survive. Rename and delete let a mistake be corrected directly.
 */
ipcMain.handle("rename-media-cue", async (_event, id: string, newTitle: string) => {
  if (!mediaLibrary) {
    throw new Error("media library is not initialized yet")
  }
  try {
    const cue = await mediaLibrary.rename(id, newTitle)
    logger.info({ component: "main", event: "media.renamed", metadata: { id: cue.id } })
    return { cue }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle("delete-media-cue", async (_event, id: string) => {
  if (!mediaLibrary) {
    throw new Error("media library is not initialized yet")
  }
  try {
    const removed = await mediaLibrary.remove(id)
    if (removed) logger.info({ component: "main", event: "media.deleted", metadata: { id } })
    return { removed }
  } catch (err) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) }
  }
})

function capitalizeBookName(book: string): string {
  return book.replace(/\b\w/g, (c) => c.toUpperCase())
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * ARCHITECTURE.md section 65.8: a "quote card" image (verse text +
 * reference), rendered by loading a small standalone HTML page into a
 * hidden BrowserWindow and screenshotting it via Electron's own
 * capturePage() — no new dependency (a hand-rolled image-encoding library
 * would need one), and no custom rendering logic of its own to get wrong,
 * unlike e.g. a hand-vendored QR encoder (section 65.6's own reasoning for
 * why THAT idea was simplified instead). Colors/typography are a
 * simplified, system-font approximation of the overlay's own card styling
 * (Georgia serif, not the overlay's Google-Fonts Instrument Serif) — a
 * static export image loaded via a data: URL can't reliably wait on a
 * network font fetch before capture, so this avoids that race entirely.
 */
async function renderQuoteCardPng(entry: SessionEntry): Promise<Buffer> {
  const reference = `${capitalizeBookName(entry.reference.book)} ${entry.reference.chapter}:${entry.reference.verse}`
  const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1920px; height: 1080px;
    display: flex; align-items: center; justify-content: center;
    background: #0a0a12;
    background-image:
      radial-gradient(at 15% 20%, rgba(124, 107, 255, 0.35) 0px, transparent 45%),
      radial-gradient(at 85% 85%, rgba(255, 111, 174, 0.3) 0px, transparent 45%);
  }
  .card { max-width: 1400px; padding: 80px; text-align: center; }
  .text { font-family: Georgia, "Times New Roman", serif; font-size: 56px; line-height: 1.5; color: #f5f5fb; }
  .ref {
    margin-top: 40px; font-family: Consolas, monospace; font-size: 26px;
    letter-spacing: 0.1em; text-transform: uppercase; color: #a996ff; font-weight: 700;
  }
</style></head>
<body>
  <div class="card">
    <div class="text">${escapeHtml(entry.text)}</div>
    <div class="ref">${escapeHtml(reference)}</div>
  </div>
</body></html>`

  // Renders already-escaped static HTML only: no script needed, so none allowed.
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: false },
  })
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html))
    const image = await win.webContents.capturePage()
    return image.toPNG()
  } finally {
    win.destroy()
  }
}

/**
 * ARCHITECTURE.md section 65.8: a plain-text transcript plus one quote-
 * card PNG per shown verse, saved to an operator-chosen folder — this
 * only repackages already-verified data the pipeline produced, nothing
 * inferred or AI-picked (the research's own "poor fit" finding for
 * AI-selected highlight moments).
 */
/**
 * ARCHITECTURE.md section 79: the dashboard's History view reads the raw
 * entries and aggregates them itself (most-shown verses, per-day
 * grouping) — main.ts stays a thin passthrough, same division of
 * responsibility as list-media-cues.
 */
ipcMain.handle("get-pipeline-latency", () => {
  return appCoreHandle?.getPipelineLatency() ?? null
})

ipcMain.handle("get-session-history", () => {
  return appCoreHandle?.getSessionHistory() ?? []
})

ipcMain.handle("export-session", async () => {
  if (!dashboardWindow) {
    throw new Error("dashboard window is not available")
  }
  if (!appCoreHandle) {
    throw new Error("services are not started yet")
  }

  const entries = appCoreHandle.getSessionEntries()
  if (entries.length === 0) {
    return { canceled: false as const, error: "Nothing was shown this session yet." }
  }

  const result = await dialog.showOpenDialog(dashboardWindow, {
    title: "Choose a folder to export to",
    properties: ["openDirectory", "createDirectory"],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true as const }
  }
  const targetDir = result.filePaths[0] as string

  const transcriptLines = entries.map((entry) => {
    const reference = `${capitalizeBookName(entry.reference.book)} ${entry.reference.chapter}:${entry.reference.verse}`
    const time = new Date(entry.timestamp).toLocaleTimeString()
    return `[${time}] ${reference} (${entry.translation})\n${entry.text}\n`
  })
  await writeFile(join(targetDir, "transcript.txt"), transcriptLines.join("\n"), "utf8")
  const uniqueReferences = new Set(entries.map((entry) =>
    `${entry.reference.book} ${entry.reference.chapter}:${entry.reference.verse}`))
  const report = {
    generatedAt: new Date().toISOString(),
    shownVerseCount: entries.length,
    uniqueReferenceCount: uniqueReferences.size,
    startedAt: entries[0]?.timestamp ?? null,
    lastShownAt: entries.at(-1)?.timestamp ?? null,
    references: [...uniqueReferences],
  }
  await writeFile(join(targetDir, "service-report.json"), JSON.stringify(report, null, 2), "utf8")

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const png = await renderQuoteCardPng(entry)
    await writeFile(join(targetDir, `quote-card-${i + 1}.png`), png)
  }

  logger.info({ component: "main", event: "session.exported", metadata: { count: entries.length, targetDir } })
  return { canceled: false as const, count: entries.length, targetDir }
})

ipcMain.handle("export-rehearsal", async () => {
  if (!dashboardWindow) {
    throw new Error("dashboard window is not available")
  }
  if (!appCoreHandle) {
    throw new Error("services are not started yet")
  }

  const entries = appCoreHandle.getSessionEntries()
  if (entries.length === 0) {
    return { canceled: false as const, error: "Nothing was shown this session yet." }
  }

  const result = await dialog.showOpenDialog(dashboardWindow, {
    title: "Choose a folder to export rehearsal report to",
    properties: ["openDirectory", "createDirectory"],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true as const }
  }
  const targetDir = result.filePaths[0] as string

  const uniqueReferences = new Set(entries.map((entry) =>
    `${entry.reference.book} ${entry.reference.chapter}:${entry.reference.verse}`))
  const report = {
    generatedAt: new Date().toISOString(),
    shownVerseCount: entries.length,
    uniqueReferenceCount: uniqueReferences.size,
    startedAt: entries[0]?.timestamp ?? null,
    lastShownAt: entries.at(-1)?.timestamp ?? null,
    references: [...uniqueReferences],
  }
  await writeFile(join(targetDir, "rehearsal-report.json"), JSON.stringify(report, null, 2), "utf8")

  logger.info({ component: "main", event: "rehearsal.exported", metadata: { count: entries.length, targetDir } })
  return { canceled: false as const, count: entries.length, targetDir }
})

ipcMain.handle("export-diagnostics", async () => {
  if (!dashboardWindow) throw new Error("dashboard window is not available")
  if (!appCoreHandle) throw new Error("services are not started yet")
  const result = await dialog.showOpenDialog(dashboardWindow, {
    title: "Choose a folder to export diagnostics to",
    properties: ["openDirectory", "createDirectory"],
  })
  if (result.canceled || result.filePaths.length === 0) return { canceled: true as const }
  const targetDir = result.filePaths[0] as string
  const path = join(targetDir, "churchoverlay-diagnostics.json")
  await writeFile(path, JSON.stringify(appCoreHandle.getDiagnostics(), null, 2), "utf8")
  logger.info({ component: "main", event: "diagnostics.exported", metadata: { targetDir } })
  return { canceled: false as const, path }
})

/**
 * ARCHITECTURE.md section 93: the post-service AI copilot summary — a
 * strictly one-shot, operator-triggered digest of already-validated data
 * (verses actually shown, plus sermon notes text the dashboard already
 * accumulated), never a live agent. Requires the same Groq API key
 * already configured for ASR/sermon notes — no new credential, no new
 * vendor. Errors are returned, never silently swallowed (AGENTS.md
 * section 46) — a missing key or a failed Groq call surfaces to the
 * operator exactly like any other setup/runtime error in this file.
 */
ipcMain.handle("generate-service-summary", async (_event, sermonNotesText: unknown) => {
  if (!appCoreHandle || !activeConfig) {
    throw new Error("services are not started yet")
  }
  const entries = appCoreHandle.getSessionEntries()
  const notesText = typeof sermonNotesText === "string" ? sermonNotesText : ""
  if (entries.length === 0 && !notesText.trim()) {
    return { error: "Nothing was shown or noted this session yet." }
  }
  if (!activeConfig.groqApiKey) {
    return { error: "A Groq API key is required to generate a service summary." }
  }
  try {
    const generator = new SermonNotesGenerator({ apiKey: activeConfig.groqApiKey })
    const input = buildServiceSummaryInput(entries, notesText)
    const summary = await generator.summarize(input, SERVICE_SUMMARY_SYSTEM_PROMPT)
    logger.info({ component: "main", event: "service-summary.generated", metadata: { verseCount: entries.length } })
    return { summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ component: "main", event: "service-summary.failed", error: message })
    return { error: message }
  }
})

async function shutdown(): Promise<void> {
  // The last overlay edit must reach disk before AppCore (and its state) goes away.
  await overlayStyleController?.flush()
  // The offline engine is a separate OS process: always stopped here so it
  // can never outlive the app and squat a port (this project has been
  // bitten by zombie child processes before).
  const whisper = localWhisperServer
  localWhisperServer = null
  localAsr = null
  await whisper?.stop().catch(() => {})
  const output = ndiOutput
  ndiOutput = null
  await output?.stop().catch((err) => {
    logger.error({ component: "ndi", event: "shutdown.failed", error: String(err) })
  })
  ndiWindow?.destroy()
  ndiWindow = null
  const core = appCoreHandle
  appCoreHandle = null
  await core?.stop().catch((err) => {
    logger.error({ component: "main", event: "shutdown.app-core-failed", error: String(err) })
  })
  const overlayServer = staticServer
  staticServer = null
  await overlayServer?.close().catch((err) => {
    logger.error({ component: "main", event: "shutdown.static-server-failed", error: String(err) })
  })
  const remoteServer = remoteStaticServer
  remoteStaticServer = null
  await remoteServer?.close().catch((err) => {
    logger.error({ component: "main", event: "shutdown.remote-static-server-failed", error: String(err) })
  })
  currentOverlayUrl = null
  currentRemoteUrl = null
  activeConfig = null
}

/**
 * Defense in depth for every window/webContents this app creates (dashboard,
 * NDI offscreen renderer, quote-card renderer). The dashboard's preload
 * exposes the operator IPC bridge: if any link, redirect or injected markup
 * ever navigated that window to an external page, that page would inherit
 * the bridge. So: no cross-origin navigation, and window.open never creates
 * an Electron window — https links go to the system browser instead.
 */
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpsUrl(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(contents.getURL(), url)) event.preventDefault()
  })
})

app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) {
    // ARCHITECTURE.md section 38: "The application must never write
    // plaintext secrets to disk." If the OS can't back safeStorage (no
    // keychain/credential store available), we must not silently fall
    // back to writing the config unencrypted, and there is no safe
    // degraded mode to run in instead — quit with a clear logged reason
    // rather than open a window that can never save a working config.
    logger.error({
      component: "main",
      event: "startup.failed",
      error: "safeStorage encryption is not available on this system.",
    })
    app.quit()
    return
  }

  configStore = new ConfigStore(join(app.getPath("userData"), "config.json"), {
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  })
  mediaLibrary = new MediaLibrary({ mediaDir: join(app.getPath("userData"), "media") })
  try {
    const report = await mediaLibrary.load()
    if (report.quarantinedPath || report.skipped > 0) {
      logger.warn({
        component: "main",
        event: "media-library.load-recovered",
        metadata: { loaded: report.loaded, skipped: report.skipped, quarantined: report.quarantinedPath !== null },
      })
    }
  } catch (err) {
    // A corrupt/unreadable metadata file must not block startup — the
    // operator can always re-import (same reasoning as the setup-time
    // config-unreadable recovery path below).
    logger.warn({
      component: "main",
      event: "media-library.load-failed",
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ARCHITECTURE.md section 79: a persistent, cross-restart verse history
  // for the dashboard's own History view — a corrupt/unreadable file is,
  // same as media-library.load-failed above, not worth blocking startup
  // over (history just starts fresh; nothing about live verse display
  // depends on it).
  sessionHistoryStore = new SessionHistoryStore({ historyDir: app.getPath("userData") })
  try {
    const report = await sessionHistoryStore.load()
    if (report.quarantinedPath || report.skipped > 0) {
      logger.warn({
        component: "main",
        event: "session-history.load-recovered",
        metadata: { loaded: report.loaded, skipped: report.skipped, quarantined: report.quarantinedPath !== null },
      })
    }
  } catch (err) {
    logger.warn({
      component: "main",
      event: "session-history.load-failed",
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // The dashboard window opens immediately either way — get-startup-status
  // (above) is what tells its renderer whether to show the setup screen
  // or connect normally, rather than main deciding that before any window
  // exists (the previous design, which quit the whole app with only a log
  // line if no key was configured — unusable for anyone without an
  // environment variable already set).
  createDashboardWindow()

  try {
    const existing = await configStore.load()
    if (existing && (existing.groqApiKey || existing.deepgramApiKey)) {
      await startServices(existing)
    }
  } catch (err) {
    logger.error({
      component: "main",
      event: "startup.services-failed",
      error: err instanceof Error ? err.message : String(err),
    })
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDashboardWindow()
    }
  })
})

app.on("window-all-closed", async () => {
  await shutdown()
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  shutdown().catch(() => {})
})
