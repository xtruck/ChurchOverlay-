import type { MediaCue, MediaShowPayload } from "../../../packages/contracts"

type PlaybackState = {
  state: "playing" | "paused"
  positionMs: number
  asOfServerTime: number
}

type ActiveCue = {
  readonly cue: MediaCue
  /** null for kind "image" — images have no playback concept at all. */
  playback: PlaybackState | null
}

export type MediaPlaybackControllerOptions = {
  readonly now?: () => number
}

/**
 * ARCHITECTURE.md section 60.5: the server-authoritative source of truth
 * for "what's currently on air and, for video/audio, exactly where in it."
 * No client ever computes or persists this itself (invariant 15) — every
 * operation here returns the fresh `MediaShowPayload` to broadcast, or
 * null when there was nothing to act on.
 *
 * Uses the timestamp-and-recompute model, not a running clock: "playing"
 * state records positionMs as of asOfServerTime, and the actual position
 * is only ever computed on demand (pausing, or syncing a newly-connected
 * viewer) — never ticked continuously. This is deliberately simpler than a
 * general media-sync protocol because every client is the same machine
 * (the WS server binds to 127.0.0.1 only, section 49).
 */
export class MediaPlaybackController {
  private readonly now: () => number
  private active: ActiveCue | null = null

  constructor(options: MediaPlaybackControllerOptions = {}) {
    this.now = options.now ?? Date.now
  }

  /** Activates a cue — video/audio start playing from 0; images have no playback state. */
  activate(cue: MediaCue): MediaShowPayload {
    this.active = {
      cue,
      playback: cue.kind === "image" ? null : { state: "playing", positionMs: 0, asOfServerTime: this.now() },
    }
    return this.buildPayload(this.active)
  }

  play(): MediaShowPayload | null {
    if (!this.active?.playback) return null
    this.active.playback.state = "playing"
    this.active.playback.asOfServerTime = this.now()
    return this.buildPayload(this.active)
  }

  pause(): MediaShowPayload | null {
    if (!this.active?.playback) return null
    this.active.playback.positionMs = this.computeCurrentPositionMs(this.active.playback)
    this.active.playback.state = "paused"
    this.active.playback.asOfServerTime = this.now()
    return this.buildPayload(this.active)
  }

  seek(positionMs: number): MediaShowPayload | null {
    if (!this.active?.playback) return null
    this.active.playback.positionMs = positionMs
    this.active.playback.asOfServerTime = this.now()
    return this.buildPayload(this.active)
  }

  /** Returns true if something was actually cleared (false is a no-op, nothing to broadcast). */
  clear(): boolean {
    const wasActive = this.active !== null
    this.active = null
    return wasActive
  }

  /** For a newly-connected viewer (section 60.4's reconnect sync) — recomputes position as of right now. */
  currentPayloadForSync(): MediaShowPayload | null {
    if (!this.active) return null
    if (!this.active.playback) return this.buildPayload(this.active)
    return {
      cue: this.active.cue,
      playback: {
        state: this.active.playback.state,
        positionMs: this.computeCurrentPositionMs(this.active.playback),
        asOfServerTime: this.now(),
      },
    }
  }

  private buildPayload(active: ActiveCue): MediaShowPayload {
    if (!active.playback) return { cue: active.cue }
    return { cue: active.cue, playback: { ...active.playback } }
  }

  private computeCurrentPositionMs(playback: PlaybackState): number {
    if (playback.state === "paused") return playback.positionMs
    return playback.positionMs + (this.now() - playback.asOfServerTime)
  }
}
