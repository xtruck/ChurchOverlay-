import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron"
import { randomBytes } from "node:crypto"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import { startAppCore, type AppCoreHandle } from "../../server/core/app-core"
import type { SessionEntry } from "../../server/core/session-recorder"
import { StaticServer } from "../../server/http/static-server"
import { RegexDetector } from "../../server/detector/regex-detector"
import { GLOSSARY } from "../../server/glossary/glossary"
import { KnownValidVerseIndex } from "../../server/verse/known-valid-verse-index"
import { FreeApiSource } from "../../server/verse/free-api-source"
import { GetBibleVerseSource } from "../../server/verse/get-bible-verse-source"
import { LocalizedVerseSource } from "../../server/verse/localized-verse-source"
import { loadOfflineBibleData, OfflineVerseSource } from "../../server/verse/offline-verse-source"
import { OfflineFallbackVerseSource } from "../../server/verse/offline-fallback-verse-source"
import { GroqProvider } from "../../server/asr/groq-provider"
import { SermonNotesGenerator } from "../../server/ai/sermon-notes-generator"
import { MediaLibrary } from "../../server/media/media-library"
import { SessionHistoryStore } from "../../server/core/session-history-store"
import {
  ConfigStore,
  DISPLAY_MODES,
  UI_LANGUAGES,
  VERSE_CONFIRMATION_MODES,
  type AppConfig,
  type UiLanguage,
} from "./config-store"
import type { DisplayMode, MediaCueKind, VerseConfirmationMode, VerseLayout } from "../../../packages/contracts"
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
let asrProvider: GroqProvider | null = null
let currentRemoteUrl: string | null = null
let currentOverlayUrl: string | null = null
let currentAllowPhoneRemote = false
let currentVerseConfirmationMode: VerseConfirmationMode = "auto"
let currentEnableSermonNotes = false
let currentVerseLayout: VerseLayout = "fullscreen"
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
): Promise<{ port: number; token: string; remoteUrl: string | null; allowPhoneRemote: boolean; overlayUrl: string }> {
  currentTokens = { operatorToken: config.operatorToken, viewerToken: config.viewerToken }
  // ARCHITECTURE.md section 77: a live-API outage (the venue's own
  // internet, or the API itself) no longer means the French source stops
  // resolving verses at all — a bundled, always-available offline Bible
  // backs it up. Degrades to the plain live source, unwrapped, if the
  // bundled data somehow fails to load (a real packaging bug worth
  // logging loudly, but not worth failing the entire app over — the live
  // source alone is exactly what shipped before this feature existed).
  let frenchSource: GetBibleVerseSource | OfflineFallbackVerseSource = new GetBibleVerseSource()
  try {
    const offlineData = await loadOfflineBibleData()
    frenchSource = new OfflineFallbackVerseSource({
      primary: new GetBibleVerseSource(),
      offline: new OfflineVerseSource(offlineData),
      logger,
    })
  } catch (err) {
    logger.error({
      component: "main",
      event: "offline-bible-data.load-failed",
      error: err instanceof Error ? err.message : String(err),
    })
  }
  localizedVerseSource = new LocalizedVerseSource(new FreeApiSource(), frenchSource, config.displayMode, logger)

  // ARCHITECTURE.md section 65.6: opt-in, off by default — binding to
  // 0.0.0.0 (reachable from the local network) only ever happens when the
  // operator explicitly enabled the phone remote. Otherwise this stays
  // undefined, so ChurchOverlayWsServer keeps its existing 127.0.0.1-only
  // default (section 24) exactly as before this feature existed.
  const wsHost = config.allowPhoneRemote ? "0.0.0.0" : undefined

  asrProvider = new GroqProvider({
    apiKey: config.groqApiKey,
    logger,
    language: whisperLanguageFor(config.displayMode),
  })

  appCoreHandle = await startAppCore({
    asr: asrProvider,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: localizedVerseSource,
    logger,
    host: wsHost,
    port: WS_PORT,
    tokens: currentTokens,
    mediaLibrary: mediaLibrary ?? undefined,
    sessionHistoryStore: sessionHistoryStore ?? undefined,
    verseConfirmationMode: config.verseConfirmationMode,
    // ARCHITECTURE.md section 65.7: always constructed (it makes no
    // network call until summarize() is actually invoked, and holding it
    // ready costs nothing) — reuses the same Groq API key already
    // established for ASR, not a second AI vendor. Gated by
    // sermonNotesEnabled below, so a live dashboard toggle can turn it on
    // mid-service without reconstructing AppCore.
    sermonNotesGenerator: new SermonNotesGenerator({ apiKey: config.groqApiKey }),
    sermonNotesEnabled: config.enableSermonNotes,
    // ARCHITECTURE.md section 65.4: a voice-triggered display-mode switch
    // persists exactly like the set-display-mode IPC handler below does,
    // so it survives a restart identically to a dashboard-toggled one.
    onDisplayModeChanged: (mode) => {
      asrProvider?.setLanguage(whisperLanguageFor(mode))
      getConfigStore()
        .load()
        .then((existing) => (existing ? getConfigStore().save({ ...existing, displayMode: mode }) : undefined))
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
        .load()
        .then((existing) => (existing ? getConfigStore().save({ ...existing, verseLayout: layout }) : undefined))
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

  logger.info({
    component: "main",
    event: "services.started",
    metadata: {
      wsPort: appCoreHandle.wsServer.port,
      httpPort: staticServer.port,
      remoteHttpPort: remoteStaticServer?.port,
    },
  })

  return {
    port: appCoreHandle.wsServer.port,
    token: currentTokens.operatorToken,
    remoteUrl,
    allowPhoneRemote: config.allowPhoneRemote,
    overlayUrl,
  }
}

function createDashboardWindow(): void {
  dashboardWindow = new BrowserWindow({
    // ARCHITECTURE.md section 66, Phase 1: sized for the sidebar app shell
    // (each view gets the full window) rather than the old 3-column bento
    // grid this size was originally tuned for.
    width: 1440,
    height: 900,
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
      remoteUrl: currentRemoteUrl,
      overlayUrl: currentOverlayUrl,
      allowPhoneRemote: currentAllowPhoneRemote,
      verseConfirmationMode: currentVerseConfirmationMode,
      enableSermonNotes: currentEnableSermonNotes,
      verseLayout: currentVerseLayout,
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
  asrProvider?.setLanguage(whisperLanguageFor(mode))

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

  const store = getConfigStore()
  const existing = await store.load().catch(() => null)
  if (existing) {
    await store.save({ ...existing, verseConfirmationMode: mode })
  }
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

  const store = getConfigStore()
  const existing = await store.load().catch(() => null)
  if (existing) {
    await store.save({ ...existing, enableSermonNotes: payload })
  }
  return { enableSermonNotes: payload }
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
  // ARCHITECTURE.md section 65.6: opt-in, off by default — anything other
  // than a literal boolean true from the renderer is treated as false,
  // never trusted as "the operator meant to enable network exposure."
  const allowPhoneRemote = payloadObject.allowPhoneRemote === true

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
    viewerToken: existing?.viewerToken ?? generateToken(),
    displayMode,
    uiLanguage,
    allowPhoneRemote,
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
  pendingMediaImport = null

  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { error: "Title cannot be empty." }
  }

  try {
    const cue = await mediaLibrary.import(pending.filePath, trimmedTitle, pending.kind)
    logger.info({ component: "main", event: "media.imported", metadata: { id: cue.id, kind: cue.kind } })
    return { cue }
  } catch (err) {
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

  const win = new BrowserWindow({ width: 1920, height: 1080, show: false, webPreferences: { offscreen: true } })
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

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const png = await renderQuoteCardPng(entry)
    await writeFile(join(targetDir, `quote-card-${i + 1}.png`), png)
  }

  logger.info({ component: "main", event: "session.exported", metadata: { count: entries.length, targetDir } })
  return { canceled: false as const, count: entries.length, targetDir }
})

async function shutdown(): Promise<void> {
  await appCoreHandle?.stop().catch((err) => {
    logger.error({ component: "main", event: "shutdown.app-core-failed", error: String(err) })
  })
  await staticServer?.close().catch((err) => {
    logger.error({ component: "main", event: "shutdown.static-server-failed", error: String(err) })
  })
  await remoteStaticServer?.close().catch((err) => {
    logger.error({ component: "main", event: "shutdown.remote-static-server-failed", error: String(err) })
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
  try {
    await mediaLibrary.load()
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
    await sessionHistoryStore.load()
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
