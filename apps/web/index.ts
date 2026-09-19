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
import { MediaLibrary } from "../server/media/media-library"
import { SessionHistoryStore } from "../server/core/session-history-store"
import { SermonNotesGenerator } from "../server/ai/sermon-notes-generator"
import { Logger } from "../../packages/shared/logger"
import { HybridAsrProvider } from "../server/asr/hybrid-provider"
import { GLOSSARY } from "../server/glossary/glossary"
import type { DisplayMode, VerseConfirmationMode, MediaCueKind } from "../../packages/contracts"

export type UiLanguage = "en" | "fr"

const PORT = 3000
const HOST = "0.0.0.0"

// Compiled to dist/apps/web/index.js — three levels up reaches the repo
// root, matching apps/desktop/main/index.ts's own REPO_ROOT pattern
// (ARCHITECTURE.md section 80). Resolving from __dirname rather than
// process.cwd() means static/data paths are correct regardless of the
// directory the process was launched from.
const REPO_ROOT = join(__dirname, "..", "..", "..")

const logger = new Logger({ minLevel: "info" })

async function main() {
  const app = express()
  app.use(express.json({ limit: "50mb" }))

  const httpServer = createServer(app)

  // Tokens
  const tokens = {
    operatorToken: process.env.OPERATOR_TOKEN || randomBytes(16).toString("hex"),
    viewerToken: process.env.VIEWER_TOKEN || randomBytes(16).toString("hex"),
  }

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
  await mediaLibrary.load()

  const sessionHistoryStore = new SessionHistoryStore({ historyDir: dataDir })
  await sessionHistoryStore.load()

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

  const hybridAsr = new HybridAsrProvider({ apiKey: groqApiKey, logger })
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
      console.log(`Overlay URL: http://${HOST}:${PORT}/overlay/index.html?token=${tokens.viewerToken}&wsPort=${PORT}`)
      console.log(`Remote URL: http://${HOST}:${PORT}/remote/index.html?token=${tokens.operatorToken}&wsPort=${PORT}`)
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
    const filePath = req.params.id ? mediaLibrary.resolveFilePath(req.params.id) : null
    if (!filePath) {
      res.status(404).send("Media not found")
      return
    }
    res.sendFile(filePath)
  })

  // API Endpoints
  app.get("/api/status", (_req: Request, res: Response) => {
    res.json({
      ready: true,
      hasGroqKey: Boolean(groqApiKey),
      port: PORT,
      token: tokens.operatorToken,
      viewerToken: tokens.viewerToken,
      displayMode,
      uiLanguage,
      verseConfirmationMode,
      enableSermonNotes,
      allowPhoneRemote,
      overlayUrl: `/overlay/index.html?token=${tokens.viewerToken}&wsPort=${PORT}`,
      remoteUrl: `/remote/index.html?token=${tokens.operatorToken}&wsPort=${PORT}`,
    })
  })

  app.post("/api/setup", async (req: Request, res: Response) => {
    try {
      const body = req.body || {}
      if (typeof body.groqApiKey === "string") {
        groqApiKey = body.groqApiKey.trim()
        hybridAsr.setApiKey(groqApiKey)
      }
      if (body.displayMode) {
        displayMode = body.displayMode as DisplayMode
        localizedVerseSource.setMode(displayMode)
      }
      if (body.uiLanguage) {
        uiLanguage = body.uiLanguage as UiLanguage
      }
      if (typeof body.allowPhoneRemote === "boolean") {
        allowPhoneRemote = body.allowPhoneRemote
      }

      res.json({
        ready: true,
        hasGroqKey: Boolean(groqApiKey),
        port: PORT,
        token: tokens.operatorToken,
        viewerToken: tokens.viewerToken,
        displayMode,
        uiLanguage,
        verseConfirmationMode,
        enableSermonNotes,
        allowPhoneRemote,
        overlayUrl: `/overlay/index.html?token=${tokens.viewerToken}&wsPort=${PORT}`,
        remoteUrl: `/remote/index.html?token=${tokens.operatorToken}&wsPort=${PORT}`,
      })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/mode", (req: Request, res: Response) => {
    const { mode } = req.body || {}
    if (mode === "english" || mode === "french" || mode === "bilingual") {
      displayMode = mode
      localizedVerseSource.setMode(mode)
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
      if (!title || !filename || !data) {
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
      await writeFile(tempFilePath, buffer)

      try {
        const cue = await mediaLibrary.import(tempFilePath, title, kind)
        res.json(cue)
      } finally {
        await unlink(tempFilePath).catch(() => {})
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/media/rename", async (req: Request, res: Response) => {
    try {
      const { id, newTitle } = req.body || {}
      if (!id || !newTitle) {
        res.status(400).json({ error: "Missing id or newTitle" })
        return
      }
      const cue = await mediaLibrary.rename(id, newTitle)
      res.json(cue)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/media/:id", async (req: Request, res: Response) => {
    try {
      if (!req.params.id) {
        res.status(400).json({ error: "Missing id" })
        return
      }
      await mediaLibrary.remove(req.params.id)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
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
      res.json({ reference: ref, verse })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
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

  // Remote static files
  const remoteStaticDir = join(REPO_ROOT, "apps", "remote", "public")
  app.use("/remote", express.static(remoteStaticDir))

  // Operator Dashboard static files & index
  const rendererDir = join(REPO_ROOT, "apps", "desktop", "renderer")
  app.use(express.static(rendererDir))
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(join(rendererDir, "index.html"))
  })

  const shutdown = async () => {
    logger.info({ component: "server", event: "server.stopping" })
    if (appCoreHandle) {
      await appCoreHandle.stop().catch(() => {})
    }
    httpServer.close(() => {
      process.exit(0)
    })
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((err) => {
  console.error("Fatal startup error:", err)
  process.exit(1)
})
