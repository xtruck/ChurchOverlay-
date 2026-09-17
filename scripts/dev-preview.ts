/**
 * Development-only preview runner — NOT part of the shipped application.
 * Starts the real AppCore (WS server + full pipeline) and StaticServer,
 * using the real GroqProvider and FreeApiSource, so the app can be seen
 * and used in a plain browser before the Electron scaffolding
 * (apps/desktop/main, apps/desktop/preload) exists.
 *
 * This intentionally bypasses ConfigStore/safeStorage: it reads
 * GROQ_API_KEY from the environment and generates throwaway tokens each
 * run. That is fine for a temporary local dev preview and would NOT be
 * fine for the real app (ARCHITECTURE.md sections 37-38 exist precisely
 * because real tokens/keys must be encrypted at rest and persist across
 * runs) — do not copy this bootstrap pattern into the real main process.
 *
 * Usage: npm run dev:preview
 * (builds first, then runs the compiled JS with .env loaded — this
 * project compiles to CommonJS, so running the .ts source directly via
 * Node's native type-stripping doesn't work: that mode requires ESM-style
 * extensioned import specifiers, which the whole codebase doesn't use)
 */
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { startAppCore } from "../apps/server/core/app-core"
import { StaticServer } from "../apps/server/http/static-server"
import { RegexDetector } from "../apps/server/detector/regex-detector"
import { KnownValidVerseIndex } from "../apps/server/verse/known-valid-verse-index"
import { FreeApiSource } from "../apps/server/verse/free-api-source"
import { GroqProvider } from "../apps/server/asr/groq-provider"
import { Logger } from "../packages/shared/logger"

async function main(): Promise<void> {
  const groqApiKey = process.env.GROQ_API_KEY
  if (!groqApiKey) {
    console.error(
      "GROQ_API_KEY is not set. Run with: node --env-file=.env --experimental-strip-types scripts/dev-preview.ts"
    )
    process.exitCode = 1
    return
  }

  const logger = new Logger({ minLevel: "info" })
  const tokens = {
    operatorToken: randomBytes(16).toString("hex"),
    viewerToken: randomBytes(16).toString("hex"),
  }

  const app = await startAppCore({
    asr: new GroqProvider({ apiKey: groqApiKey }),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source: new FreeApiSource(),
    logger,
    port: 8787,
    tokens,
  })

  // __dirname here is dist/scripts (this file is compiled, but the
  // static HTML/JS assets it serves are plain files tsc never copies) —
  // two levels up from dist/scripts reaches the repo root.
  const staticServer = new StaticServer({
    port: 8788,
    rootDir: join(__dirname, "..", "..", "apps", "overlay", "public"),
  })
  await staticServer.ready

  const wsPort = app.wsServer.port
  const httpPort = staticServer.port

  console.log("")
  console.log("ChurchOverlay dev preview is running.")
  console.log("")
  console.log("Operator dashboard (open this one and click around):")
  console.log(
    `  http://127.0.0.1:${httpPort}/dashboard.html?token=${tokens.operatorToken}&wsPort=${wsPort}`
  )
  console.log("")
  console.log("Overlay (open in a second tab/window to see verses appear):")
  console.log(
    `  http://127.0.0.1:${httpPort}/index.html?token=${tokens.viewerToken}&wsPort=${wsPort}`
  )
  console.log("")
  console.log("Try it: in the dashboard, type \"John 3:16\" and click \"Show on overlay\".")
  console.log("Press Ctrl+C here to stop.")
  console.log("")

  const shutdown = async () => {
    console.log("\nShutting down…")
    await app.stop()
    await staticServer.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("dev-preview failed to start:", err)
  process.exitCode = 1
})
