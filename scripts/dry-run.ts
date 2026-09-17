/**
 * ARCHITECTURE.md section 44's Dry-Run Mode: deterministic testing of the
 * complete downstream pipeline (Detector -> Validation -> Verse Source ->
 * Overlay) with no microphone and no external ASR involved. Every line
 * typed (or piped) on stdin is treated as a finished "final" transcript,
 * exactly as if ASR had just produced it — see DryRunAsrProvider.
 *
 * Everything downstream of ASR is real and unmodified: RegexDetector,
 * KnownValidVerseIndex, FreeApiSource (a real bible-api.com lookup), the
 * real WS server, and the real overlay page served over HTTP.
 *
 * Usage: npm run dry-run
 * Then open the printed overlay URL, and type lines like "John 3:16" or
 * "Turn to Romans 8:28" at the terminal — each Enter press pushes that
 * line through the real pipeline.
 */
import { randomBytes } from "node:crypto"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { startAppCore } from "../apps/server/core/app-core"
import { StaticServer } from "../apps/server/http/static-server"
import { RegexDetector } from "../apps/server/detector/regex-detector"
import { KnownValidVerseIndex } from "../apps/server/verse/known-valid-verse-index"
import { FreeApiSource } from "../apps/server/verse/free-api-source"
import { DryRunAsrProvider } from "../apps/server/asr/dry-run-provider"
import { Logger } from "../packages/shared/logger"

async function main(): Promise<void> {
  const logger = new Logger({ minLevel: "info" })
  const tokens = {
    operatorToken: randomBytes(16).toString("hex"),
    viewerToken: randomBytes(16).toString("hex"),
  }

  const asr = new DryRunAsrProvider()

  const app = await startAppCore({
    asr,
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new FreeApiSource(),
    logger,
    port: 8787,
    tokens,
  })

  // Same two-levels-up reasoning as dev-preview.ts: this file compiles to
  // dist/scripts, but the static overlay assets are plain files tsc never
  // copies, so they're only reachable from the repo root.
  const staticServer = new StaticServer({
    port: 8788,
    rootDir: join(__dirname, "..", "..", "apps", "overlay", "public"),
  })
  await staticServer.ready

  const wsPort = app.wsServer.port
  const httpPort = staticServer.port

  console.log("")
  console.log("ChurchOverlay dry-run mode is running — no microphone, no ASR.")
  console.log("")
  console.log("Overlay (open this to see verses appear):")
  console.log(
    `  http://127.0.0.1:${httpPort}/index.html?token=${tokens.viewerToken}&wsPort=${wsPort}`
  )
  console.log("")
  console.log('Type a line and press Enter to push it through the real pipeline, e.g.:')
  console.log('  Turn with me to John 3:16')
  console.log("Press Ctrl+C to stop.")
  console.log("")

  const rl = createInterface({ input: process.stdin })
  rl.on("line", (line) => {
    const text = line.trim()
    if (!text) return
    asr.emitText(text)
  })

  const shutdown = async () => {
    console.log("\nShutting down…")
    rl.close()
    await app.stop()
    await staticServer.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("dry-run failed to start:", err)
  process.exitCode = 1
})
