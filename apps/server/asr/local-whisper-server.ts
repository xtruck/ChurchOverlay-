import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { cpus } from "node:os"
import { dirname } from "node:path"
import type { Logger } from "../../../packages/shared/logger"

/**
 * Owns the local whisper.cpp `whisper-server` child process: picks a free
 * loopback port, starts it with the downloaded model, waits until /health
 * reports the model loaded, and restarts it (bounded backoff) if it dies
 * mid-service. The model stays loaded between requests — that is the whole
 * point of using the server instead of spawning a CLI per utterance.
 */
export type WhisperServerOptions = {
  readonly serverPath: string
  readonly modelPath: string
  readonly logger?: Logger
  readonly threads?: number
  /** Injected in tests. */
  readonly spawnImpl?: typeof spawn
  readonly fetchImpl?: typeof fetch
  readonly readyTimeoutMs?: number
}

const MAX_RESTART_DELAY_MS = 30_000

export class WhisperServerProcess {
  private readonly options: WhisperServerOptions
  private readonly spawnImpl: typeof spawn
  private readonly fetchImpl: typeof fetch
  private child: ChildProcess | null = null
  private port = 0
  private starting: Promise<void> | null = null
  private stopped = true
  private restartAttempts = 0

  constructor(options: WhisperServerOptions) {
    this.options = options
    this.spawnImpl = options.spawnImpl ?? spawn
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Base URL of the running server, or null while it is not ready. */
  get baseUrl(): string | null {
    return this.child && this.port ? `http://127.0.0.1:${this.port}` : null
  }

  ensureStarted(): Promise<void> {
    this.stopped = false
    if (this.baseUrl && !this.starting) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    this.child = null
    this.port = 0
    if (child && child.exitCode === null) child.kill()
  }

  private async launch(): Promise<void> {
    const port = await freePort()
    const threads = this.options.threads ?? Math.max(2, Math.min(8, cpus().length - 1))
    const args = [
      "-m", this.options.modelPath,
      "--host", "127.0.0.1",
      "--port", String(port),
      "-t", String(threads),
      "-l", "auto",
      "-nt",
      // Silence and noise are the classic Whisper hallucination trigger;
      // suppressing non-speech tokens removes most "Merci d'avoir regardé".
      "-sns",
    ]
    const child = this.spawnImpl(this.options.serverPath, args, {
      cwd: dirname(this.options.serverPath),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    })
    let stderrTail = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    this.child = child
    this.port = port
    child.once("exit", (code) => {
      if (this.child !== child) return
      this.child = null
      this.port = 0
      this.options.logger?.warn({
        component: "asr",
        event: "local-whisper.exited",
        metadata: { code, stderrTail: stderrTail.slice(-500) },
      })
      if (!this.stopped) this.scheduleRestart()
    })
    await this.waitUntilReady(child, () => stderrTail)
    this.restartAttempts = 0
    this.options.logger?.info({ component: "asr", event: "local-whisper.ready", metadata: { port, threads } })
  }

  private scheduleRestart(): void {
    const delay = Math.min(1000 * 2 ** this.restartAttempts, MAX_RESTART_DELAY_MS)
    this.restartAttempts += 1
    setTimeout(() => {
      if (!this.stopped) this.ensureStarted().catch(() => {})
    }, delay).unref?.()
  }

  private async waitUntilReady(child: ChildProcess, stderr: () => string): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 60_000)
    while (Date.now() < deadline) {
      if (child.exitCode !== null || this.child !== child) {
        throw new Error(`Local transcription engine exited during startup: ${stderr().slice(-300)}`)
      }
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/health`)
        if (response.ok) return
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    child.kill()
    throw new Error("Local transcription engine did not become ready in time")
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}
