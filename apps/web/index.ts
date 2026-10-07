import "dotenv/config"
import express, { type Request, type Response } from "express"
import { createServer } from "node:http"
import { extname, join } from "node:path"
import { mkdir, writeFile, unlink } from "node:fs/promises"
import { randomBytes } from "node:crypto"

import { startAppCore, type AppCoreHandle } from "../server/core/app-core"
import { FreeApiSource } from "../server/verse/free-api-source"
import { GetBibleVerseSource } from "../server/verse/get-bible-verse-source"
import { LocalizedVerseSource } from "../server/verse/localized-verse-source"
import { loadOfflineBibleData, OfflineVerseSource } from "../server/verse/offline-verse-source"
import { OfflineFallbackVerseSource } from "../server/verse/offline-fallback-verse-source"
import { RegexDetector } from "../server/detector/regex-detector"
import { KnownValidVerseIndex } from "../server/verse/known-valid-verse-index"
import { MediaImportError, MediaLibrary } from "../server/media/media-library"
import { SessionHistoryStore } from "../server/core/session-history-store"
import { SermonNotesGenerator } from "../server/ai/sermon-notes-generator"
import {
  buildYouTubeDescription,
  generatePreachingAnalytics,
  generateSocialQuoteCardSvg,
} from "../server/ai/service-summary"
import { Logger } from "../../packages/shared/logger"
import { HybridAsrProvider } from "../server/asr/hybrid-provider"
import { GLOSSARY } from "../server/glossary/glossary"
import { getCrossReferences, prefetchCrossReferences } from "../server/verse/cross-reference-engine"
import { analyzeSermonFlow } from "../server/ai/sermon-flow-analyzer"
import type { DisplayMode, VerseConfirmationMode, MediaCueKind } from "../../packages/contracts"
import { buildPageUrls, buildStatusPayload, isDisplayMode, isUiLanguage, type UiLanguage } from "./status-payload"
import { installApiGuard, isLoopbackHost, resolveWebHost, validateConfiguredTokens } from "./api-auth"

export type { UiLanguage } from "./status-payload"

const PORT = 3000
// Loopback unless WEB_HOST is set on purpose (ARCHITECTURE.md sections 24 and 49).
const HOST = resolveWebHost(process.env.WEB_HOST)

// Compiled to dist/apps/web/index.js — three levels up reaches the repo
// root, matching apps/desktop/main/index.ts's own REPO_ROOT pattern
// (ARCHITECTURE.md section 80). Resolving from __dirname rather than
// process.cwd() means static/data paths are correct regardless of the
// directory the process was launched from.
const REPO_ROOT = join(__dirname, "..", "..", "..")

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

const logger = new Logger({ minLevel: "info" })

async function main() {
  const app = express()

  const httpServer = createServer(app)

  // Tokens
  const tokenError = validateConfiguredTokens(process.env.OPERATOR_TOKEN, process.env.VIEWER_TOKEN)
  if (tokenError) {
    logger.error({ component: "server", event: "server.invalid-tokens", error: tokenError })
    console.error(`ChurchOverlay Server not started: ${tokenError}`)
    process.exit(1)
  }
  const tokens = {
    operatorToken: process.env.OPERATOR_TOKEN || randomBytes(16).toString("hex"),
    viewerToken: process.env.VIEWER_TOKEN || randomBytes(16).toString("hex"),
  }

  // Every /api route requires the operator token, and is checked before the
  // 50 MB media-upload body is parsed. Registered before any /api route.
  installApiGuard(app, tokens.operatorToken, "50mb")

  // Every page URL this server advertises, built in one place
  // (SECURITY.md item 13, ARCHITECTURE.md section 106). Read-only pages —
  // overlay, Stage Display, Live Companion — carry the viewer token; only
  // the phone remote carries the operator token.
  const pageUrls = buildPageUrls({ port: PORT, ...tokens })

  // Configuration state
  let groqApiKey = process.env.GROQ_API_KEY || ""
  let displayMode: DisplayMode = "english"
  let uiLanguage: UiLanguage = "en"
  let verseConfirmationMode: VerseConfirmationMode = "auto"
  let allowPhoneRemote = true
  let enableSermonNotes = false

  // Data directories
  const dataDir = join(REPO_ROOT, "data")
  const mediaDir = join(dataDir, "media")
  const tempDir = join(dataDir, "temp")
  await mkdir(mediaDir, { recursive: true })
  await mkdir(tempDir, { recursive: true })

  const mediaLibrary = new MediaLibrary({ mediaDir })
  const mediaLoadReport = await mediaLibrary.load()
  if (mediaLoadReport.quarantinedPath || mediaLoadReport.skipped > 0) {
    logger.warn({
      component: "server",
      event: "media-library.load-recovered",
      metadata: { loaded: mediaLoadReport.loaded, skipped: mediaLoadReport.skipped, quarantined: mediaLoadReport.quarantinedPath !== null },
    })
  }

  const sessionHistoryStore = new SessionHistoryStore({ historyDir: dataDir })
  const historyLoadReport = await sessionHistoryStore.load()
  if (historyLoadReport.quarantinedPath || historyLoadReport.skipped > 0) {
    logger.warn({
      component: "server",
      event: "session-history.load-recovered",
      metadata: { loaded: historyLoadReport.loaded, skipped: historyLoadReport.skipped, quarantined: historyLoadReport.quarantinedPath !== null },
    })
  }

  // Bible Sources
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
      component: "server",
      event: "offline-bible-data.load-failed",
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const localizedVerseSource = new LocalizedVerseSource(
    new FreeApiSource(),
    frenchSource,
    displayMode,
    logger
  )

  const hybridAsr = new HybridAsrProvider({
    apiKey: groqApiKey,
    logger,
    language: whisperLanguageFor(displayMode),
  })
  let sermonNotesGen: SermonNotesGenerator | undefined = groqApiKey
    ? new SermonNotesGenerator({ apiKey: groqApiKey })
    : undefined

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error({
        component: "server",
        event: "server.eaddrinuse",
        error: `Port ${PORT} is already in use.`,
      })
      process.exit(1)
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(PORT, HOST, () => {
      httpServer.removeListener("error", reject)
      logger.info({
        component: "server",
        event: "server.listening",
      })
      console.log(`ChurchOverlay Server listening at http://${HOST}:${PORT}`)
      if (!isLoopbackHost(HOST)) {
        console.log(`WARNING: bound to ${HOST}, reachable from the network. Anyone with the page URLs below holds those tokens; use a trusted network.`)
      }
      console.log(`Overlay URL: http://${HOST}:${PORT}${pageUrls.overlay}`)
      console.log(`Remote URL: http://${HOST}:${PORT}${pageUrls.remote}`)
      console.log(`Stage Display URL: http://${HOST}:${PORT}${pageUrls.stage}`)
      console.log(`Live Companion URL: http://${HOST}:${PORT}${pageUrls.live}`)
      resolve()
    })
  })

  let appCoreHandle: AppCoreHandle | null = null

  appCoreHandle = await startAppCore({
    asr: hybridAsr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: localizedVerseSource,
    logger,
    server: httpServer,
    port: PORT,
    tokens,
    mediaLibrary,
    sessionHistoryStore,
    verseConfirmationMode,
    sermonNotesGenerator: sermonNotesGen,
    sermonNotesEnabled: enableSermonNotes,
    onDisplayModeChanged: (mode) => {
      displayMode = mode
    },
  })

  // Static serving for Media
  app.get("/media/:id", (req: Request, res: Response) => {
    const id = typeof req.params.id === "string" ? req.params.id : Array.isArray(req.params.id) ? req.params.id[0] : ""
    const filePath = id ? mediaLibrary.resolveFilePath(id) : null
    if (!filePath) {
      res.status(404).send("Media not found")
      return
    }
    res.sendFile(filePath)
  })

  // API Endpoints

  // Both endpoints below return this exact body — one source of truth, in
  // status-payload.ts, so the URL/token contract is unit-testable without
  // booting this server.
  const currentStatusPayload = () =>
    buildStatusPayload({
      port: PORT,
      ...tokens,
      hasGroqKey: Boolean(groqApiKey),
      displayMode,
      uiLanguage,
      verseConfirmationMode,
      enableSermonNotes,
      allowPhoneRemote,
    })

  app.get("/api/status", (_req: Request, res: Response) => {
    res.json(currentStatusPayload())
  })

  app.post("/api/setup", async (req: Request, res: Response) => {
    try {
      const body = req.body || {}
      // Validate everything BEFORE applying any of it, with the same value
      // sets /api/mode and /api/language accept. The old `as` casts let an
      // arbitrary string reach LocalizedVerseSource (which fell into its
      // bilingual branch) and be echoed back through /api/status.
      if (body.displayMode !== undefined && body.displayMode !== "" && !isDisplayMode(body.displayMode)) {
        res.status(400).json({ error: "Invalid displayMode" })
        return
      }
      if (body.uiLanguage !== undefined && body.uiLanguage !== "" && !isUiLanguage(body.uiLanguage)) {
        res.status(400).json({ error: "Invalid uiLanguage" })
        return
      }
      if (typeof body.groqApiKey === "string") {
        groqApiKey = body.groqApiKey.trim()
        hybridAsr.setApiKey(groqApiKey)
      }
      if (isDisplayMode(body.displayMode)) {
        displayMode = body.displayMode
        localizedVerseSource.setMode(displayMode)
        hybridAsr.setLanguage(whisperLanguageFor(displayMode))
      }
      if (isUiLanguage(body.uiLanguage)) {
        uiLanguage = body.uiLanguage
      }
      if (typeof body.allowPhoneRemote === "boolean") {
        allowPhoneRemote = body.allowPhoneRemote
      }

      res.json(currentStatusPayload())
    } catch (err) {
      res.status(err instanceof MediaImportError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/mode", (req: Request, res: Response) => {
    const { mode } = req.body || {}
    if (mode === "english" || mode === "french" || mode === "bilingual") {
      displayMode = mode
      localizedVerseSource.setMode(mode)
      hybridAsr.setLanguage(whisperLanguageFor(mode))
      res.json({ success: true, mode })
    } else {
      res.status(400).json({ error: "Invalid mode" })
    }
  })

  app.post("/api/language", (req: Request, res: Response) => {
    const { language } = req.body || {}
    if (language === "en" || language === "fr") {
      uiLanguage = language
      res.json({ success: true, language })
    } else {
      res.status(400).json({ error: "Invalid language" })
    }
  })

  app.post("/api/confirmation-mode", (req: Request, res: Response) => {
    const { mode } = req.body || {}
    if (mode === "auto" || mode === "review") {
      verseConfirmationMode = mode
      appCoreHandle?.setVerseConfirmationMode(mode)
      res.json({ success: true, mode })
    } else {
      res.status(400).json({ error: "Invalid confirmation mode" })
    }
  })

  app.post("/api/sermon-notes", (req: Request, res: Response) => {
    const { enabled } = req.body || {}
    enableSermonNotes = Boolean(enabled)
    appCoreHandle?.setSermonNotesEnabled(enableSermonNotes)
    res.json({ success: true, enabled: enableSermonNotes })
  })

  app.get("/api/media", (_req: Request, res: Response) => {
    res.json(mediaLibrary.list())
  })

  app.post("/api/media/upload", async (req: Request, res: Response) => {
    try {
      const { title, filename, data } = req.body || {}
      if (typeof title !== "string" || typeof filename !== "string" || typeof data !== "string" || !title || !filename || !data) {
        res.status(400).json({ error: "Missing title, filename, or data" })
        return
      }

      const extension = extname(filename).toLowerCase()
      let kind: MediaCueKind = "image"
      if ([".mp4", ".webm"].includes(extension)) kind = "video"
      else if ([".mp3", ".wav", ".m4a"].includes(extension)) kind = "audio"
      else if (![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
        res.status(400).json({ error: `Unsupported media extension: ${extension}` })
        return
      }

      const tempFilePath = join(tempDir, `upload-${Date.now()}-${randomBytes(4).toString("hex")}${extension}`)
      const buffer = Buffer.from(data, "base64")

      try {
        await writeFile(tempFilePath, buffer)
        const cue = await mediaLibrary.import(tempFilePath, title, kind)
        res.json(cue)
      } finally {
        await unlink(tempFilePath).catch(() => {})
      }
    } catch (err) {
      res.status(err instanceof MediaImportError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/media/rename", async (req: Request, res: Response) => {
    try {
      const { id, newTitle } = req.body || {}
      if (typeof id !== "string" || typeof newTitle !== "string" || !id || !newTitle) {
        res.status(400).json({ error: "Missing id or newTitle" })
        return
      }
      const cue = await mediaLibrary.rename(id, newTitle)
      res.json(cue)
    } catch (err) {
      res.status(err instanceof MediaImportError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/media/:id", async (req: Request, res: Response) => {
    try {
      const id = typeof req.params.id === "string" ? req.params.id : Array.isArray(req.params.id) ? req.params.id[0] : ""
      if (!id) {
        res.status(400).json({ error: "Missing id" })
        return
      }
      await mediaLibrary.remove(id)
      res.json({ success: true })
    } catch (err) {
      res.status(err instanceof MediaImportError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/api/glossary", (_req: Request, res: Response) => {
    res.json(GLOSSARY)
  })

  app.get("/api/history", (_req: Request, res: Response) => {
    res.json(sessionHistoryStore.getEntries())
  })

  app.get("/api/export", (_req: Request, res: Response) => {
    const entries = appCoreHandle?.getSessionEntries() || []
    res.json({ entries })
  })

  // Post-Service AI Pack: YouTube Timestamps, Analytics, Homiletic Flow, and Social Quote Cards
  app.get("/api/service-pack", (_req: Request, res: Response) => {
    const entries = appCoreHandle?.getSessionEntries() || []
    const youtubeDescription = buildYouTubeDescription(entries)
    const analytics = generatePreachingAnalytics(entries)
    const sermonSegments = entries.map((e, idx) => ({
      timestampMs: e.timestamp,
      text: `${e.reference.book} ${e.reference.chapter}:${e.reference.verse} ${e.text}`,
    }))
    const sermonFlow = analyzeSermonFlow(sermonSegments)
    const topVerse = entries[0]
    const quoteCardSvg = topVerse
      ? generateSocialQuoteCardSvg(
          topVerse.text,
          `${topVerse.reference.book} ${topVerse.reference.chapter}:${topVerse.reference.verse}`
        )
      : null
    res.json({
      youtubeDescription,
      analytics,
      sermonFlow,
      quoteCardSvg,
      entriesCount: entries.length,
    })
  })

  // Quick scripture passage lookup / preview endpoint
  app.get("/api/verse/lookup", async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : ""
      if (!q) {
        res.status(400).json({ error: "Missing query parameter 'q'" })
        return
      }
      const detector = new RegexDetector()
      const refs = detector.detect(q)
      const ref = refs[0]
      if (!ref) {
        res.status(404).json({ error: "No recognizable verse reference in query" })
        return
      }
      const index = new KnownValidVerseIndex()
      if (!index.exists(ref)) {
        res.status(400).json({ error: `Invalid reference: ${ref.book} ${ref.chapter}:${ref.verse}` })
        return
      }
      const verse = await localizedVerseSource.getVerse(ref)
      if (!verse) {
        res.status(404).json({ error: "Verse text not found in current translation" })
        return
      }
      // Predictively warm the cache with parallel scriptures
      prefetchCrossReferences(ref, localizedVerseSource).catch(() => {})
      res.json({ reference: ref, verse })
    } catch (err) {
      res.status(err instanceof MediaImportError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Thematic cross-reference suggestions
  app.get("/api/verse/cross-references", async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : ""
      if (!q) {
        res.status(400).json({ error: "Missing query parameter 'q'" })
        return
      }
      const detector = new RegexDetector()
      const refs = detector.detect(q)
      const ref = refs[0]
      if (!ref) {
        res.status(404).json({ error: "No recognizable verse reference" })
        return
      }
      const crossRefs = getCrossReferences(ref)
      res.json({ reference: ref, crossReferences: crossRefs })
    } catch (err) {
      res.status(err instanceof MediaImportError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Dry-run synthetic speech simulator
  app.post("/api/dry-run/emit", (req: Request, res: Response) => {
    const { text } = req.body || {}
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing text string" })
      return
    }
    hybridAsr.emitText(text)
    res.json({ success: true, emitted: text })
  })

  // Overlay static files
  const overlayStaticDir = join(REPO_ROOT, "apps", "overlay", "public")
  app.use("/overlay", express.static(overlayStaticDir))

  // Stage Display static files (/stage)
  const stageStaticDir = join(REPO_ROOT, "apps", "stage", "public")
  app.use("/stage", express.static(stageStaticDir))

  // Live Congregation Companion static files (/live)
  const liveStaticDir = join(REPO_ROOT, "apps", "live", "public")
  app.use("/live", express.static(liveStaticDir))

  // Remote static files
  const remoteStaticDir = join(REPO_ROOT, "apps", "remote", "public")
  app.use("/remote", express.static(remoteStaticDir))

  // "/" explains where the operator dashboard lives. The dashboard in
  // apps/desktop/renderer is built on Electron's preload bridge and renders
  // as a blank page in a browser (ARCHITECTURE.md section 80.2), so it is no
  // longer served here.
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(join(REPO_ROOT, "apps", "web", "public", "index.html"))
  })

  // Final error handler: body-parser failures (bad JSON, oversized body) would
  // otherwise render Express's default HTML page, which the dashboard cannot
  // parse and which exposes stack traces when NODE_ENV is unset.
  app.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) {
      next(err)
      return
    }
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500
    const clientError = status >= 400 && status < 500
    res.status(clientError ? status : 500).json({ error: clientError ? "Invalid or oversized request" : "Internal server error" })
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ component: "server", event: "server.stopping" })
    // Keep-alive connections (OBS browser sources, phones) would otherwise hold
    // httpServer.close() open indefinitely and leave the port bound.
    setTimeout(() => process.exit(0), 3000).unref()
    if (appCoreHandle) {
      await appCoreHandle.stop().catch(() => {})
    }
    httpServer.close(() => {
      process.exit(0)
    })
    httpServer.closeAllConnections?.()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((err) => {
  console.error("Fatal startup error:", err)
  process.exit(1)
})
