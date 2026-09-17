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

function generateToken(): string {
  return randomBytes(24).toString("hex")
}

/**
 * First-run bootstrap: if no config exists yet, or it exists but has no
 * Groq key, seed one from GROQ_API_KEY in the environment (the same
 * pattern the repo's .env-based dev workflow already uses) and generate
 * fresh WS tokens, then persist all of it through ConfigStore so it is
 * encrypted at rest from then on. This is a deliberately minimal v1
 * bootstrap — a real settings UI for entering/rotating the Groq key is
 * not built yet; ROADMAP-worthy, not something to invent here.
 */
async function loadOrCreateConfig(configStore: ConfigStore): Promise<AppConfig> {
  const existing = await configStore.load()
  if (existing && existing.groqApiKey) {
    return existing
  }

  const groqApiKey = process.env.GROQ_API_KEY ?? existing?.groqApiKey ?? ""
  const config: AppConfig = {
    groqApiKey,
    microphoneId: existing?.microphoneId ?? null,
    operatorToken: existing?.operatorToken ?? generateToken(),
    viewerToken: existing?.viewerToken ?? generateToken(),
  }
  await configStore.save(config)
  return config
}

async function startServices(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    // ARCHITECTURE.md section 38: "The application must never write
    // plaintext secrets to disk." If the OS can't back safeStorage (no
    // keychain/credential store available), we must not silently fall
    // back to writing the config unencrypted — fail loudly instead.
    throw new Error(
      "safeStorage encryption is not available on this system — refusing to start rather than write secrets unencrypted (ARCHITECTURE.md section 38)."
    )
  }

  const configStore = new ConfigStore(join(app.getPath("userData"), "config.json"), {
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  })

  const config = await loadOrCreateConfig(configStore)
  if (!config.groqApiKey) {
    throw new Error(
      "No Groq API key configured. Set GROQ_API_KEY in the environment for first run (a real settings UI to enter it is not built yet)."
    )
  }

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
  try {
    await startServices()
  } catch (err) {
    logger.error({
      component: "main",
      event: "startup.failed",
      error: err instanceof Error ? err.message : String(err),
    })
    // ARCHITECTURE.md section 4.5 "Fail safely" is about ASR/Bible API/WS/
    // mic/cache/renderer failures once running — a failed *startup*
    // (e.g. no Groq key, no safeStorage) has nothing safe left to degrade
    // into, so quitting with a clear logged reason is correct here rather
    // than opening a window backed by services that never started.
    app.quit()
    return
  }

  createDashboardWindow()
  createOverlayWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDashboardWindow()
      createOverlayWindow()
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
