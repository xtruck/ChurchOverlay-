import { createRequire } from "node:module"

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

export type NDIOutputStatus = {
  state: NDIOutputState
  reason?: string
  sourceName?: string
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

export class NDIOutput {
  private sender: NDISender | null = null
  private paintSource: PaintSource | null = null
  private paintListener: PaintListener | null = null
  private frameInFlight = false
  private pendingFrame: NDIVideoFrame | null = null
  private status: NDIOutputStatus = { state: "disabled" }

  constructor(
    private readonly sourceName: string,
    private readonly ndi: NDIModule | null = loadOptionalNDI(),
    private readonly log: (event: string, error?: string) => void = () => {}
  ) {}

  getStatus(): NDIOutputStatus {
    return { ...this.status, sourceName: this.sourceName }
  }

  async start(paintSource: PaintSource): Promise<NDIOutputStatus> {
    if (this.sender) return this.getStatus()
    if (!this.ndi) {
      this.status = { state: "unavailable", reason: "NDI native module is not installed or compatible." }
      return this.getStatus()
    }

    this.status = { state: "starting" }
    try {
      this.sender = await this.ndi.send({ name: this.sourceName, clockVideo: true, clockAudio: false })
      this.paintSource = paintSource
      this.paintListener = (_event, _dirty, image) => {
        const size = image.getSize()
        if (size.width <= 0 || size.height <= 0) return
        this.pendingFrame = {
          xres: size.width,
          yres: size.height,
          frameRateN: 30,
          frameRateD: 1,
          fourCC: this.ndi?.FOURCC_BGRA,
          pictureAspectRatio: size.width / size.height,
          frameFormatType: this.ndi?.FORMAT_TYPE_PROGRESSIVE,
          lineStrideBytes: size.width * 4,
          data: image.toBitmap(),
        }
        void this.flushFrame()
      }
      paintSource.on("paint", this.paintListener)
      paintSource.setFrameRate?.(30)
      this.status = { state: "running" }
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
    if (this.paintSource && this.paintListener) this.paintSource.off("paint", this.paintListener)
    this.paintSource = null
    this.paintListener = null
    this.pendingFrame = null
    const sender = this.sender
    this.sender = null
    this.frameInFlight = false
    if (sender) await sender.destroy()
    this.status = { state: "disabled" }
  }

  private async flushFrame(): Promise<void> {
    if (this.frameInFlight || !this.sender || !this.pendingFrame) return
    const frame = this.pendingFrame
    this.pendingFrame = null
    this.frameInFlight = true
    try {
      await this.sender.video(frame)
    } catch (err) {
      this.log("ndi.frame-failed", err instanceof Error ? err.message : String(err))
    } finally {
      this.frameInFlight = false
      if (this.pendingFrame) void this.flushFrame()
    }
  }
}
