/**
 * Wall-clock watchdog for "the audio frames stopped arriving" (audit SF-08).
 *
 * Everything else about mic health (mic-health.ts, mic-diagnostics.ts) is
 * clocked by the frames that ARRIVE, so when the frames stop entirely (device
 * unplugged, capture crashed, renderer hung) nothing runs and the last "ok"
 * stays on the dashboard for ever. This is the one piece driven by a timer:
 * AppCore calls frame() for every received frame and tick() about once a
 * second; the clock is injected, so tests never sleep.
 *
 * Pure bookkeeping, no I/O and no timers of its own.
 */

/** No frame at all for this long, while the mic is meant to be on, is "no-audio". */
export const MIC_NO_AUDIO_MS = 4_000
/** How often AppCore checks. */
export const MIC_WATCHDOG_INTERVAL_MS = 1_000
/** Upper bound for a provider start()/stop() during mic:start / mic:stop (TS-11). */
export const ASR_LIFECYCLE_TIMEOUT_MS = 20_000

export type WatchdogEvent = "no-audio" | "recovered"

export class MicAudioWatchdog {
  private running = false
  private lastFrameAt = 0
  private silent = false

  constructor(private readonly timeoutMs: number = MIC_NO_AUDIO_MS) {}

  /** The mic session is live: the silence clock starts now. */
  start(now: number): void {
    this.running = true
    this.lastFrameAt = now
    this.silent = false
  }

  /** The mic session ended (on purpose or failed): nothing more to report. */
  stop(): void {
    this.running = false
    this.silent = false
  }

  /** An audio frame arrived. Returns "recovered" when it ends a no-audio episode. */
  frame(now: number): WatchdogEvent | null {
    this.lastFrameAt = now
    if (this.running && this.silent) {
      this.silent = false
      return "recovered"
    }
    return null
  }

  /** Periodic check. Returns "no-audio" once per episode, when the silence has lasted long enough. */
  tick(now: number): WatchdogEvent | null {
    if (!this.running || this.silent) return null
    if (now - this.lastFrameAt < this.timeoutMs) return null
    this.silent = true
    return "no-audio"
  }

  isSilent(): boolean {
    return this.silent
  }

  /** Milliseconds since the last frame (for log lines). */
  silentForMs(now: number): number {
    return Math.max(0, now - this.lastFrameAt)
  }
}

/**
 * Injectable timers for the parts of AppCore that must be driven by a wall
 * clock. Production passes nothing (the real ones are used); tests pass fakes.
 */
export type AppCoreTimers = {
  readonly now?: () => number
  readonly setInterval?: (callback: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
}

/**
 * Rejects when `promise` has not settled after `ms`. The underlying operation
 * keeps running (it cannot be cancelled); the caller moves on and must clean up.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, timers: AppCoreTimers = {}): Promise<T> {
  const set = timers.setTimeout ?? ((cb: () => void, delay: number) => setTimeout(cb, delay))
  const clear = timers.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  return new Promise<T>((resolve, reject) => {
    const handle = set(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)), ms)
    promise.then(
      (value) => {
        clear(handle)
        resolve(value)
      },
      (error: unknown) => {
        clear(handle)
        reject(error)
      },
    )
  })
}
