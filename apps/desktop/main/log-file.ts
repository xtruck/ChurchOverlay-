import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { redactInlineSecrets } from "../../../packages/shared/logger"

/**
 * Persistent, bounded log sink for the desktop main process (audit B1).
 *
 * Until now every log line went to stdout only: a packaged app has no console,
 * so after a bad service nothing was left to look at. This writes the same
 * JSON lines to `<dir>/churchoverlay.log`, rotating to `.1.log` ... `.N.log`
 * (default 5 files x 5 MB), and keeps the last lines in memory too.
 *
 * Safety rules (a log must never be the thing that breaks a live service):
 * - write() never throws and never blocks: lines go into a bounded queue that
 *   is appended asynchronously in small batches.
 * - A failing disk drops the batch and COUNTS it (stats().writeFailures /
 *   droppedLines); the app carries on. Nothing is retried in a loop.
 * - Every line passes through the inline secret redaction before it is stored
 *   anywhere (file or ring), as a last line of defense behind the Logger's own.
 */

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_LOG_MAX_FILES = 5
export const DEFAULT_LOG_RING_LINES = 500
const DEFAULT_MAX_QUEUED_LINES = 2000
const BATCH_BYTES = 64 * 1024

export class LogRing {
  private readonly buffer: string[] = []

  constructor(private readonly capacity: number = DEFAULT_LOG_RING_LINES) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("LogRing capacity must be a positive integer")
  }

  push(line: string): void {
    this.buffer.push(line)
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity)
  }

  lines(): string[] {
    return [...this.buffer]
  }
}

export type LogFileOptions = {
  readonly dir: string
  readonly baseName?: string
  readonly maxBytes?: number
  readonly maxFiles?: number
  readonly maxQueuedLines?: number
}

export type LogFileStats = {
  readonly path: string
  readonly linesWritten: number
  readonly writeFailures: number
  readonly droppedLines: number
  readonly rotations: number
  readonly lastError: string | null
}

export class RotatingLogFile {
  private readonly dir: string
  private readonly baseName: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly maxQueuedLines: number
  private queue: string[] = []
  private draining: Promise<void> | null = null
  private size: number | null = null
  private dirReady = false
  private linesWritten = 0
  private writeFailures = 0
  private droppedLines = 0
  private rotations = 0
  private lastError: string | null = null

  constructor(options: LogFileOptions) {
    this.dir = options.dir
    this.baseName = options.baseName ?? "churchoverlay"
    this.maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES
    this.maxFiles = options.maxFiles ?? DEFAULT_LOG_MAX_FILES
    this.maxQueuedLines = options.maxQueuedLines ?? DEFAULT_MAX_QUEUED_LINES
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("maxBytes must be a positive integer")
    if (!Number.isInteger(this.maxFiles) || this.maxFiles < 1) throw new Error("maxFiles must be a positive integer")
  }

  get path(): string {
    return this.fileName(0)
  }

  /** Queue one line (without trailing newline). Never throws, never blocks. */
  write(line: string): void {
    try {
      if (this.queue.length >= this.maxQueuedLines) {
        this.queue.shift()
        this.droppedLines++
      }
      this.queue.push(redactInlineSecrets(line) + "\n")
      this.scheduleDrain()
    } catch (err) {
      this.noteFailure(err, 1)
    }
  }

  /** Resolves once everything queued so far has been attempted. */
  async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      if (!this.draining) this.scheduleDrain()
      await this.draining
    }
  }

  /** Crash path: write whatever is still queued synchronously, best effort. */
  flushSync(): void {
    const pending = this.queue
    this.queue = []
    let index = 0
    while (index < pending.length) {
      const batch = takeBatch(pending, index)
      index += batch.count
      try {
        this.ensureDirSync()
        this.rotateIfNeededSync(batch.bytes)
        appendFileSync(this.path, batch.text, "utf8")
        this.size = (this.size ?? 0) + batch.bytes
        this.linesWritten += batch.count
      } catch (err) {
        this.noteFailure(err, pending.length - (index - batch.count))
        return
      }
    }
  }

  stats(): LogFileStats {
    return {
      path: this.path,
      linesWritten: this.linesWritten,
      writeFailures: this.writeFailures,
      droppedLines: this.droppedLines,
      rotations: this.rotations,
      lastError: this.lastError,
    }
  }

  private fileName(index: number): string {
    return join(this.dir, index === 0 ? `${this.baseName}.log` : `${this.baseName}.${index}.log`)
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = this.drain().finally(() => {
      this.draining = null
      if (this.queue.length > 0) this.scheduleDrain()
    })
  }

  private async drain(): Promise<void> {
    // Yield once so a burst of lines is written as one batch, not one each.
    await new Promise<void>((resolve) => setImmediate(resolve))
    while (this.queue.length > 0) {
      const batch = takeBatch(this.queue, 0)
      this.queue.splice(0, batch.count)
      try {
        await this.appendBatch(batch.text, batch.bytes)
        this.linesWritten += batch.count
      } catch (err) {
        // Drop the batch and count it: retrying a broken disk forever would
        // only grow the queue; the counters make the loss visible.
        this.noteFailure(err, batch.count)
        return
      }
    }
  }

  private async appendBatch(text: string, bytes: number): Promise<void> {
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true })
      this.dirReady = true
    }
    if (this.size === null) this.size = await sizeOf(this.path)
    if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate()
    await appendFile(this.path, text, "utf8")
    this.size += bytes
  }

  private async rotate(): Promise<void> {
    // Oldest first: <base>.<max-1>.log is deleted, the rest shift up by one.
    const last = this.maxFiles - 1
    if (last >= 1) await unlink(this.fileName(last)).catch(ignoreMissing)
    for (let index = last - 1; index >= 1; index--) {
      await rename(this.fileName(index), this.fileName(index + 1)).catch(ignoreMissing)
    }
    if (last >= 1) await rename(this.path, this.fileName(1)).catch(ignoreMissing)
    else await unlink(this.path).catch(ignoreMissing)
    this.size = 0
    this.rotations++
  }

  private ensureDirSync(): void {
    if (this.dirReady) return
    mkdirSync(this.dir, { recursive: true })
    this.dirReady = true
  }

  private rotateIfNeededSync(bytes: number): void {
    if (this.size === null) {
      try {
        this.size = statSync(this.path).size
      } catch {
        // No file yet: it starts empty.
        this.size = 0
      }
    }
    if (this.size === 0 || this.size + bytes <= this.maxBytes) return
    const last = this.maxFiles - 1
    const tolerant = (action: () => void) => {
      try {
        action()
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }
    }
    if (last >= 1) tolerant(() => unlinkSync(this.fileName(last)))
    for (let index = last - 1; index >= 1; index--) tolerant(() => renameSync(this.fileName(index), this.fileName(index + 1)))
    if (last >= 1) tolerant(() => renameSync(this.path, this.fileName(1)))
    else tolerant(() => unlinkSync(this.path))
    this.size = 0
    this.rotations++
  }

  private noteFailure(err: unknown, lines: number): void {
    this.writeFailures++
    this.droppedLines += lines
    this.lastError = err instanceof Error ? err.message : String(err)
  }
}

function takeBatch(lines: readonly string[], from: number): { text: string; bytes: number; count: number } {
  let bytes = 0
  let count = 0
  const parts: string[] = []
  for (let index = from; index < lines.length; index++) {
    const line = lines[index] as string
    const lineBytes = Buffer.byteLength(line, "utf8")
    if (count > 0 && bytes + lineBytes > BATCH_BYTES) break
    parts.push(line)
    bytes += lineBytes
    count++
  }
  return { text: parts.join(""), bytes, count }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    // No file yet: it starts empty.
    return 0
  }
}

function ignoreMissing(err: unknown): void {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
}

export type LogSink = {
  readonly write: (line: string) => void
  readonly file: RotatingLogFile
  readonly ring: LogRing
  /** Lines console output failed for (e.g. a closed stdout pipe). */
  readonly consoleFailures: () => number
}

/**
 * The function handed to Logger({ write }): stdout (as before, but a broken
 * pipe is swallowed and counted so it cannot become an uncaught exception),
 * the in-memory ring, and the rotating file.
 */
export function createLogSink(
  file: RotatingLogFile,
  ring: LogRing = new LogRing(),
  print: (line: string) => void = (line) => console.log(line)
): LogSink {
  let consoleFailures = 0
  return {
    file,
    ring,
    consoleFailures: () => consoleFailures,
    write(line: string) {
      try {
        print(line)
      } catch {
        consoleFailures++
      }
      ring.push(redactInlineSecrets(line))
      file.write(line)
    },
  }
}
