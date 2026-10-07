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
  /** The executable to spawn: whisper-server.exe, or python.exe for the faster-whisper sidecar. */
  readonly serverPath: string
  readonly modelPath: string
  /** Overrides the whisper.cpp command line (the faster-whisper sidecar takes different flags). */
  readonly buildArgs?: (port: number, threads: number) => string[]
  readonly logger?: Logger
  readonly threads?: number
  /** Injected in tests. */
  readonly spawnImpl?: typeof spawn
  readonly fetchImpl?: typeof fetch
  readonly readyTimeoutMs?: number
  /** How long the post-wake /health check may take before the engine counts as hung. */
  readonly resumeHealthTimeoutMs?: number
}

const MAX_RESTART_DELAY_MS = 30_000
const RESUME_HEALTH_TIMEOUT_MS = 3_000
/** Drivers and the network stack settle for a moment after wake (OpenWhispr waits too before re-warming). */
export const RESUME_SETTLE_DELAY_MS = 2_000

/** The one event the core needs from Electron's powerMonitor; injected so this module never imports Electron. */
export type ResumeSource = {
  on(event: "resume", listener: () => void): unknown
  removeListener(event: "resume", listener: () => void): unknown
}

/**
 * Calls `target().onSystemResume()` once the system has settled after a
 * wake. Repeated resume events inside the settle window collapse into one
 * check. `target` is read at fire time, so a service restart between sleep
 * and wake checks whichever engine is current (or nothing). Returns an
 * unsubscribe function.
 */
export function watchSystemResume(
  source: ResumeSource,
  target: () => Pick<WhisperServerProcess, "onSystemResume"> | null,
  options: { readonly settleMs?: number; readonly logger?: Logger } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const listener = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const engine = target()
      if (!engine) return
      engine.onSystemResume().catch((error: unknown) => {
        options.logger?.error({
          component: "asr",
          event: "local-whisper.resume-check-failed",
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, options.settleMs ?? RESUME_SETTLE_DELAY_MS)
  }
  source.on("resume", listener)
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    source.removeListener("resume", listener)
  }
}

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

  /**
   * Called after the machine wakes from sleep. A sleeping laptop can leave the
   * engine hung (GPU/driver state lost, socket wedged) while the process still
   * exists, so the exit handler never fires. Re-check /health with a short,
   * bounded timeout; restart once if it does not answer. No-op when stopped
   * or mid-start. Never throws for an unhealthy engine (restart failures are logged).
   */
  async onSystemResume(): Promise<void> {
    if (this.stopped || this.starting) return
    const child = this.child
    if (!child || !this.port) {
      this.options.logger?.info({ component: "asr", event: "local-whisper.resume-restart", metadata: { reason: "not-running" } })
      await this.restartAfterResume()
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.resumeHealthTimeoutMs ?? RESUME_HEALTH_TIMEOUT_MS)
    let healthy = false
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/health`, { signal: controller.signal })
      healthy = response.ok
    } catch {
      healthy = false // unreachable or timed out: handled below by a restart
    } finally {
      clearTimeout(timer)
    }
    if (this.child !== child || this.stopped) return // stopped or replaced while we waited
    if (healthy) {
      this.options.logger?.debug({ component: "asr", event: "local-whisper.resume-healthy" })
      return
    }
    this.options.logger?.warn({ component: "asr", event: "local-whisper.resume-restart", metadata: { reason: "health-failed" } })
    // Detach first so the exit handler does not schedule a second restart.
    this.child = null
    this.port = 0
    if (child.exitCode === null) child.kill()
    await this.restartAfterResume()
  }

  private async restartAfterResume(): Promise<void> {
    try {
      await this.ensureStarted()
    } catch (error) {
      this.options.logger?.error({
        component: "asr",
        event: "local-whisper.resume-restart-failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async launch(): Promise<void> {
    const port = await freePort()
    const threads = this.options.threads ?? Math.max(2, Math.min(8, cpus().length - 1))
    const args = this.options.buildArgs ? this.options.buildArgs(port, threads) : [
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
    // spawn() failures (ENOENT, EACCES) surface as an 'error' event; without a
    // listener Node would raise an uncaughtException and kill the whole server.
    // Clearing this.child makes waitUntilReady fail fast instead of polling.
    child.once("error", (err) => {
      stderrTail = (stderrTail + String(err.message)).slice(-2000)
      this.options.logger?.warn({
        component: "asr",
        event: "local-whisper.spawn-error",
        metadata: { message: err.message },
      })
      if (this.child !== child) return
      this.child = null
      this.port = 0
    })
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
        // Each poll is bounded too: a wedged socket must not outlive the deadline.
        const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/health`, {
          signal: AbortSignal.timeout(this.options.resumeHealthTimeoutMs ?? RESUME_HEALTH_TIMEOUT_MS),
        })
        if (response.ok) return
      } catch {
        // not listening yet (or that poll timed out)
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
