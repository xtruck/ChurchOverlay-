import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { startAppCore, type AppCoreHandle } from "../../server/core/app-core"
import { StaticServer } from "../../server/http/static-server"
import { RegexDetector } from "../../server/detector/regex-detector"
import { KnownValidVerseIndex } from "../../server/verse/known-valid-verse-index"
import { FreeApiSource } from "../../server/verse/free-api-source"
import { GetBibleVerseSource } from "../../server/verse/get-bible-verse-source"
import { LocalizedVerseSource } from "../../server/verse/localized-verse-source"
import { GroqProvider } from "../../server/asr/groq-provider"
import { MediaLibrary } from "../../server/media/media-library"
import { ConfigStore, DISPLAY_MODES, UI_LANGUAGES, type AppConfig, type UiLanguage } from "./config-store"
import type { DisplayMode } from "../../../packages/contracts"
import { inferMediaKind, deriveTitleFromFilename } from "./media-import"
import { Logger } from "../../../packages/shared/logger"

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
let dashboardWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let currentTokens: { operatorToken: string; viewerToken: string } | null = null
let configStore: ConfigStore | null = null
let mediaLibrary: MediaLibrary | null = null
let localizedVerseSource: LocalizedVerseSource | null = null

function generateToken(): string {
  return randomBytes(24).toString("hex")
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
async function startServices(config: AppConfig): Promise<{ port: number; token: string }> {
  currentTokens = { operatorToken: config.operatorToken, viewerToken: config.viewerToken }
  localizedVerseSource = new LocalizedVerseSource(
    new FreeApiSource(),
    new GetBibleVerseSource(),
    config.displayMode
  )

  appCoreHandle = await startAppCore({
    asr: new GroqProvider({ apiKey: config.groqApiKey }),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: localizedVerseSource,
    logger,
    port: WS_PORT,
    tokens: currentTokens,
    mediaLibrary: mediaLibrary ?? undefined,
  })

  staticServer = new StaticServer({
    port: OVERLAY_HTTP_PORT,
    rootDir: join(REPO_ROOT, "apps", "overlay", "public"),
  })
  await staticServer.ready

  logger.info({
    component: "main",
    event: "services.started",
    metadata: { wsPort: appCoreHandle.wsServer.port, httpPort: staticServer.port },
  })

  createOverlayWindow()

  return { port: appCoreHandle.wsServer.port, token: currentTokens.operatorToken }
}

function createDashboardWindow(): void {
  dashboardWindow = new BrowserWindow({
    width: 1100,
    height: 760,
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
 * The Overlay Renderer as its own execution context (ARCHITECTURE.md
 * section 6.3): a local preview of exactly what OBS's Browser Source
 * shows, so the operator doesn't need OBS running just to check what's
 * live. It loads the SAME page StaticServer already serves for OBS —
 * not a separate implementation — via a plain HTTP URL with the viewer
 * token baked in by the main process (which already knows it), rather
 * than a URL the operator has to construct by hand.
 *
 * No preload at all: the overlay must not access secrets, the
 * filesystem, or any Node API (section 6.3, section 33) — it needs
 * nothing beyond what any browser tab already has, so it gets nothing
 * beyond that.
 */
function createOverlayWindow(): void {
  if (!appCoreHandle || !staticServer || !currentTokens) {
    throw new Error("createOverlayWindow() called before services started")
  }

  overlayWindow = new BrowserWindow({
    width: 960,
    height: 540,
    title: "ChurchOverlay — Overlay Preview",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  const url =
    `http://127.0.0.1:${staticServer.port}/index.html` +
    `?token=${currentTokens.viewerToken}&wsPort=${appCoreHandle.wsServer.port}`
  overlayWindow.loadURL(url)

  overlayWindow.on("closed", () => {
    overlayWindow = null
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
  try {
    const existing = await getConfigStore().load()
    if (existing) uiLanguage = existing.uiLanguage
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
    }
  }
  return { ready: false, uiLanguage }
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

  const store = getConfigStore()
  const existing = await store.load().catch(() => null)
  if (existing) {
    await store.save({ ...existing, displayMode: mode })
  }
  return { displayMode: mode }
})

/** ARCHITECTURE.md section 63.5: same setup-default + live-toggle pattern as display mode, for the dashboard/setup UI's own language. */
ipcMain.handle("set-ui-language", async (_event, payload: unknown) => {
  const uiLanguage = UI_LANGUAGES.includes(payload as UiLanguage) ? (payload as UiLanguage) : null
  if (!uiLanguage) {
    throw new Error("Invalid UI language.")
  }

  const store = getConfigStore()
  const existing = await store.load().catch(() => null)
  if (existing) {
    await store.save({ ...existing, uiLanguage })
  }
  return { uiLanguage }
})

ipcMain.handle("complete-setup", async (_event, payload: unknown) => {
  const payloadObject = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}

  const groqApiKey = String(payloadObject.groqApiKey ?? "").trim()
  if (!groqApiKey) {
    throw new Error("A Groq API key is required.")
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
    microphoneId: existing?.microphoneId ?? null,
    operatorToken: existing?.operatorToken ?? generateToken(),
    viewerToken: existing?.viewerToken ?? generateToken(),
    displayMode,
    uiLanguage,
  }
  await store.save(config)

  return startServices(config)
})

ipcMain.handle("get-operator-connection-info", () => {
  if (!appCoreHandle || !currentTokens) {
    throw new Error("services are not started yet")
  }
  return { port: appCoreHandle.wsServer.port, token: currentTokens.operatorToken }
})

/**
 * ARCHITECTURE.md section 60.4 points 1-2: the renderer only ever asks
 * for a file to be picked and imported — it never receives a raw
 * filesystem path back, only the resulting MediaCue (an id + kind +
 * title). dialog.showOpenDialog and the actual file copy both happen
 * here in the main process; the operator's original path is never sent
 * anywhere past this handler.
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

  try {
    const cue = await mediaLibrary.import(filePath, deriveTitleFromFilename(filePath), kind)
    logger.info({ component: "main", event: "media.imported", metadata: { id: cue.id, kind: cue.kind } })
    return { canceled: false as const, cue }
  } catch (err) {
    return { canceled: false as const, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle("list-media-cues", () => {
  return mediaLibrary?.list() ?? []
})

async function shutdown(): Promise<void> {
  await appCoreHandle?.stop().catch((err) => {
    logger.error({ component: "main", event: "shutdown.app-core-failed", error: String(err) })
  })
  await staticServer?.close().catch((err) => {
    logger.error({ component: "main", event: "shutdown.static-server-failed", error: String(err) })
  })
}

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

  // The dashboard window opens immediately either way — get-startup-status
  // (above) is what tells its renderer whether to show the setup screen
  // or connect normally, rather than main deciding that before any window
  // exists (the previous design, which quit the whole app with only a log
  // line if no key was configured — unusable for anyone without an
  // environment variable already set).
  createDashboardWindow()

  try {
    const existing = await configStore.load()
    if (existing && existing.groqApiKey) {
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
      if (appCoreHandle) createOverlayWindow()
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
