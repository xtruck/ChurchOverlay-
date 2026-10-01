import { createRequire } from "node:module"

/**
 * ARCHITECTURE.md sections 62 and 109. The overlay is rendered by an offscreen
 * Chromium window; each painted frame is converted and handed to the optional
 * NDI native module.
 *
 * Section 109 documents four defects measured in real Electron before this
 * rewrite: wrong frame size, opaque background, premultiplied alpha sent to a
 * format that documents straight alpha, and no frames at all while the overlay
 * is idle. The window-side fixes live in `createNdiWindow` (index.ts); the
 * sender-side fixes live here.
 */

/** Broadcast-standard output size. The offscreen window is forced to exactly this. */
export const NDI_FRAME_WIDTH = 1920
export const NDI_FRAME_HEIGHT = 1080

/** Frame rate while the overlay is changing, and the keep-alive rate when it is idle. */
export const NDI_ACTIVE_FPS = 30
export const NDI_IDLE_FPS = 10
/** How long after the last repaint the output still counts as "active". */
export const NDI_ACTIVE_WINDOW_MS = 2000

/** Consecutive failed sends before the output declares an error and recovers. */
export const NDI_MAX_CONSECUTIVE_FAILURES = 5
/** Backoff before each recovery attempt; also the maximum number of attempts. */
export const NDI_RECOVERY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000]

/** Window over which the measured frame rate is computed (bounded memory). */
const FPS_WINDOW_MS = 2000
const FPS_SAMPLE_CAP = 240

export type NDIVideoFrame = {
  xres: number
  yres: number
  frameRateN: number
  frameRateD: number
  fourCC: unknown
  pictureAspectRatio: number
  frameFormatType: unknown
  lineStrideBytes: number
  data: Buffer
}

export type NDISender = {
  video(frame: NDIVideoFrame): Promise<void>
  destroy(): Promise<void>
}

export type NDIModule = {
  send(options: { name: string; clockVideo: boolean; clockAudio: boolean }): Promise<NDISender>
  FOURCC_BGRA: unknown
  FORMAT_TYPE_PROGRESSIVE: unknown
  version?: () => string
}

type PaintListener = (
  _event: unknown,
  _dirty: unknown,
  image: { getSize(): { width: number; height: number }; toBitmap(): Buffer }
) => void

export type PaintSource = {
  on(event: "paint", listener: PaintListener): void
  off(event: "paint", listener: PaintListener): void
  setFrameRate?(fps: number): void
}

export type NDIOutputState = "disabled" | "unavailable" | "starting" | "running" | "error"

export type NDIOutputStats = {
  readonly framesSent: number
  /** Frames re-sent unchanged to keep the source alive (not a repaint). */
  readonly framesRepeated: number
  /** Painted frames replaced by a newer one before the sender was free. */
  readonly framesSuperseded: number
  readonly failures: number
  readonly width: number
  readonly height: number
  /** Measured over the last couple of seconds, not the nominal rate. */
  readonly fps: number
}

export type NDIOutputStatus = {
  state: NDIOutputState
  reason?: string
  sourceName?: string
  stats?: NDIOutputStats
  /**
   * Only present in the "error" state: true while the output is still attached and
   * retrying (the operator should be offered "Disable"), false when it failed to start
   * and nothing is running (the operator should be offered a retry).
   */
  active?: boolean
}

const requireFromHere = createRequire(__filename)

export function loadOptionalNDI(): NDIModule | null {
  try {
    const loaded = requireFromHere("@stagetimerio/grandiose") as Partial<NDIModule>
    if (typeof loaded.send !== "function" || loaded.FOURCC_BGRA === undefined || loaded.FORMAT_TYPE_PROGRESSIVE === undefined) {
      throw new Error("NDI addon does not expose the required sender API")
    }
    return loaded as NDIModule
  } catch {
    return null
  }
}

/**
 * Chromium paints premultiplied BGRA; NDI documents BGRA as "not
 * pre-multiplied" (straight alpha). Sending premultiplied data makes every
 * translucent pixel — shadows, anti-aliased text edges, translucent cards —
 * arrive too dark. Converts IN PLACE and returns the same buffer (the buffer
 * from `toBitmap()` is already a private copy, so no second 8 MB allocation).
 *
 * Alpha 255 and alpha 0 pixels are skipped: an overlay is mostly one or the
 * other, so only the edge pixels pay for the arithmetic. Measured on a
 * realistic 1080p lower-third frame: about 5 ms, paid only on a real repaint
 * (keep-alive repeats reuse the converted buffer). A 32-bit-word variant was
 * tried and was only ~8 % faster on realistic data, so it was not kept.
 */
const RECIPROCAL_16 = (() => {
  const table = new Uint32Array(256)
  for (let alpha = 1; alpha < 256; alpha++) table[alpha] = Math.round((255 * 65536) / alpha)
  return table
})()

export function unpremultiplyBGRAInPlace(data: Buffer): Buffer {
  const end = data.length - (data.length % 4)
  for (let i = 0; i < end; i += 4) {
    const alpha = data[i + 3] as number
    if (alpha === 255 || alpha === 0) continue
    const scale = RECIPROCAL_16[alpha] as number
    const b = (((data[i] as number) * scale + 32768) >>> 16)
    const g = (((data[i + 1] as number) * scale + 32768) >>> 16)
    const r = (((data[i + 2] as number) * scale + 32768) >>> 16)
    data[i] = b > 255 ? 255 : b
    data[i + 1] = g > 255 ? 255 : g
    data[i + 2] = r > 255 ? 255 : r
  }
  return data
}

export class NDIOutput {
  private sender: NDISender | null = null
  private paintSource: PaintSource | null = null
  private paintListener: PaintListener | null = null
  private status: NDIOutputStatus = { state: "disabled" }

  /** Bumped by start() and stop(); an async continuation from an older generation must do nothing. */
  private generation = 0
  private latestFrame: NDIVideoFrame | null = null
  /** True while `latestFrame` has not been sent yet (a real repaint, not a keep-alive repeat). */
  private latestIsNew = false
  private lastPaintAt = 0
  private frameInFlight = false
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private consecutiveFailures = 0
  private recoveryAttempts = 0

  private framesSent = 0
  private framesRepeated = 0
  private framesSuperseded = 0
  private failures = 0
  private frameWidth = 0
  private frameHeight = 0
  private readonly sendTimes: number[] = []

  constructor(
    private readonly sourceName: string,
    private readonly ndi: NDIModule | null = loadOptionalNDI(),
    private readonly log: (event: string, error?: string) => void = () => {}
  ) {}

  getStatus(): NDIOutputStatus {
    const base: NDIOutputStatus = { ...this.status, sourceName: this.sourceName }
    if (this.status.state === "running" || this.status.state === "error") {
      base.stats = this.snapshotStats()
    }
    if (this.status.state === "error") base.active = this.paintListener !== null
    return base
  }

  async start(paintSource: PaintSource): Promise<NDIOutputStatus> {
    if (this.sender || this.paintListener) return this.getStatus()
    if (!this.ndi) {
      this.status = { state: "unavailable", reason: "NDI native module is not installed or compatible." }
      return this.getStatus()
    }

    const generation = ++this.generation
    this.resetCounters()
    this.status = { state: "starting" }
    try {
      const sender = await this.ndi.send({ name: this.sourceName, clockVideo: true, clockAudio: false })
      if (generation !== this.generation) {
        // stop() (or another start()) ran while the native sender was being created: don't leak it.
        await this.destroySender(sender)
        return this.getStatus()
      }
      this.sender = sender
      this.paintSource = paintSource
      this.paintListener = (_event, _dirty, image) => this.onPaint(image)
      paintSource.on("paint", this.paintListener)
      paintSource.setFrameRate?.(NDI_ACTIVE_FPS)
      this.status = { state: "running" }
      this.schedulePump(generation)
      return this.getStatus()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log("ndi.start-failed", message)
      await this.stop()
      this.status = { state: "error", reason: message }
      return this.getStatus()
    }
  }

  async stop(): Promise<void> {
    this.generation++
    this.clearTimers()
    if (this.paintSource && this.paintListener) this.paintSource.off("paint", this.paintListener)
    this.paintSource = null
    this.paintListener = null
    this.latestFrame = null
    this.latestIsNew = false
    this.frameInFlight = false
    const sender = this.sender
    this.sender = null
    this.status = { state: "disabled" }
    if (sender) await this.destroySender(sender)
  }

  private onPaint(image: { getSize(): { width: number; height: number }; toBitmap(): Buffer }): void {
    const size = image.getSize()
    if (size.width <= 0 || size.height <= 0) return
    if (this.latestIsNew) this.framesSuperseded++
    this.frameWidth = size.width
    this.frameHeight = size.height
    this.latestFrame = this.buildFrame(size.width, size.height, unpremultiplyBGRAInPlace(image.toBitmap()))
    this.latestIsNew = true
    this.lastPaintAt = Date.now()
    void this.flush(false)
  }

  private buildFrame(width: number, height: number, data: Buffer): NDIVideoFrame {
    return {
      xres: width,
      yres: height,
      frameRateN: NDI_ACTIVE_FPS,
      frameRateD: 1,
      fourCC: this.ndi?.FOURCC_BGRA,
      pictureAspectRatio: width / height,
      frameFormatType: this.ndi?.FORMAT_TYPE_PROGRESSIVE,
      lineStrideBytes: width * 4,
      data,
    }
  }

  /** Sends the latest frame unless a send is already in flight (then the frame simply waits in its single slot). */
  private async flush(isRepeat: boolean): Promise<void> {
    const sender = this.sender
    const frame = this.latestFrame
    if (this.frameInFlight || !sender || !frame) return
    if (isRepeat && this.latestIsNew) return // a real repaint is waiting; it will be sent instead
    const generation = this.generation
    const sendingNew = this.latestIsNew
    this.latestIsNew = false
    this.frameInFlight = true
    try {
      await sender.video(isRepeat ? { ...frame, frameRateN: NDI_IDLE_FPS } : frame)
      if (generation !== this.generation) return
      this.consecutiveFailures = 0
      this.recoveryAttempts = 0
      this.framesSent++
      if (!sendingNew) this.framesRepeated++
      this.recordSend()
    } catch (err) {
      if (generation !== this.generation) return
      this.onSendFailure(err)
    } finally {
      if (generation === this.generation) {
        this.frameInFlight = false
        if (this.latestIsNew) void this.flush(false)
      }
    }
  }

  private onSendFailure(err: unknown): void {
    this.failures++
    this.consecutiveFailures++
    // One log line per streak, not per frame: a broken receiver must not also flood the log.
    if (this.consecutiveFailures === 1) this.log("ndi.frame-failed", err instanceof Error ? err.message : String(err))
    if (this.consecutiveFailures >= NDI_MAX_CONSECUTIVE_FAILURES) void this.beginRecovery(err)
  }

  /** Tears the sender down and recreates it with capped backoff; gives up (observably) after the last attempt. */
  private async beginRecovery(cause: unknown): Promise<void> {
    if (this.recoveryTimer) return
    const generation = this.generation
    const reason = cause instanceof Error ? cause.message : String(cause)
    this.clearPump()
    const broken = this.sender
    this.sender = null
    if (broken) await this.destroySender(broken)
    if (generation !== this.generation) return

    if (this.recoveryAttempts >= NDI_RECOVERY_BACKOFF_MS.length) {
      this.status = { state: "error", reason: `NDI sending failed and ${NDI_RECOVERY_BACKOFF_MS.length} recovery attempts did not help: ${reason}` }
      this.log("ndi.gave-up", reason)
      return
    }
    const attempt = this.recoveryAttempts
    const delay = NDI_RECOVERY_BACKOFF_MS[attempt] as number
    this.recoveryAttempts++
    this.status = { state: "error", reason: `Send failed (${reason}); retrying ${this.recoveryAttempts}/${NDI_RECOVERY_BACKOFF_MS.length} in ${Math.round(delay / 1000)} s.` }
    this.log("ndi.recovering", `attempt ${this.recoveryAttempts}: ${reason}`)
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      void this.recover(generation)
    }, delay)
    this.recoveryTimer.unref?.()
  }

  private async recover(generation: number): Promise<void> {
    if (generation !== this.generation || !this.ndi) return
    try {
      const sender = await this.ndi.send({ name: this.sourceName, clockVideo: true, clockAudio: false })
      if (generation !== this.generation) {
        await this.destroySender(sender)
        return
      }
      this.sender = sender
      this.consecutiveFailures = 0
      this.status = { state: "running" }
      this.log("ndi.recovered")
      this.schedulePump(generation)
    } catch (err) {
      if (generation !== this.generation) return
      this.log("ndi.recover-failed", err instanceof Error ? err.message : String(err))
      void this.beginRecovery(err)
    }
  }

  /** One self-rescheduling timer re-sends the latest frame so the source never goes quiet. */
  private schedulePump(generation: number): void {
    if (generation !== this.generation) return
    this.clearPump()
    const active = Date.now() - this.lastPaintAt < NDI_ACTIVE_WINDOW_MS
    const interval = Math.round(1000 / (active ? NDI_ACTIVE_FPS : NDI_IDLE_FPS))
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      void this.flush(true)
      this.schedulePump(generation)
    }, interval)
    this.pumpTimer.unref?.()
  }

  private recordSend(): void {
    const now = Date.now()
    this.sendTimes.push(now)
    while (this.sendTimes.length > FPS_SAMPLE_CAP || (this.sendTimes[0] !== undefined && now - this.sendTimes[0] > FPS_WINDOW_MS)) {
      this.sendTimes.shift()
    }
  }

  private snapshotStats(): NDIOutputStats {
    const now = Date.now()
    const recent = this.sendTimes.filter((t) => now - t <= FPS_WINDOW_MS).length
    return {
      framesSent: this.framesSent,
      framesRepeated: this.framesRepeated,
      framesSuperseded: this.framesSuperseded,
      failures: this.failures,
      width: this.frameWidth,
      height: this.frameHeight,
      fps: Math.round((recent / (FPS_WINDOW_MS / 1000)) * 10) / 10,
    }
  }

  private resetCounters(): void {
    this.framesSent = 0
    this.framesRepeated = 0
    this.framesSuperseded = 0
    this.failures = 0
    this.consecutiveFailures = 0
    this.recoveryAttempts = 0
    this.frameWidth = 0
    this.frameHeight = 0
    this.sendTimes.length = 0
    this.lastPaintAt = 0
  }

  private async destroySender(sender: NDISender): Promise<void> {
    try {
      await sender.destroy()
    } catch (err) {
      // Teardown must never throw into stop()/shutdown(): the sender is already unreachable from here.
      this.log("ndi.destroy-failed", err instanceof Error ? err.message : String(err))
    }
  }

  private clearPump(): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
  }

  private clearTimers(): void {
    this.clearPump()
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
  }
}
