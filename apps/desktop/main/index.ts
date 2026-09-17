import { app, BrowserWindow, ipcMain, safeStorage } from "electron"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { startAppCore, type AppCoreHandle } from "../../server/core/app-core"
import { StaticServer } from "../../server/http/static-server"
import { RegexDetector } from "../../server/detector/regex-detector"
import { KnownValidVerseIndex } from "../../server/verse/known-valid-verse-index"
import { FreeApiSource } from "../../server/verse/free-api-source"
import { GroqProvider } from "../../server/asr/groq-provider"
import { ConfigStore, type AppConfig } from "./config-store"
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

const logger = new Logger({ minLevel: "info" })

let appCoreHandle: AppCoreHandle | null = null
let staticServer: StaticServer | null = null
let dashboardWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let currentTokens: { operatorToken: string; viewerToken: string } | null = null
let configStore: ConfigStore | null = null

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

  appCoreHandle = await startAppCore({
    asr: new GroqProvider({ apiKey: config.groqApiKey }),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new FreeApiSource(),
    logger,
    port: WS_PORT,
    tokens: currentTokens,
  })

  staticServer = new StaticServer({
    port: OVERLAY_HTTP_PORT,
    rootDir: join(__dirname, "..", "..", "overlay", "public"),
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

  dashboardWindow.loadFile(join(__dirname, "..", "renderer", "index.html"))

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
ipcMain.handle("get-startup-status", () => {
  if (appCoreHandle && currentTokens) {
    return { ready: true, port: appCoreHandle.wsServer.port, token: currentTokens.operatorToken }
  }
  return { ready: false }
})

ipcMain.handle("complete-setup", async (_event, payload: unknown) => {
  const groqApiKey =
    typeof payload === "object" && payload !== null && "groqApiKey" in payload
      ? String((payload as { groqApiKey: unknown }).groqApiKey ?? "").trim()
      : ""
  if (!groqApiKey) {
    throw new Error("A Groq API key is required.")
  }

  const store = getConfigStore()
  const existing = await store.load()
  const config: AppConfig = {
    groqApiKey,
    microphoneId: existing?.microphoneId ?? null,
    operatorToken: existing?.operatorToken ?? generateToken(),
    viewerToken: existing?.viewerToken ?? generateToken(),
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
